import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { createFileService } from "../../src/worker/services/file-service";
import { createSessionService, type SessionRuntime } from "../../src/worker/services/session-service";

/** 与 migrations.test.ts 相同的 SqlHandle 包装：DDL 走 exec，查询走 prepare().all()。 */
function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

function withDb(run: (sql: SqlHandle, db: DatabaseSync) => Promise<void>): () => Promise<void> {
	return async () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			await run(sql, db);
		} finally {
			db.close();
		}
	};
}

function runtime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
	return {
		entries: async () => ({ conversationId: "1", items: [] }),
		createConversation: async () => "1",
		forkBefore: async () => ({ id: "2", parentId: "1", at: 5 }),
		rootId: async () => "1",
		scanConversationIds: async () => [],
		modelFor: () => "deepseek-flash",
		pauseGoal: () => {},
		...overrides,
	};
}

describe("file-service", () => {
	it(
		"写入覆盖同名、按会话隔离、读取与删除",
		withDb(async (sql) => {
			const files = createFileService({ sql, now: () => "2026-01-01T00:00:00.000Z" });
			files.write("1", "a.md", "first");
			files.write("1", "a.md", "second");
			files.write("2", "a.md", "other");

			expect(files.read("1", "a.md")).toEqual({ name: "a.md", content: "second" });
			expect(files.read("2", "a.md")?.content).toBe("other");
			expect(files.read("1", "missing.md")).toBeUndefined();
			expect(files.list("1")).toEqual([{ name: "a.md", size: 6, updated_at: "2026-01-01T00:00:00.000Z" }]);

			files.delete("1", "a.md");
			expect(files.list("1")).toEqual([]);
			expect(files.read("2", "a.md")?.content).toBe("other");
		}),
	);

	it(
		"listAll 跨会话汇总并支持文件名/会话标题筛选",
		withDb(async (sql, db) => {
			db.exec("INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES ('2', '分支会话', 't', 't')");
			const files = createFileService({ sql, now: () => "2026-01-01T00:00:00.000Z" });
			files.write("1", "root-report.md", "r");
			files.write("2", "child-report.md", "c");

			expect(files.listAll("").map((row) => row.name).sort()).toEqual(["child-report.md", "root-report.md"]);
			expect(files.listAll("child").map((row) => row.name)).toEqual(["child-report.md"]);
			expect(files.listAll("分支").map((row) => row.sessionTitle)).toEqual(["分支会话"]);
			expect(files.listAll("child")[0]?.sessionId).toBe("2");

			files.deleteSession("2");
			expect(files.listAll("child")).toEqual([]);
		}),
	);
});

describe("session-service", () => {
	it(
		"create 落元数据，list 从存储补齐缺失会话（含根会话）",
		withDb(async (sql) => {
			const service = createSessionService({ sql, runtime: runtime({ scanConversationIds: async () => ["1", "9"] }) });
			expect(await service.create()).toEqual({ id: "1", title: "新会话" });

			const { sessions } = await service.list();
			expect(sessions.map((row) => [row.id, row.title])).toEqual([
				["1", "新会话"],
				["9", "会话 9"],
			]);

			// 二次读取不重复插入。
			expect((await service.list()).sessions).toHaveLength(2);
		}),
	);

	it(
		"list 为根会话使用「默认会话」标题",
		withDb(async (sql) => {
			const service = createSessionService({ sql, runtime: runtime({ rootId: async () => "7", scanConversationIds: async () => ["7"] }) });
			const { sessions } = await service.list();
			expect(sessions).toEqual([
				{ id: "7", title: "默认会话", created_at: expect.any(String), updated_at: expect.any(String) },
			]);
		}),
	);

	it(
		"fork 记录父子关系、分叉点、模型与标题",
		withDb(async (sql) => {
			const service = createSessionService({
				sql,
				runtime: runtime({ modelFor: () => "model-x" }),
			});
			await service.create();
			const forked = await service.fork("1", 8, "  自定义分支  ");
			expect(forked).toEqual({ id: "2", title: "自定义分支" });

			const row = sql
				.exec("SELECT id, title, model, parent_id, fork_at FROM sessions_meta WHERE id = '2'")
				.toArray() as { id: string; title: string; model: string; parent_id: string; fork_at: number }[];
			expect(row[0]).toMatchObject({ id: "2", title: "自定义分支", model: "model-x", parent_id: "1", fork_at: 5 });
		}),
	);

	it(
		"fork 缺省标题使用父会话标题前缀",
		withDb(async (sql) => {
			const service = createSessionService({ sql, runtime: runtime() });
			await service.create();
			expect((await service.fork("1", 8)).title).toBe("⑂ 新会话");
		}),
	);

	it(
		"rename 去空白并截断到 60 字符",
		withDb(async (sql) => {
			const service = createSessionService({ sql, runtime: runtime() });
			await service.create();
			service.rename("1", `  ${"x".repeat(80)}  `);
			const row = sql.exec("SELECT title FROM sessions_meta WHERE id = '1'").toArray() as { title: string }[];
			expect(row[0].title).toBe("x".repeat(60));
		}),
	);

	it(
		"remove 标记删除、清该会话文件、暂停目标，且列表不再复活",
		withDb(async (sql) => {
			const paused: string[] = [];
			const removed = createSessionService({
				sql,
				runtime: runtime({ scanConversationIds: async () => ["1"], pauseGoal: (id) => paused.push(id) }),
			});
			const files = createFileService({ sql });
			await removed.create();
			files.write("1", "keep.md", "x");

			removed.remove("1");

			expect(paused).toEqual(["1"]);
			expect(files.list("1")).toEqual([]);
			const row = sql.exec("SELECT deleted FROM sessions_meta WHERE id = '1'").toArray() as { deleted: number }[];
			expect(row[0].deleted).toBe(1);
			expect((await removed.list()).sessions).toEqual([]);
		}),
	);

	it(
		"entries 委托 Harness 端口",
		withDb(async (sql) => {
			const service = createSessionService({
				sql,
				runtime: runtime({ entries: async (sessionId) => ({ conversationId: sessionId ?? "1", items: [{ sessionId }] }) }),
			});
			expect(await service.entries("42")).toEqual([{ sessionId: "42" }]);
		}),
	);
});

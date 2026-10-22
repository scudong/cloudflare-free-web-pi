import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { getMany, removeConversation, upsert } from "../../src/worker/repo/entry-kb-refs-repo";
import { createSessionService, type SessionRuntime } from "../../src/worker/services/session-service";

/** 与其它 Service 单测相同的 SqlHandle 包装：DDL 走 exec，查询走 prepare().all()。 */
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

function runtime(items: readonly unknown[], conversationId = "1"): SessionRuntime {
	return {
		entries: async () => ({ conversationId, items }),
		createConversation: async () => "1",
		forkBefore: async () => ({ id: "2", parentId: "1", at: 5 }),
		rootId: async () => "1",
		scanConversationIds: async () => [],
		modelFor: () => "deepseek-flash",
		pauseGoal: () => {},
	};
}

const REFS = [
	{ docId: 7, chunkId: 21, chunkSeq: 0, title: "债券研究笔记", source: "notes.md" },
	{ docId: 8, chunkId: 30, chunkSeq: 2, title: "组合管理手册" },
];

const ENTRIES = [
	{ id: 1, kind: "pi.user", model: [{ role: "user" }] },
	{ id: 2, kind: "pi.assistant", model: [{ role: "assistant" }] },
	{ id: 3, kind: "pi.assistant", model: [{ role: "assistant" }] },
];

describe("session-service：entry.kbRefs（NERE-40）", () => {
	it(
		"只给写过命中的 assistant entry 合并 kbRefs，其余条目原样返回",
		withDb(async (sql) => {
			const service = createSessionService({ sql, runtime: runtime(ENTRIES) });
			// 老会话没有旁路行：结果与迁移前完全一致（不出现 kbRefs 字段）
			expect(await service.entries("1")).toEqual(ENTRIES);

			service.saveEntryKbRefs("1", 2, REFS);
			const entries = (await service.entries("1")) as Record<string, unknown>[];
			expect(entries[0]).toEqual(ENTRIES[0]);
			expect(entries[1]).toMatchObject({ id: 2, kind: "pi.assistant", kbRefs: REFS });
			expect(entries[2]).toEqual(ENTRIES[2]);
		}),
	);

	it(
		"空命中不落库；重复写同一 entry 覆盖而不是累加",
		withDb(async (sql, db) => {
			const service = createSessionService({ sql, runtime: runtime(ENTRIES) });
			service.saveEntryKbRefs("1", 2, []);
			expect(db.prepare("SELECT COUNT(*) AS n FROM entry_kb_refs").all()).toEqual([{ n: 0 }]);

			service.saveEntryKbRefs("1", 2, REFS);
			service.saveEntryKbRefs("1", 2, REFS.slice(0, 1));
			const rows = db.prepare("SELECT entry_id FROM entry_kb_refs").all();
			expect(rows).toEqual([{ entry_id: 2 }]);
			const entries = (await service.entries("1")) as Record<string, unknown>[];
			expect(entries[1]!.kbRefs).toEqual(REFS.slice(0, 1));
		}),
	);

	it(
		"按会话隔离，坏 JSON / 非法条目按无命中处理",
		withDb(async (sql, db) => {
			const other = createSessionService({ sql, runtime: runtime(ENTRIES, "2") });
			other.saveEntryKbRefs("1", 2, REFS);
			expect(await other.entries("2")).toEqual(ENTRIES);

			db.prepare("INSERT INTO entry_kb_refs (conversation_id, entry_id, refs, created_at) VALUES ('1', 3, ?, 'x')").run(
				JSON.stringify([{ docId: "bad" }, REFS[1]]),
			);
			db.prepare("UPDATE entry_kb_refs SET refs = 'not json' WHERE entry_id = 2").run();

			const entries = (await createSessionService({ sql, runtime: runtime(ENTRIES) }).entries("1")) as Record<string, unknown>[];
			expect(entries[1]).toEqual(ENTRIES[1]);
			expect(entries[2]!.kbRefs).toEqual([REFS[1]]);
		}),
	);
});

describe("entry-kb-refs-repo：批量读取（NERE-40 修复）", () => {
	it(
		"120 个 assistant id 一次读全，绑定参数不随条目数增长",
		withDb(async (sql) => {
			const refs = [REFS[0]!];
			for (let id = 1000; id < 1120; id++) upsert(sql, "1", id, refs, "2026-01-01T00:00:00.000Z");
			const ids = Array.from({ length: 120 }, (_, i) => 1000 + i);

			const found = getMany(sql, "1", ids);
			expect(found.size).toBe(120);
			expect(found.get(1000)).toEqual(refs);
			expect(found.get(1119)).toEqual(refs);

			// 稀疏页：只请求 3 个相隔很远的 id，只返回这三个（区间空洞被过滤）
			const sparse = getMany(sql, "1", [1001, 1050, 1119]);
			expect([...sparse.keys()].sort((a, b) => a - b)).toEqual([1001, 1050, 1119]);

			// 会话隔离：另一会话同 id 不串
			expect(getMany(sql, "2", [1000]).size).toBe(0);
			expect(getMany(sql, "1", []).size).toBe(0);
		}),
	);

	it(
		"删除会话时清掉该会话的旁路行",
		withDb(async (sql, db) => {
			const service = createSessionService({ sql, runtime: runtime(ENTRIES) });
			service.saveEntryKbRefs("1", 2, REFS);
			upsert(sql, "2", 9, [REFS[1]!], "2026-01-01T00:00:00.000Z");

			service.remove("1");
			expect(db.prepare("SELECT conversation_id, entry_id FROM entry_kb_refs").all()).toEqual([
				{ conversation_id: "2", entry_id: 9 },
			]);
			removeConversation(sql, "2");
			expect(db.prepare("SELECT COUNT(*) AS n FROM entry_kb_refs").all()).toEqual([{ n: 0 }]);
		}),
	);
});

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, ensureColumn, migrate, type SqlHandle } from "../../src/worker/db/migrations";

/** 按 SqlHandle 形状包一层 node:sqlite：DDL 走 db.exec，查询走 prepare().all()。 */
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

const ledgerCount = (db: DatabaseSync): number =>
	(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").all() as { n: number }[])[0].n;

const columnsOf = (db: DatabaseSync, table: string): string[] =>
	(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);

describe("migrate", () => {
	it("空库一次迁移后 sessions_meta 同时含五个补列", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const applied = migrate(sqlHandle(db));
			expect(applied).toBe(MIGRATIONS.length);
			expect(columnsOf(db, "sessions_meta")).toEqual(
				expect.arrayContaining(["deleted", "model", "hidden", "parent_id", "fork_at"]),
			);
		} finally {
			db.close();
		}
	});

	it("再次迁移返回 0，账本行数不变", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			const before = ledgerCount(db);
			expect(migrate(sql)).toBe(0);
			expect(ledgerCount(db)).toBe(before);
		} finally {
			db.close();
		}
	});

	it("账本记录全部迁移且 version 升序", () => {
		const db = new DatabaseSync(":memory:");
		try {
			migrate(sqlHandle(db));
			const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(
				(row) => row.version,
			);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
			expect(versions).toEqual([...MIGRATIONS].map((migration) => migration.version).sort((a, b) => a - b));
		} finally {
			db.close();
		}
	});

	it("旧 vfs_files 数据迁入 vfs_v2 根会话，旧表消失", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(
				"CREATE TABLE vfs_files (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)",
			);
			db.exec("INSERT INTO vfs_files (name, content, updated_at) VALUES ('a.txt', 'hello', '2026-01-01T00:00:00Z')");
			migrate(sqlHandle(db));
			expect(db.prepare("SELECT conversation_id, name, content FROM vfs_v2").all()).toEqual([
				{ conversation_id: "1", name: "a.txt", content: "hello" },
			]);
			const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vfs_files'").all();
			expect(legacy).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("ensureColumn 只吞重复列，其它错误抛出", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			// 列已存在（migrate 刚加过）→ 不抛
			expect(() => ensureColumn(sql, "sessions_meta", "model TEXT NOT NULL DEFAULT 'deepseek-flash'")).not.toThrow();
			// 表不存在 → 必须抛出，不能静默吞掉
			expect(() => ensureColumn(sql, "missing_table", "x TEXT")).toThrow(/no such table/i);
		} finally {
			db.close();
		}
	});

	it("老库补列：9 个旧表列补齐且旧行保留", () => {
		const db = new DatabaseSync(":memory:");
		try {
			// 线上老库：四张表都是补列前的形状，且没有 schema_migrations
			db.exec("CREATE TABLE sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
			db.exec("CREATE TABLE shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
			db.exec("CREATE TABLE kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL)");
			db.exec("CREATE TABLE pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)");
			db.exec("INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES ('legacy', '旧会话', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
			db.exec("INSERT INTO pi_mem (content, created_at) VALUES ('旧记忆', '2026-01-01T00:00:00Z')");

			migrate(sqlHandle(db));

			expect(columnsOf(db, "sessions_meta")).toEqual(
				expect.arrayContaining(["deleted", "model", "hidden", "parent_id", "fork_at"]),
			);
			expect(columnsOf(db, "shares")).toEqual(expect.arrayContaining(["expires_at", "theme"]));
			expect(columnsOf(db, "kb_chunks")).toContain("vectorized");
			expect(columnsOf(db, "pi_mem")).toContain("source");
			expect(db.prepare("SELECT title, deleted, model, hidden FROM sessions_meta WHERE id = 'legacy'").all()).toEqual([
				{ title: "旧会话", deleted: 0, model: "deepseek-flash", hidden: 0 },
			]);
			expect(db.prepare("SELECT content, source FROM pi_mem").all()).toEqual([{ content: "旧记忆", source: "manual" }]);
		} finally {
			db.close();
		}
	});

	it("迁移中途失败后重跑可恢复，账本不重复", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			let failed = false;
			const flaky: SqlHandle = {
				exec(query, ...bindings) {
					if (!failed && query.startsWith("ALTER TABLE sessions_meta ADD COLUMN model")) {
						failed = true;
						throw new Error("transient storage error");
					}
					return sql.exec(query, ...(bindings as never[]));
				},
			};
			// v1 跑到一半失败：账本不写，但已执行的 DDL 留在库里
			expect(() => migrate(flaky)).toThrow(/transient storage error/);
			expect(ledgerCount(db)).toBe(0);
			// 重跑：v1 幂等补齐剩余列，再写账本
			expect(migrate(sql)).toBe(MIGRATIONS.length);
			expect(columnsOf(db, "sessions_meta")).toEqual(
				expect.arrayContaining(["deleted", "model", "hidden", "parent_id", "fork_at"]),
			);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
		} finally {
			db.close();
		}
	});

	it("账本丢失后重跑全部迁移，已有数据不丢", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			db.exec("INSERT INTO app_settings (key, value) VALUES ('legacy_key', 'kept')");
			db.exec("DELETE FROM schema_migrations");

			expect(migrate(sql)).toBe(MIGRATIONS.length);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
			expect(db.prepare("SELECT value FROM app_settings WHERE key = 'legacy_key'").all()).toEqual([{ value: "kept" }]);
		} finally {
			db.close();
		}
	});

	it("v1 覆盖 kb_chunks_doc 索引与 kb_fts 虚拟表", () => {
		const db = new DatabaseSync(":memory:");
		try {
			migrate(sqlHandle(db));
			const indexes = (db.prepare("PRAGMA index_list(kb_chunks)").all() as { name: string }[]).map((row) => row.name);
			expect(indexes).toContain("kb_chunks_doc");
			db.exec("INSERT INTO kb_fts (title_tokens, body_tokens) VALUES ('migrator', 'versioned schema')");
			expect(db.prepare("SELECT rowid FROM kb_fts WHERE kb_fts MATCH 'migrator'").all()).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("v3 建立 entry_kb_refs 旁路表，老库补跑只应用一次", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entry_kb_refs'").all()).toHaveLength(1);
			const pk = (db.prepare("PRAGMA table_info(entry_kb_refs)").all() as { name: string; pk: number }[])
				.filter((column) => column.pk > 0)
				.map((column) => column.name);
			expect(pk).toEqual(["conversation_id", "entry_id"]);

			db.exec("DELETE FROM schema_migrations WHERE version = 3");
			expect(migrate(sql)).toBe(1);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
		} finally {
			db.close();
		}
	});

	it("v5 给老库 shares 补打开计数字段，旧行取默认值且重跑幂等", () => {
		const db = new DatabaseSync(":memory:");
		try {
			// 补列前的最小 shares 形状（连 expires_at/theme 都没有）
			db.exec(
				"CREATE TABLE shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
			);
			db.exec(
				"INSERT INTO shares (token, kind, session_id, name, created_at) VALUES ('old', 'file', '1', 'a.md', '2026-01-01T00:00:00Z')",
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "shares")).toEqual(
				expect.arrayContaining(["open_count", "last_opened_at", "opened_ip_hash"]),
			);
			expect(db.prepare("SELECT open_count, last_opened_at, opened_ip_hash FROM shares WHERE token = 'old'").all()).toEqual([
				{ open_count: 0, last_opened_at: 0, opened_ip_hash: "" },
			]);

			// 账本丢失 / 重跑：ensureColumn 幂等，不抛也不重复计数
			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version = 5");
			expect(migrate(sql)).toBe(1);
			expect(db.prepare("SELECT open_count FROM shares WHERE token = 'old'").all()).toEqual([{ open_count: 0 }]);
		} finally {
			db.close();
		}
	});

	it("v6/v7 给老库补技能 Hub 列与事件表，旧技能回填后仍可调用", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE TABLE skills (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)");
			db.exec(
				"INSERT INTO skills (name, description, content, created_at) VALUES ('legacy-skill', '旧技能', '# 正文', '2026-01-01T00:00:00Z')",
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "skills")).toEqual(
				expect.arrayContaining([
					"version",
					"source",
					"author",
					"license",
					"runtime",
					"tags",
					"content_hash",
					"audit_status",
					"audit_report",
					"manifest",
					"updated_at",
				]),
			);
			// 老数据回填：可调用、不被误伤
			expect(
				db
					.prepare(
						"SELECT version, source, runtime, audit_status, tags, content_hash, updated_at FROM skills WHERE name = 'legacy-skill'",
					)
					.all(),
			).toEqual([
				{
					version: "0.0.0",
					source: "local",
					runtime: "prompt",
					audit_status: "pass",
					tags: "[]",
					content_hash: "",
					updated_at: "2026-01-01T00:00:00Z",
				},
			]);
			// 审计缓存与事件表
			expect(db.prepare("PRAGMA table_info(skill_audits)").all()).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "content_hash" }), expect.objectContaining({ name: "rules_version" })]),
			);
			expect(columnsOf(db, "skill_events")).toEqual(
				expect.arrayContaining(["id", "name", "type", "source", "at", "meta"]),
			);
			// 幂等
			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version IN (6, 7)");
			expect(migrate(sql)).toBe(2);
		} finally {
			db.close();
		}
	});

	it("v8 给老库 automations 补 last_status，旧行为 NULL 且重跑幂等", () => {
		const db = new DatabaseSync(":memory:");
		try {
			// 补列前的 automations 形状
			db.exec(
				"CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)",
			);
			db.exec(
				`INSERT INTO automations (id, name, prompt, schedule, created_at, last_run_at, next_run_at) VALUES ('old', '早报', '跑', '{"kind":"daily","time":"09:00"}', '2026-01-01T00:00:00Z', 100, 200)`,
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "automations")).toEqual(expect.arrayContaining(["last_status"]));
			expect(db.prepare("SELECT last_status, last_run_at FROM automations WHERE id = 'old'").all()).toEqual([
				{ last_status: null, last_run_at: 100 },
			]);

			// 账本丢失 / 重跑：ensureColumn 幂等
			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version = 8");
			expect(migrate(sql)).toBe(1);
		} finally {
			db.close();
		}
	});

});

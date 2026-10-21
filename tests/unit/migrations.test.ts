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
});

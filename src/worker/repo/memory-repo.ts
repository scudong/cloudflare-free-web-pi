import type { SqlHandle } from "../db/migrations";

/** `pi_mem` 的类型化记录（ADR-0001 §3）：记忆库的读写入口。 */
export type MemoryRow = { id: number; content: string; created_at: string; source?: string };

/** 只读面板：最近 200 条，按写入倒序。 */
export function list(sql: SqlHandle): MemoryRow[] {
	return sql
		.exec("SELECT id, content, created_at, source FROM pi_mem ORDER BY id DESC LIMIT 200")
		.toArray() as MemoryRow[];
}

/** `recall` 工具：最近 500 条内容（打分在工具里做）。 */
export function listContents(sql: SqlHandle, limit = 500): string[] {
	return (sql.exec("SELECT content FROM pi_mem ORDER BY id DESC LIMIT ?", limit).toArray() as { content: string }[]).map(
		(row) => row.content,
	);
}

/** 去重窗口：最新 300 条内容（reflect 用）。 */
export function listRecentContents(sql: SqlHandle, limit = 300): string[] {
	return (sql.exec("SELECT content FROM pi_mem ORDER BY id DESC LIMIT ?", limit).toArray() as { content: string }[]).map(
		(row) => row.content,
	);
}

/** 备份：全量，按 id 升序。 */
export function listForBackup(sql: SqlHandle): MemoryRow[] {
	return sql.exec("SELECT id, content, created_at, source FROM pi_mem ORDER BY id").toArray() as MemoryRow[];
}

/** 工具 / 用户显式保存：`source` 走库默认值（manual）。 */
export function insert(sql: SqlHandle, content: string, createdAt: string): void {
	sql.exec("INSERT INTO pi_mem (content, created_at) VALUES (?, ?)", content, createdAt);
}

/** reflect 抽取入库：显式标记来源。 */
export function insertFromReflect(sql: SqlHandle, content: string, createdAt: string): void {
	sql.exec("INSERT INTO pi_mem (content, created_at, source) VALUES (?, ?, 'reflect')", content, createdAt);
}

/** 恢复：按内容去重（与旧 restore 一致），来源缺省 manual。 */
export function insertRestored(
	sql: SqlHandle,
	row: { content: string; createdAt: string; source: string },
): void {
	sql.exec(
		"INSERT INTO pi_mem (content, created_at, source) VALUES (?, ?, ?)",
		row.content,
		row.createdAt,
		row.source,
	);
}

export function existsByContent(sql: SqlHandle, content: string): boolean {
	return sql.exec("SELECT id FROM pi_mem WHERE content = ?", content).toArray().length > 0;
}

export function remove(sql: SqlHandle, id: number): void {
	sql.exec("DELETE FROM pi_mem WHERE id = ?", id);
}

export function count(sql: SqlHandle): number {
	const rows = sql.exec("SELECT COUNT(*) AS n FROM pi_mem").toArray() as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

export function removeAll(sql: SqlHandle): void {
	sql.exec("DELETE FROM pi_mem");
}

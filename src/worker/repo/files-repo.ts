import type { SqlHandle } from "../db/migrations";

/** `vfs_v2` 的类型化记录（ADR-0001 §3）：只返回数据，不构造 Response。 */
export type FileSummary = { name: string; size: number; updated_at: string };
export type FileContent = { name: string; content: string };
export type AllFileRow = { sessionId: string; name: string; size: number; updatedAt: string; sessionTitle: string };

export function listBySession(sql: SqlHandle, sessionId: string): FileSummary[] {
	return sql
		.exec(
			"SELECT name, length(content) AS size, updated_at FROM vfs_v2 WHERE conversation_id = ? ORDER BY updated_at DESC",
			sessionId,
		)
		.toArray() as FileSummary[];
}

export function getContent(sql: SqlHandle, sessionId: string, name: string): FileContent | undefined {
	const rows = sql
		.exec("SELECT name, content FROM vfs_v2 WHERE conversation_id = ? AND name = ?", sessionId, name)
		.toArray() as FileContent[];
	return rows[0];
}

export function write(sql: SqlHandle, sessionId: string, name: string, content: string, now: string): void {
	sql.exec(
		"INSERT INTO vfs_v2 (conversation_id, name, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
		sessionId,
		name,
		content,
		now,
	);
}

export function remove(sql: SqlHandle, sessionId: string, name: string): void {
	sql.exec("DELETE FROM vfs_v2 WHERE conversation_id = ? AND name = ?", sessionId, name);
}

/** 会话删除时清掉该会话全部文件（非级联语义，见 R10）。 */
export function removeSession(sql: SqlHandle, sessionId: string): void {
	sql.exec("DELETE FROM vfs_v2 WHERE conversation_id = ?", sessionId);
}

/** 跨会话汇总，`query` 已归一化；`%` 通配由调用方负责。 */
export function listAll(sql: SqlHandle, query: string): AllFileRow[] {
	const like = `%${query}%`;
	return sql
		.exec(
			`SELECT v.conversation_id AS sessionId, v.name AS name, length(v.content) AS size, v.updated_at AS updatedAt,
				COALESCE(s.title, '') AS sessionTitle
			FROM vfs_v2 v LEFT JOIN sessions_meta s ON s.id = v.conversation_id
			WHERE (? = '' OR lower(v.name) LIKE ? OR lower(COALESCE(s.title, '')) LIKE ?)
			ORDER BY v.updated_at DESC LIMIT 500`,
			query,
			like,
			like,
		)
		.toArray() as AllFileRow[];
}

/** 备份：全部文件正文（不含大小/标题等派生字段）。 */
export function listForBackup(
	sql: SqlHandle,
): { conversation_id: string; name: string; content: string; updated_at: string }[] {
	return sql
		.exec("SELECT conversation_id, name, content, updated_at FROM vfs_v2 ORDER BY conversation_id, name")
		.toArray() as { conversation_id: string; name: string; content: string; updated_at: string }[];
}

/** 恢复：按 (conversation_id, name) upsert。 */
export function restoreRow(
	sql: SqlHandle,
	row: { conversation_id: string; name: string; content: string; updated_at: string },
): void {
	write(sql, row.conversation_id, row.name, row.content, row.updated_at);
}

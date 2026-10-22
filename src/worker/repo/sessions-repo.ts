import type { SqlHandle } from "../db/migrations";

/** `sessions_meta` 的类型化记录（ADR-0001 §3）：只做 SQL，不做 HTTP 或权限判断。 */
export type SessionMetaRow = {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
	model?: string;
	parent_id?: string | null;
	fork_at?: number | null;
};

/** 会话列表只返回未删除、未隐藏的元数据，按更新时间倒序（与旧 listSessions 一致）。 */
export function listVisible(sql: SqlHandle): SessionMetaRow[] {
	return sql
		.exec(
			"SELECT id, title, created_at, updated_at, model, parent_id, fork_at FROM sessions_meta WHERE deleted = 0 AND hidden = 0 ORDER BY updated_at DESC",
		)
		.toArray() as SessionMetaRow[];
}

export function get(sql: SqlHandle, id: string): { id: string; title: string } | undefined {
	const rows = sql.exec("SELECT id, title FROM sessions_meta WHERE id = ?", id).toArray() as { id: string; title: string }[];
	return rows[0];
}

export function getModel(sql: SqlHandle, id: string): string | undefined {
	const rows = sql.exec("SELECT model FROM sessions_meta WHERE id = ?", id).toArray() as { model?: string }[];
	return rows[0]?.model;
}

/** 已存在的行（含 deleted/hidden）用于判定存储里补出来的 id 是否已被删除/隐藏。 */
export function listKnownIds(sql: SqlHandle): string[] {
	return (sql.exec("SELECT id FROM sessions_meta").toArray() as { id: string }[]).map((row) => row.id);
}

export function insertIfAbsent(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
		id,
		title,
		now,
		now,
	);
}

export function insertFork(
	sql: SqlHandle,
	fork: { id: string; title: string; now: string; model: string; parentId: string; forkAt: number },
): void {
	sql.exec(
		`INSERT INTO sessions_meta (id, title, created_at, updated_at, model, parent_id, fork_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET title = excluded.title, parent_id = excluded.parent_id, fork_at = excluded.fork_at, updated_at = excluded.updated_at`,
		fork.id,
		fork.title,
		fork.now,
		fork.now,
		fork.model,
		fork.parentId,
		fork.forkAt,
	);
}

export function rename(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec("UPDATE sessions_meta SET title = ?, updated_at = ? WHERE id = ?", title, now, id);
}

export function markDeleted(sql: SqlHandle, id: string, now: string): void {
	sql.exec("UPDATE sessions_meta SET deleted = 1, updated_at = ? WHERE id = ?", now, id);
}

export function setModel(sql: SqlHandle, id: string, model: string): void {
	sql.exec("UPDATE sessions_meta SET model = ? WHERE id = ?", model, id);
}

/** `POST /model`：会话行不存在时补建（旧端点行为，标题固定「新会话」）。 */
export function upsertModel(sql: SqlHandle, id: string, model: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model",
		id,
		"新会话",
		now,
		now,
		model,
	);
}

/** 子代理会话在侧栏不可见：审批闸门据此直接放行。 */
export function isHidden(sql: SqlHandle, id: string): boolean {
	try {
		const rows = sql.exec("SELECT hidden FROM sessions_meta WHERE id = ?", id).toArray() as { hidden?: number }[];
		return Number(rows[0]?.hidden ?? 0) === 1;
	} catch {
		return false;
	}
}

/** 首轮对话写入标题（行不存在时补建）：标题策略在 chat-service，仓储只做 SQL。 */
export function upsertTitle(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
		id,
		title,
		now,
		now,
	);
}

/** 已命名会话只刷新 updated_at。 */
export function touchUpdatedAt(sql: SqlHandle, id: string, now: string): void {
	sql.exec("UPDATE sessions_meta SET updated_at = ? WHERE id = ?", now, id);
}

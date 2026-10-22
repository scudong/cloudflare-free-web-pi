import type { SqlHandle } from "../db/migrations";

/** 交互式问答仓储（ADR-0001 §3）：只做 `questions` 的 SQL。 */
export type QuestionRow = { id: number; session_id: string; payload: string; status: string };
export type PendingQuestionRow = { id: number; payload: string; created_at: string };

export function listPending(sql: SqlHandle, sessionId: string): PendingQuestionRow[] {
	return sql
		.exec(
			"SELECT id, payload, created_at FROM questions WHERE session_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 5",
			sessionId,
		)
		.toArray() as PendingQuestionRow[];
}

export function latestPending(sql: SqlHandle, sessionId: string): { id: number; payload: string } | null {
	const rows = sql
		.exec(
			"SELECT id, payload FROM questions WHERE session_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
			sessionId,
		)
		.toArray() as { id: number; payload: string }[];
	return rows[0] ?? null;
}

export function get(sql: SqlHandle, id: number): QuestionRow | undefined {
	return (
		sql
			.exec("SELECT id, session_id, payload, status FROM questions WHERE id = ?", id)
			.toArray() as QuestionRow[]
	)[0];
}

export function insert(sql: SqlHandle, row: { sessionId: string; payload: string; now: string }): number | null {
	sql.exec(
		"INSERT INTO questions (session_id, payload, status, created_at) VALUES (?, ?, 'pending', ?)",
		row.sessionId,
		row.payload,
		row.now,
	);
	const rows = sql.exec("SELECT last_insert_rowid() AS id").toArray() as { id: number }[];
	return rows[0]?.id ?? null;
}

export function markAnswered(sql: SqlHandle, id: number, now: string): void {
	sql.exec("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?", now, id);
}

/** 会话删除时清掉该会话的问题（NERE-24 级联）：返回实际删除行数。 */
export function removeForSession(sql: SqlHandle, sessionId: string): number {
	return sql.exec("DELETE FROM questions WHERE session_id = ? RETURNING id", sessionId).toArray().length;
}

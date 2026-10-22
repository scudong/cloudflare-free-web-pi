import type { SqlHandle } from "../db/migrations";

/**
 * 工具审批仓储（ADR-0001 §3）：`approvals` 与 `approval_grants` 的 SQL。
 *
 * 并发语义（NERE-32 约束）：扣 `uses` 与删行仍是同一条写路径 ——
 * `consumeGrant` 一次读 `uses` 后立刻在同一函数里写回，不把读-改-写拆给调用方。
 */
export type ApprovalCategory = "read" | "write" | "exec";

export type PendingApproval = { id: number; tool: string; category: string; args: string; created_at: string };
export type ApprovalRow = { id: number; session_id: string; tool: string; status: string };

export function listPending(sql: SqlHandle, sessionId: string): PendingApproval[] {
	return sql
		.exec(
			"SELECT id, tool, category, args, created_at FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 20",
			sessionId,
		)
		.toArray() as PendingApproval[];
}

export function findPendingId(sql: SqlHandle, sessionId: string, tool: string): number | null {
	const rows = sql
		.exec(
			"SELECT id FROM approvals WHERE session_id = ? AND tool = ? AND status = 'pending' ORDER BY id DESC",
			sessionId,
			tool,
		)
		.toArray() as { id: number }[];
	return rows[0]?.id ?? null;
}

export function insertPending(
	sql: SqlHandle,
	row: { sessionId: string; tool: string; category: string; args: string; now: string },
): number | null {
	sql.exec(
		"INSERT INTO approvals (session_id, tool, category, args, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
		row.sessionId,
		row.tool,
		row.category,
		row.args,
		row.now,
	);
	const rows = sql.exec("SELECT last_insert_rowid() AS id").toArray() as { id: number }[];
	return rows[0]?.id ?? null;
}

export function get(sql: SqlHandle, id: number): ApprovalRow | undefined {
	return (
		sql.exec("SELECT id, session_id, tool, status FROM approvals WHERE id = ?", id).toArray() as ApprovalRow[]
	)[0];
}

export function markDecided(sql: SqlHandle, id: number, status: "approved" | "denied", now: string): void {
	sql.exec("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?", status, now, id);
}

/** 扣一次放行许可：返回是否放行。uses = -1 表示始终允许（不扣）。 */
export function consumeGrant(sql: SqlHandle, sessionId: string, tool: string): boolean {
	const rows = sql
		.exec("SELECT uses FROM approval_grants WHERE session_id = ? AND tool = ?", sessionId, tool)
		.toArray() as { uses: number }[];
	const row = rows[0];
	if (!row) return false;
	if (row.uses < 0) return true;
	if (row.uses <= 1) sql.exec("DELETE FROM approval_grants WHERE session_id = ? AND tool = ?", sessionId, tool);
	else sql.exec("UPDATE approval_grants SET uses = uses - 1 WHERE session_id = ? AND tool = ?", sessionId, tool);
	return true;
}

/** 批准后写入许可：always 覆盖为 -1，once 为 1（already -1 保持 -1）。 */
export function upsertGrant(sql: SqlHandle, row: { sessionId: string; tool: string; uses: number; now: string }): void {
	sql.exec(
		`INSERT INTO approval_grants (session_id, tool, uses, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id, tool) DO UPDATE SET uses = CASE WHEN approval_grants.uses < 0 THEN -1 ELSE excluded.uses END`,
		row.sessionId,
		row.tool,
		row.uses,
		row.now,
	);
}

export function deleteGrant(sql: SqlHandle, sessionId: string, tool: string): void {
	sql.exec("DELETE FROM approval_grants WHERE session_id = ? AND tool = ?", sessionId, tool);
}

/** 待审批问题是否存在（目标续转用）。 */
export function hasPendingForSession(sql: SqlHandle, sessionId: string): boolean {
	const rows = sql
		.exec("SELECT id FROM approvals WHERE session_id = ? AND status = 'pending' LIMIT 1", sessionId)
		.toArray();
	return rows.length > 0;
}

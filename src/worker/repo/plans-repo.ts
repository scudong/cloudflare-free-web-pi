import type { SqlHandle } from "../db/migrations";

/** 分步计划仓储（ADR-0001 §3）：只做 `plans` 的 SQL。 */
export type PlanStep = { title: string; status: "pending" | "in_progress" | "completed" };

export function get(sql: SqlHandle, conversationId: string): PlanStep[] {
	try {
		const rows = sql.exec("SELECT steps FROM plans WHERE conversation_id = ?", conversationId).toArray() as {
			steps: string;
		}[];
		const parsed = rows[0] ? (JSON.parse(rows[0].steps) as unknown) : [];
		return Array.isArray(parsed) ? (parsed as PlanStep[]) : [];
	} catch {
		return [];
	}
}

export function save(sql: SqlHandle, conversationId: string, steps: PlanStep[], now: string): void {
	sql.exec(
		"INSERT INTO plans (conversation_id, steps, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at",
		conversationId,
		JSON.stringify(steps),
		now,
	);
}

/** 会话删除时清掉该会话的计划（NERE-24 级联）：返回实际删除行数。 */
export function remove(sql: SqlHandle, conversationId: string): number {
	return sql.exec("DELETE FROM plans WHERE conversation_id = ? RETURNING conversation_id", conversationId).toArray().length;
}

export function listForBackup(sql: SqlHandle): Record<string, unknown>[] {
	return sql.exec("SELECT conversation_id, steps, updated_at FROM plans").toArray() as Record<string, unknown>[];
}

export function restoreRow(
	sql: SqlHandle,
	row: { conversation_id: string; steps: string; updated_at: string },
): void {
	sql.exec(
		"INSERT INTO plans (conversation_id, steps, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET steps = excluded.steps",
		row.conversation_id,
		row.steps || "[]",
		row.updated_at || new Date().toISOString(),
	);
}

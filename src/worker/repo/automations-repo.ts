import type { SqlHandle } from "../db/migrations";

/**
 * 定时任务仓储（ADR-0001 §3）：只做 `automations` 的 SQL。
 * 调度计算（下一次执行时间、忙时顺延）在 services/automation-service.ts。
 */
export type AutomationRow = {
	id: string;
	name: string;
	prompt: string;
	session_id: string;
	schedule: string;
	enabled: number;
	last_run_at: number | null;
	next_run_at: number;
};

export type AutomationDueRow = { id: string; prompt: string; session_id: string; schedule: string };

const SELECT =
	"SELECT id, name, prompt, session_id, schedule, enabled, last_run_at, next_run_at FROM automations";

export function list(sql: SqlHandle): AutomationRow[] {
	return sql.exec(`${SELECT} ORDER BY created_at DESC`).toArray() as AutomationRow[];
}

export function insert(
	sql: SqlHandle,
	row: { id: string; name: string; prompt: string; sessionId: string; schedule: string; nextRunAt: number; createdAt: string },
): void {
	sql.exec(
		"INSERT INTO automations (id, name, prompt, session_id, schedule, enabled, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
		row.id,
		row.name,
		row.prompt,
		row.sessionId,
		row.schedule,
		row.createdAt,
		row.nextRunAt,
	);
}

/** 启停：启用时把 next_run_at 推到 now+60s（旧行为），停用不动。 */
export function setEnabled(sql: SqlHandle, id: string, enabled: boolean, nextRunAt: number): void {
	const value = enabled ? 1 : 0;
	sql.exec(
		"UPDATE automations SET enabled = ?, next_run_at = CASE WHEN ? = 1 THEN ? ELSE next_run_at END WHERE id = ?",
		value,
		value,
		nextRunAt,
		id,
	);
}

export function remove(sql: SqlHandle, id: string): void {
	sql.exec("DELETE FROM automations WHERE id = ?", id);
}

/** 到点且启用的任务（alarm 第一轮）。 */
export function listDue(sql: SqlHandle, now: number): AutomationDueRow[] {
	return sql
		.exec("SELECT id, prompt, session_id, schedule FROM automations WHERE enabled = 1 AND next_run_at <= ?", now)
		.toArray() as AutomationDueRow[];
}

export function markDeferred(sql: SqlHandle, id: string, nextRunAt: number): void {
	sql.exec("UPDATE automations SET next_run_at = ? WHERE id = ?", nextRunAt, id);
}

export function markRun(sql: SqlHandle, id: string, lastRunAt: number, nextRunAt: number): void {
	sql.exec("UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?", lastRunAt, nextRunAt, id);
}

/** 全部顺延（旧逻辑：本轮处理过任务时把所有仍在过去的 next_run_at 推到 now+60s）。 */
export function rescheduleOverdue(sql: SqlHandle, now: number, nextRunAt: number): void {
	sql.exec("UPDATE automations SET next_run_at = ? WHERE enabled = 1 AND next_run_at <= ?", nextRunAt, now);
}

/** 已启用任务里最早的下一次执行时间；没有返回 null。 */
export function nextScheduledAt(sql: SqlHandle): number | null {
	const rows = sql
		.exec("SELECT MIN(next_run_at) AS next FROM automations WHERE enabled = 1 AND next_run_at > 0")
		.toArray() as { next: number | null }[];
	return typeof rows[0]?.next === "number" ? rows[0]!.next : null;
}

export function listForBackup(sql: SqlHandle): Record<string, unknown>[] {
	return sql
		.exec("SELECT id, name, prompt, session_id, schedule, enabled, next_run_at FROM automations")
		.toArray() as Record<string, unknown>[];
}

/** 恢复：按主键 upsert，保留既有 next_run_at（旧行为）。 */
export function restoreRow(
	sql: SqlHandle,
	row: { id: string; name: string; prompt: string; session_id: string; schedule: string; enabled: number; next_run_at: number },
	createdAt: string,
): void {
	sql.exec(
		"INSERT INTO automations (id, name, prompt, session_id, schedule, enabled, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, schedule = excluded.schedule, enabled = excluded.enabled",
		row.id,
		row.name,
		row.prompt,
		row.session_id,
		row.schedule,
		row.enabled,
		createdAt,
		row.next_run_at,
	);
}

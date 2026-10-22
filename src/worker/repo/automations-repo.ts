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
	last_status: string | null;
	next_run_at: number;
};

export type AutomationDueRow = { id: string; prompt: string; session_id: string; schedule: string };

/** 上次运行结果（NERE-68）：成功 / 异常 / 会话忙顺延。 */
export type AutomationLastStatus = "ok" | "failed" | "deferred";

const LAST_STATUSES: readonly AutomationLastStatus[] = ["ok", "failed", "deferred"];

/** 只透出三种已知值；老库 NULL 与脏值都按 null（前端不渲染徽标）。 */
export function parseLastStatus(raw: unknown): AutomationLastStatus | null {
	return LAST_STATUSES.includes(raw as AutomationLastStatus) ? (raw as AutomationLastStatus) : null;
}

const SELECT =
	"SELECT id, name, prompt, session_id, schedule, enabled, last_run_at, last_status, next_run_at FROM automations";

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

export function get(sql: SqlHandle, id: string): AutomationRow | null {
	const rows = sql.exec(`${SELECT} WHERE id = ?`, id).toArray() as AutomationRow[];
	return rows[0] ?? null;
}

/** 编辑（NERE-64）：只写传入的字段；`nextRunAt` 由 service 决定后一并写入。 */
export type AutomationUpdate = {
	name?: string;
	prompt?: string;
	sessionId?: string;
	schedule?: string;
	enabled?: boolean;
	nextRunAt?: number;
};

export function update(sql: SqlHandle, id: string, patch: AutomationUpdate): void {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (patch.name !== undefined) {
		sets.push("name = ?");
		values.push(patch.name);
	}
	if (patch.prompt !== undefined) {
		sets.push("prompt = ?");
		values.push(patch.prompt);
	}
	if (patch.sessionId !== undefined) {
		sets.push("session_id = ?");
		values.push(patch.sessionId);
	}
	if (patch.schedule !== undefined) {
		sets.push("schedule = ?");
		values.push(patch.schedule);
	}
	if (patch.enabled !== undefined) {
		sets.push("enabled = ?");
		values.push(patch.enabled ? 1 : 0);
	}
	if (patch.nextRunAt !== undefined) {
		sets.push("next_run_at = ?");
		values.push(patch.nextRunAt);
	}
	if (!sets.length) return;
	sql.exec(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
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

/** 会话忙：只推 next_run_at 并记 deferred，不动 last_run_at。 */
export function markDeferred(sql: SqlHandle, id: string, nextRunAt: number): void {
	sql.exec("UPDATE automations SET next_run_at = ?, last_status = 'deferred' WHERE id = ?", nextRunAt, id);
}

export function markRun(
	sql: SqlHandle,
	id: string,
	lastRunAt: number,
	nextRunAt: number,
	status: Exclude<AutomationLastStatus, "deferred">,
): void {
	sql.exec("UPDATE automations SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?", lastRunAt, status, nextRunAt, id);
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

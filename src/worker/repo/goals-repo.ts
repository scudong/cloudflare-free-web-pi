import type { SqlHandle } from "../db/migrations";

/**
 * 目标模式仓储（ADR-0001 §3）：只做 `goals` 的 SQL。
 * 预算/轮次判定、续转提示词在 services/goal-service.ts。
 */
export type GoalStatus = "active" | "done" | "blocked" | "paused" | "exhausted";

export type GoalRow = {
	session_id: string;
	objective: string;
	status: GoalStatus;
	token_budget: number;
	baseline_tokens: number;
	tokens_used: number;
	turns: number;
	max_turns: number;
	summary: string;
	next_run_at: number;
	created_at: string;
	updated_at: string;
};

export type GoalPatch = Partial<
	Pick<GoalRow, "status" | "tokens_used" | "turns" | "summary" | "next_run_at" | "baseline_tokens">
>;

const COLUMNS: Record<keyof GoalPatch, string> = {
	status: "status",
	tokens_used: "tokens_used",
	turns: "turns",
	summary: "summary",
	next_run_at: "next_run_at",
	baseline_tokens: "baseline_tokens",
};

export function get(sql: SqlHandle, sessionId: string): GoalRow | null {
	try {
		const rows = sql.exec("SELECT * FROM goals WHERE session_id = ?", sessionId).toArray() as GoalRow[];
		return rows[0] ?? null;
	} catch {
		return null;
	}
}

/** 建立（或替换）目标：baseline 是本轮之前的累计 token。 */
export function start(
	sql: SqlHandle,
	row: { sessionId: string; objective: string; tokenBudget: number; baseline: number; maxTurns: number; now: string },
): void {
	sql.exec(
		`INSERT INTO goals (session_id, objective, status, token_budget, baseline_tokens, tokens_used, turns, max_turns, summary, next_run_at, created_at, updated_at)
		 VALUES (?, ?, 'active', ?, ?, 0, 0, ?, '', 0, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET objective = excluded.objective, status = 'active', token_budget = excluded.token_budget, baseline_tokens = excluded.baseline_tokens, tokens_used = 0, turns = 0, max_turns = excluded.max_turns, summary = '', next_run_at = 0, updated_at = excluded.updated_at`,
		row.sessionId,
		row.objective,
		row.tokenBudget,
		row.baseline,
		row.maxTurns,
		row.now,
		row.now,
	);
}

export function update(sql: SqlHandle, sessionId: string, patch: GoalPatch): void {
	const sets: string[] = [];
	const args: unknown[] = [];
	for (const [key, value] of Object.entries(patch) as [keyof GoalPatch, unknown][]) {
		if (value === undefined) continue;
		sets.push(`${COLUMNS[key]} = ?`);
		args.push(value);
	}
	if (!sets.length) return;
	sets.push("updated_at = ?");
	args.push(new Date().toISOString(), sessionId);
	sql.exec(`UPDATE goals SET ${sets.join(", ")} WHERE session_id = ?`, ...args);
}

/** 到点且 active 的目标会话。 */
export function listDue(sql: SqlHandle, now: number): string[] {
	return (
		sql
			.exec("SELECT session_id FROM goals WHERE status = 'active' AND next_run_at > 0 AND next_run_at <= ?", now)
			.toArray() as { session_id: string }[]
	).map((row) => row.session_id);
}

export function nextScheduledAt(sql: SqlHandle): number | null {
	const rows = sql
		.exec("SELECT MIN(next_run_at) AS next FROM goals WHERE status = 'active' AND next_run_at > 0")
		.toArray() as { next: number | null }[];
	return typeof rows[0]?.next === "number" ? rows[0]!.next : null;
}

export function listForBackup(sql: SqlHandle): Record<string, unknown>[] {
	return sql
		.exec(
			"SELECT session_id, objective, status, token_budget, baseline_tokens, tokens_used, turns, max_turns, summary, next_run_at, created_at, updated_at FROM goals",
		)
		.toArray() as Record<string, unknown>[];
}

export function restoreRow(
	sql: SqlHandle,
	row: {
		session_id: string;
		objective: string;
		status: string;
		token_budget: number;
		baseline_tokens: number;
		tokens_used: number;
		turns: number;
		max_turns: number;
		summary: string;
		next_run_at: number;
		created_at: string;
	},
	now: string,
): void {
	sql.exec(
		`INSERT INTO goals (session_id, objective, status, token_budget, baseline_tokens, tokens_used, turns, max_turns, summary, next_run_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET objective = excluded.objective, status = excluded.status, token_budget = excluded.token_budget, baseline_tokens = excluded.baseline_tokens, tokens_used = excluded.tokens_used, turns = excluded.turns, max_turns = excluded.max_turns, summary = excluded.summary, next_run_at = excluded.next_run_at`,
		row.session_id,
		row.objective,
		row.status,
		row.token_budget,
		row.baseline_tokens,
		row.tokens_used,
		row.turns,
		row.max_turns,
		row.summary,
		row.next_run_at,
		row.created_at,
		now,
	);
}

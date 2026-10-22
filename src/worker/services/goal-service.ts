import type { SqlHandle } from "../db/migrations";
import type { GoalRuntime } from "../http/ports";
import * as goalsRepo from "../repo/goals-repo";
import type { GoalPatch, GoalRow, GoalStatus } from "../repo/goals-repo";

/**
 * 目标模式用例（ADR-0001 §2）：`/goal*` 端点与 set_goal / complete_goal / report_goal 共用。
 * alarm 的续转调度判断在 services/automation-service.ts；这里只维护目标行与提示词。
 */
export type { GoalRow, GoalStatus, GoalPatch };

export const GOAL_TOKEN_BUDGET_DEFAULT = 200_000;
export const GOAL_MAX_TURNS_DEFAULT = 12;
/** 单次请求内最多自动续转几轮；剩下的交给 alarm 跨请求接续。 */
export const GOAL_ROUNDS_PER_REQUEST = 3;

export function readGoal(sql: SqlHandle, sessionId: string): GoalRow | null {
	return goalsRepo.get(sql, sessionId);
}

/** 对外（前端 / SSE）的目标视图。 */
export type GoalView = {
	objective: string;
	status: GoalStatus;
	tokenBudget: number;
	tokensUsed: number;
	turns: number;
	maxTurns: number;
	summary?: string;
	updatedAt: string;
};

export function goalInfo(row: GoalRow | null): GoalView | null {
	if (!row) return null;
	return {
		objective: row.objective,
		status: row.status,
		tokenBudget: row.token_budget,
		tokensUsed: row.tokens_used,
		turns: row.turns,
		maxTurns: row.max_turns,
		summary: row.summary || undefined,
		updatedAt: row.updated_at,
	};
}

export function writeGoal(sql: SqlHandle, sessionId: string, patch: GoalPatch): void {
	goalsRepo.update(sql, sessionId, patch);
}

export function startGoal(
	sql: SqlHandle,
	input: { sessionId: string; objective: string; tokenBudget: number; maxTurns: number; baseline: number },
): void {
	goalsRepo.start(sql, { ...input, now: new Date().toISOString() });
}

/** instructions 里的「目标模式（进行中）」段；无进行中目标时为空串。 */
export function goalInstructionsBlock(row: GoalRow | null): string {
	if (!row || row.status !== "active") return "";
	return `\n\n## 目标模式（进行中）\n目标：${row.objective}\n进度：第 ${row.turns + 1} 轮，已用 ${row.tokens_used} / ${row.token_budget} tokens。\n- 这一轮必须有实际进展，不要只回复「继续」。\n- 全部达成后调用 complete_goal，并附可核对的证据。\n- 确实无法推进时调用 report_goal 说明阻塞原因。`;
}

/** 自动续转的提示词：强调「直接做」，避免模型空转。 */
export function goalContinuePrompt(row: GoalRow): string {
	return [
		`继续推进目标：${row.objective}`,
		"",
		`进度：已完成 ${row.turns} 轮，已用 ${row.tokens_used} / ${row.token_budget} tokens。`,
		"要求：",
		"- 先看计划和已有产出，不要重复已经做过的工作，直接做下一步。",
		"- 不要只回复「继续」之类的话，这一轮必须有实际进展。",
		"- 全部达成后调用 complete_goal，并给出可核对的验证证据。",
		"- 确实无法推进时调用 report_goal 说明阻塞原因。",
	].join("\n");
}

/** 规范化 POST /goal 的预算与轮次（旧端点口径）。 */
export function normalizeGoalLimits(tokenBudget?: number, maxTurns?: number) {
	return {
		budget: Math.max(
			10_000,
			Math.floor(Number(tokenBudget ?? GOAL_TOKEN_BUDGET_DEFAULT) || GOAL_TOKEN_BUDGET_DEFAULT),
		),
		turns: Math.min(
			50,
			Math.max(1, Math.floor(Number(maxTurns ?? GOAL_MAX_TURNS_DEFAULT) || GOAL_MAX_TURNS_DEFAULT)),
		),
	};
}

export type GoalServiceDeps = { sql: SqlHandle; runtime: GoalRuntime };

export interface GoalService {
	view(sessionId: string): GoalView | null;
	pause(sessionId: string): GoalView | null;
	create(sessionId: string, objective: string, tokenBudget?: number, maxTurns?: number): Promise<GoalView | null>;
}

export function createGoalService({ sql, runtime }: GoalServiceDeps): GoalService {
	return {
		view: (sessionId) => goalInfo(readGoal(sql, sessionId)),
		pause(sessionId) {
			writeGoal(sql, sessionId, { status: "paused", next_run_at: 0 });
			return goalInfo(readGoal(sql, sessionId));
		},
		async create(sessionId, objective, tokenBudget, maxTurns) {
			const { budget, turns } = normalizeGoalLimits(tokenBudget, maxTurns);
			const baseline = await runtime.baselineTokens(sessionId);
			startGoal(sql, { sessionId, objective, tokenBudget: budget, maxTurns: turns, baseline });
			return goalInfo(readGoal(sql, sessionId));
		},
	};
}

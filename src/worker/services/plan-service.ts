import type { SqlHandle } from "../db/migrations";
import * as plansRepo from "../repo/plans-repo";

/** 分步计划用例（ADR-0001 §2）：`update_plan` 工具与 `GET /plan` 共用。 */
export type PlanStep = plansRepo.PlanStep;

export function readPlan(sql: SqlHandle, conversationId: string): PlanStep[] {
	return plansRepo.get(sql, conversationId);
}

export function savePlan(sql: SqlHandle, conversationId: string, steps: PlanStep[]): void {
	plansRepo.save(sql, conversationId, steps, new Date().toISOString());
}

import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { createAutomationService, AutomationApiError, type AutomationPatchInput, type AutomationService } from "../services/automation-service";
import { createGoalService } from "../services/goal-service";
import { readPlan } from "../services/plan-service";

/**
 * 自动化 / 目标 / 计划路由（ADR-0001 §1）。
 * alarm 的业务判断在 automation-service；`alarm()` 仍是 DO 入口。
 */
function automations(ctx: RequestContext): AutomationService {
	return createAutomationService(ctx.sql());
}

function failure(err: unknown): Response {
	if (err instanceof AutomationApiError) return Response.json({ error: err.message }, { status: err.status });
	throw err;
}

export const automationRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/automations",
		needsHarness: false,
		handle: async (ctx) => Response.json({ automations: automations(ctx).list() }),
	},
	{
		method: "POST",
		path: "/automations",
		needsHarness: false,
		handle: async (ctx) => {
			try {
				const created = automations(ctx).create((await ctx.req.json()) as never);
				await ctx.alarmRuntime.schedule();
				return Response.json({ ok: true, ...created });
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "PATCH",
		path: "/automations",
		needsHarness: false,
		handle: async (ctx) => {
			try {
				const body = (await ctx.req.json()) as { id?: string } & AutomationPatchInput;
				const automation = automations(ctx).update(body.id ?? "", body);
				await ctx.alarmRuntime.schedule();
				return Response.json({ ok: true, automation });
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "DELETE",
		path: "/automations",
		needsHarness: false,
		handle: async (ctx) => {
			automations(ctx).remove(ctx.url.searchParams.get("id") ?? "");
			await ctx.alarmRuntime.schedule();
			return Response.json({ ok: true });
		},
	},
	{
		method: "GET",
		path: "/plan",
		needsHarness: false,
		handle: async (ctx) => Response.json({ steps: readPlan(ctx.sql(), ctx.url.searchParams.get("sessionId") ?? "1") }),
	},
	{
		method: "GET",
		path: "/goal",
		needsHarness: false,
		handle: async (ctx) => {
			const goal = createGoalService({ sql: ctx.sql(), runtime: ctx.goalRuntime });
			return Response.json({ goal: goal.view(ctx.url.searchParams.get("sessionId") ?? "1") });
		},
	},
	{
		method: "POST",
		path: "/goal",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as {
				sessionId?: string;
				objective?: string;
				tokenBudget?: number;
				maxTurns?: number;
			};
			const objective = String(body.objective ?? "").trim().slice(0, 300);
			if (!objective) return Response.json({ ok: false, error: "目标不能为空。" }, { status: 400 });
			const goal = createGoalService({ sql: ctx.sql(), runtime: ctx.goalRuntime });
			return Response.json({
				ok: true,
				goal: await goal.create(String(body.sessionId ?? "1"), objective, body.tokenBudget, body.maxTurns),
			});
		},
	},
	{
		method: "DELETE",
		path: "/goal",
		needsHarness: false,
		handle: async (ctx) => {
			const goal = createGoalService({ sql: ctx.sql(), runtime: ctx.goalRuntime });
			const paused = goal.pause(ctx.url.searchParams.get("sessionId") ?? "1");
			await ctx.alarmRuntime.schedule();
			return Response.json({ ok: true, goal: paused });
		},
	},
];

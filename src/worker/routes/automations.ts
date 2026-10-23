import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, toResponse } from "../http/errors";
import { createAutomationService, type AutomationPatchInput, type AutomationService } from "../services/automation-service";
import { createChatService } from "../services/chat-service";
import { createGoalService } from "../services/goal-service";
import { readPlan } from "../services/plan-service";

/**
 * 自动化 / 目标 / 计划路由（ADR-0001 §1）。
 * alarm 的业务判断在 automation-service；`alarm()` 仍是 DO 入口。
 */
function automations(ctx: RequestContext): AutomationService {
	return createAutomationService(ctx.sql());
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
			const created = automations(ctx).create((await ctx.req.json()) as never);
			await ctx.alarmRuntime.schedule();
			return Response.json({ ok: true, ...created });
		},
	},
	{
		method: "PATCH",
		path: "/automations",
		needsHarness: false,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as { id?: string } & AutomationPatchInput;
			const automation = automations(ctx).update(body.id ?? "", body);
			await ctx.alarmRuntime.schedule();
			return Response.json({ ok: true, automation });
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
	// 立即运行（v0.55.1）：诊断定时任务失败 / 手动补跑，不走 alarm。
	{
		method: "POST",
		path: "/automations/run",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { id?: string };
			const id = String(body.id ?? "");
			const job = automations(ctx).list().find((item) => item.id === id);
			if (!job) throw new AppError("automation_not_found", 404, "定时任务不存在");
			const chat = createChatService({ sql: ctx.sql(), runtime: ctx.chatRuntime });
			const result = await chat.chat({ message: job.prompt, sessionId: job.sessionId || undefined });
			return Response.json({ ok: true, answer: result.answer, tools: result.tools });
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
			if (!objective) return toResponse(new AppError("bad_request", 400, "目标不能为空。"), { ok: false });
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

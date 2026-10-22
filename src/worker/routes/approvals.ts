import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { toResponse } from "../http/errors";
import { decide, listPending } from "../services/approval-service";
import { answer, listPending as listQuestions, type QuestionAnswer } from "../services/question-service";

/**
 * 审批 / 问答路由（ADR-0001 §1）：失败体保留 `{ ok:false, error }`，
 * 并新增统一 `code` / `details`（NERE-79）。
 */

export const approvalRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/approvals",
		needsHarness: true,
		handle: async (ctx) =>
			Response.json({ approvals: listPending(ctx.sql(), ctx.url.searchParams.get("sessionId") ?? "1") }),
	},
	{
		method: "POST",
		path: "/approvals",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { id?: number; action?: string };
			try {
				return Response.json(decide(ctx.sql(), body.id, body.action));
			} catch (err) {
				return toResponse(err, { ok: false });
			}
		},
	},
	{
		method: "GET",
		path: "/questions",
		needsHarness: true,
		handle: async (ctx) =>
			Response.json({ questions: listQuestions(ctx.sql(), ctx.url.searchParams.get("sessionId") ?? "1") }),
	},
	{
		method: "POST",
		path: "/questions",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { id?: number; answers?: QuestionAnswer[] };
			try {
				return Response.json(answer(ctx.sql(), body.id, body.answers));
			} catch (err) {
				return toResponse(err, { ok: false });
			}
		},
	},
];

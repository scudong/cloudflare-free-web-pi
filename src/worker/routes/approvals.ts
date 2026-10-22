import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { ApprovalApiError, decide, listPending } from "../services/approval-service";
import { answer, listPending as listQuestions, QuestionApiError, type QuestionAnswer } from "../services/question-service";

/**
 * 审批 / 问答路由（ADR-0001 §1）：失败体固定 `{ ok:false, error }`（契约不动）。
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
				if (err instanceof ApprovalApiError) {
					return Response.json({ ok: false, error: err.message }, { status: err.status });
				}
				throw err;
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
				if (err instanceof QuestionApiError) {
					return Response.json({ ok: false, error: err.message }, { status: err.status });
				}
				throw err;
			}
		},
	},
];

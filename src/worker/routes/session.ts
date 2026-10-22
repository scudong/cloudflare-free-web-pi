import { createSessionService } from "../services/session-service";
import { AppError } from "../http/errors";
import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";

/** 会话域路由（ADR-0001 §1）：只做解析、校验与状态码，编排交给 session-service。 */
function service(ctx: RequestContext) {
	return createSessionService({ sql: ctx.sql(), runtime: ctx.sessionRuntime });
}

export const sessionRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => Response.json(await service(ctx).list()),
	},
	{
		method: "POST",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => Response.json(await service(ctx).create()),
	},
	{
		method: "PATCH",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => {
			const { id, title } = (await ctx.req.json()) as { id?: string; title?: string };
			if (!id || !title?.trim()) throw new AppError("bad_request", 400, "缺少 id 或标题");
			service(ctx).rename(id, title);
			return Response.json({ ok: true });
		},
	},
	{
		method: "DELETE",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => {
			const id = ctx.url.searchParams.get("id") ?? "";
			if (!id) throw new AppError("bad_request", 400, "缺少 id");
			service(ctx).remove(id);
			return Response.json({ ok: true });
		},
	},
	{
		method: "POST",
		path: "/branches",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string; entryId?: number; title?: string };
			const entryId = Math.floor(Number(body.entryId));
			if (!Number.isFinite(entryId) || entryId <= 0) {
				throw new AppError("bad_request", 400, "缺少有效的 entryId");
			}
			try {
				const created = await service(ctx).fork(String(body.sessionId ?? "1"), entryId, body.title);
				return Response.json({ ok: true, ...created });
			} catch (err) {
				// 旧行为：分叉失败一律 400，并保留「分支创建失败：」前缀与 200 字符截断。
				throw new AppError("branch_failed", 400, `分支创建失败：${String(err).slice(0, 200)}`);
			}
		},
	},
	{
		method: "GET",
		path: "/entries",
		needsHarness: true,
		handle: async (ctx) => Response.json(await service(ctx).entries(ctx.url.searchParams.get("sessionId") ?? undefined)),
	},
	{
		method: "GET",
		path: "/session",
		needsHarness: true,
		handle: async () => Response.json({ ok: true, name: "pi-harness-spike" }),
	},
];

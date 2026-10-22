import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import {
	createSettingsService,
	SettingsApiError,
	type SettingsService,
	type SettingsUpdateBody,
} from "../services/settings-service";

/**
 * 设置 / 供应商 / 模型路由（ADR-0001 §1）：只做解析与状态码。
 * `app_settings` / `providers` / `sessions_meta(model)` 的 SQL 在仓储层。
 */
function service(ctx: RequestContext): SettingsService {
	return createSettingsService({ sql: ctx.sql(), env: ctx.env, runtime: ctx.settingsRuntime });
}

/** 旧端点失败体是 `{ error }` + 400/404；其它异常继续走 toResponse。 */
function failure(err: unknown): Response {
	if (err instanceof SettingsApiError) return Response.json({ error: err.message }, { status: err.status });
	throw err;
}

export const settingsRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/settings",
		needsHarness: true,
		handle: async (ctx) => Response.json(service(ctx).view()),
	},
	{
		method: "POST",
		path: "/settings",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as SettingsUpdateBody;
			const view = await service(ctx).update(body);
			return Response.json({ ok: true, ...view });
		},
	},
	{
		method: "GET",
		path: "/providers",
		needsHarness: true,
		handle: async (ctx) => Response.json(service(ctx).listProviders()),
	},
	{
		method: "POST",
		path: "/providers",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				return Response.json(await service(ctx).saveProvider((await ctx.req.json()) as never));
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "DELETE",
		path: "/providers",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				return Response.json(await service(ctx).removeProvider(ctx.url.searchParams.get("id") ?? ""));
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "POST",
		path: "/providers/activate",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				const body = (await ctx.req.json()) as { id?: string };
				return Response.json(await service(ctx).activate(body.id));
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "GET",
		path: "/models",
		needsHarness: true,
		handle: async (ctx) => Response.json(service(ctx).models()),
	},
	{
		method: "POST",
		path: "/model",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				const body = (await ctx.req.json()) as { sessionId?: string; modelId?: string };
				service(ctx).setModel(body.sessionId, body.modelId);
				return Response.json({ ok: true, modelId: body.modelId });
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "GET",
		path: "/context",
		needsHarness: true,
		handle: async (ctx) =>
			Response.json(await ctx.contextRuntime.usage(ctx.url.searchParams.get("sessionId") ?? undefined)),
	},
];

import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { toResponse } from "../http/errors";
import { CustomToolApiError, listTools } from "../services/custom-tool-service";
import { createPromptsService } from "../services/prompts-service";

/**
 * 提示模板 / 规则文件 / 自定义工具路由（阶段 6）。
 * 校验与写入在 prompts-service，自定义工具的扩展重建通过 DO 端口完成。
 */

/** 自定义工具保留 `{ ok:false }` 兼容字段；其余错误交给 dispatch 的 toResponse。 */
function customToolFailure(err: unknown): Response {
	if (!(err instanceof CustomToolApiError)) throw err;
	return toResponse(err, { ok: false });
}

export const promptRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/prompts",
		needsHarness: true,
		handle: async (ctx) => Response.json({ prompts: createPromptsService(ctx.sql()).listPrompts() }),
	},
	{
		method: "POST",
		path: "/prompts",
		needsHarness: true,
		handle: async (ctx) => {
			createPromptsService(ctx.sql()).savePrompt((await ctx.req.json()) as never);
			return Response.json({ ok: true });
		},
	},
	{
		method: "DELETE",
		path: "/prompts",
		needsHarness: true,
		handle: async (ctx) => {
			createPromptsService(ctx.sql()).deletePrompt(ctx.url.searchParams.get("name") ?? "");
			return Response.json({ ok: true });
		},
	},
	{
		method: "GET",
		path: "/rules",
		needsHarness: true,
		handle: async (ctx) => Response.json({ rules: createPromptsService(ctx.sql()).listRules() }),
	},
	{
		method: "POST",
		path: "/rules",
		needsHarness: true,
		handle: async (ctx) => {
			createPromptsService(ctx.sql()).saveRule((await ctx.req.json()) as never);
			return Response.json({ ok: true });
		},
	},
	{
		method: "PATCH",
		path: "/rules",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as { name?: string; enabled?: boolean };
			createPromptsService(ctx.sql()).setRuleEnabled(body.name, body.enabled);
			return Response.json({ ok: true });
		},
	},
	{
		method: "DELETE",
		path: "/rules",
		needsHarness: true,
		handle: async (ctx) => {
			createPromptsService(ctx.sql()).deleteRule(ctx.url.searchParams.get("name") ?? "");
			return Response.json({ ok: true });
		},
	},
	{
		method: "GET",
		path: "/custom-tools",
		needsHarness: true,
		handle: async (ctx) => Response.json({ tools: listTools(ctx.sql()) }),
	},
	{
		method: "POST",
		path: "/custom-tools",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				const saved = ctx.customToolsRuntime.save(await ctx.req.json().catch(() => ({})));
				return Response.json({ ok: true, name: saved.name, tools: saved.tools });
			} catch (err) {
				return customToolFailure(err);
			}
		},
	},
	{
		method: "DELETE",
		path: "/custom-tools",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				const removed = ctx.customToolsRuntime.remove(ctx.url.searchParams.get("name") ?? "");
				return Response.json({ ok: true, tools: removed.tools });
			} catch (err) {
				return customToolFailure(err);
			}
		},
	},
];

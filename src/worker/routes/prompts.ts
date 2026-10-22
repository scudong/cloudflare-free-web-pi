import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { CustomToolApiError, listTools } from "../services/custom-tool-service";
import { createPromptsService, PromptsApiError } from "../services/prompts-service";

/**
 * 提示模板 / 规则文件 / 自定义工具路由（阶段 6）。
 * 校验与写入在 prompts-service，自定义工具的扩展重建通过 DO 端口完成。
 */
function failure(err: unknown): Response {
	if (err instanceof PromptsApiError) return Response.json({ error: err.message }, { status: err.status });
	if (err instanceof CustomToolApiError) return Response.json({ ok: false, error: err.message }, { status: err.status });
	throw err;
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
			try {
				createPromptsService(ctx.sql()).savePrompt((await ctx.req.json()) as never);
				return Response.json({ ok: true });
			} catch (err) {
				return failure(err);
			}
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
			try {
				createPromptsService(ctx.sql()).saveRule((await ctx.req.json()) as never);
				return Response.json({ ok: true });
			} catch (err) {
				return failure(err);
			}
		},
	},
	{
		method: "PATCH",
		path: "/rules",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				const body = (await ctx.req.json()) as { name?: string; enabled?: boolean };
				createPromptsService(ctx.sql()).setRuleEnabled(body.name, body.enabled);
				return Response.json({ ok: true });
			} catch (err) {
				return failure(err);
			}
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
				return failure(err);
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
				return failure(err);
			}
		},
	},
];

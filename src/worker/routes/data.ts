import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { createDataService } from "../services/data-service";
import { createKbService } from "../services/kb-service";
import { createMemoryService } from "../services/memory-service";

/**
 * 数据域路由（阶段 6）：备份 / 恢复 / 导出 / 记忆 / 反思。
 * `/backup`、`/restore` 的 JSON 结构与状态码逐字保持旧实现（R8 不在本阶段修）。
 */
function service(ctx: RequestContext) {
	return createDataService({
		sql: ctx.sql(),
		kb: createKbService({
			sql: ctx.sql(),
			env: ctx.env,
			scopeId: ctx.scopeId,
			settings: ctx.settings,
			webFetch: ctx.webFetch,
		}),
		runtime: ctx.dataRuntime,
		alarm: ctx.alarmRuntime,
	});
}

export const dataRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/backup",
		needsHarness: true,
		handle: async (ctx) => Response.json(service(ctx).backup()),
	},
	{
		method: "POST",
		path: "/restore",
		needsHarness: true,
		handle: async (ctx) => {
			try {
				return Response.json({ ok: true, counts: await service(ctx).restore(await ctx.req.json()) });
			} catch (err) {
				// 旧行为：恢复失败是 400 + 200 字符截断，不是 dispatch 的 500。
				return Response.json({ error: String(err).slice(0, 200) }, { status: 400 });
			}
		},
	},
	{
		method: "GET",
		path: "/export",
		needsHarness: true,
		handle: async (ctx) => {
			const data = await service(ctx).exportMarkdown(ctx.url.searchParams.get("sessionId") ?? undefined);
			if (ctx.url.searchParams.get("format") === "md") {
				return new Response(data.markdown, {
					headers: {
						"content-type": "text/markdown; charset=utf-8",
						"content-disposition": `attachment; filename="session-${data.sessionId}.md"; filename*=UTF-8''${encodeURIComponent(data.title)}.md`,
					},
				});
			}
			return Response.json(data);
		},
	},
	{
		method: "GET",
		path: "/memories",
		needsHarness: true,
		handle: async (ctx) => Response.json({ memories: createMemoryService(ctx.sql()).list() }),
	},
	{
		method: "DELETE",
		path: "/memories",
		needsHarness: true,
		handle: async (ctx) => {
			const memories = createMemoryService(ctx.sql());
			// all=1 → 一键清空（v0.26.0）
			if (ctx.url.searchParams.get("all") === "1") {
				return Response.json({ ok: true, deleted: memories.clearAll() });
			}
			memories.remove(Number(ctx.url.searchParams.get("id") ?? 0));
			return Response.json({ ok: true });
		},
	},
	{
		method: "POST",
		path: "/reflect",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string };
			return Response.json(await service(ctx).reflect(body.sessionId));
		},
	},
];

import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, toResponse } from "../http/errors";
import { createSkillService, SkillApiError, type SkillService } from "../services/skill-service";

/**
 * 技能域路由（NERE-55，契约 §5）：只做参数解析与状态码；
 * 目录合并、审计、入库、埋点都在 `services/skill-service.ts`，routes 零 SQL。
 */

function service(ctx: RequestContext): SkillService {
	return createSkillService({ sql: ctx.sql(), settings: ctx.settings });
}

/** 导入保留 `ok` / `installed` 兼容字段（一个版本）；统一字段由 toResponse 输出（NERE-79）。 */
function importFailure(err: unknown): Response {
	if (!(err instanceof SkillApiError)) return toResponse(err);
	return toResponse(err, { ok: false, installed: false });
}

/** `/skills/<name>/audit` 是唯一带路径参数的路由；name 由路由表断言过形状。 */
function pathName(ctx: RequestContext): string {
	return decodeURIComponent(ctx.url.pathname.split("/")[2] ?? "");
}

export const skillRoutes: readonly Route[] = [
	// 市场列表：零抓取（目录快照 + 已安装行），含 installed 状态，禁止 CDN 缓存。
	{
		method: "GET",
		path: "/skills/hub",
		needsHarness: false,
		handle: async (ctx) => {
			const params = ctx.url.searchParams;
			const result = await service(ctx).hub({
				q: params.get("q"),
				runtime: params.get("runtime"),
				tag: params.get("tag"),
				audit: params.get("audit"),
				source: params.get("source"),
				origin: params.get("origin"),
				installed: params.get("installed"),
				sort: params.get("sort"),
				limit: params.get("limit"),
				offset: params.get("offset"),
			});
			return Response.json(result, { headers: { "cache-control": "private, max-age=30" } });
		},
	},
	// 旧社区入口收口（追加范围 C）：8 条固定 blocked，不再裸写库。
	{
		method: "GET",
		path: "/skills/community",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).community()),
	},
	// 导入：URL 或 manifest+content，先审计再入库；blocked → 422 且不写库。
	{
		method: "POST",
		path: "/skills/import",
		needsHarness: false,
		handle: async (ctx) => {
			try {
				const body = await ctx.req.json().catch(() => null);
				return Response.json(await service(ctx).importSkill(body));
			} catch (err) {
				return importFailure(err);
			}
		},
	},
	// 单技能审计：已安装本地重审计，仅目录存在时返回目录快照。
	{
		method: "GET",
		path: "/skills/:name/audit",
		needsHarness: false,
		handle: async (ctx) =>
			Response.json(await service(ctx).auditFor(pathName(ctx)), { headers: { "cache-control": "no-store" } }),
	},
	// 既有 CRUD 兼容（契约 §5.5）：字段只增不改。
	{
		method: "GET",
		path: "/skills",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).listCompat()),
	},
	{
		method: "POST",
		path: "/skills",
		needsHarness: false,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { name?: unknown; description?: unknown; content?: unknown };
			const name = String(body.name ?? "").trim().slice(0, 40);
			const content = String(body.content ?? "").trim();
			if (!name || !content) throw new AppError("bad_request", 400, "需要名称与内容");
			await service(ctx).addManual({ name, description: String(body.description ?? "").trim().slice(0, 120), content });
			return Response.json({ ok: true });
		},
	},
	{
		method: "DELETE",
		path: "/skills",
		needsHarness: false,
		handle: async (ctx) => {
			service(ctx).remove(ctx.url.searchParams.get("name") ?? "");
			return Response.json({ ok: true });
		},
	},
	// 技能域指标（追加范围 A / NERE-59）：与分享计数完全独立。
	{
		method: "GET",
		path: "/metrics/skill-hub",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).metrics(ctx.url.searchParams.get("days"))),
	},
];

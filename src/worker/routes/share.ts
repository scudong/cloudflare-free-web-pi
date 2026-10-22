import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { demoShareToken } from "../lib/share-render";
import { createShareService } from "../services/share-service";

/** 分享域路由（ADR-0001 §1）：只做解析与状态码；渲染/落库在 share-service。 */
function service(ctx: RequestContext) {
	return createShareService({
		sql: ctx.sql(),
		settings: ctx.settings,
		runtime: ctx.shareRuntime,
		origin: ctx.origin,
		userKey: ctx.userKey,
		demoToken: demoShareToken(ctx.env.DEMO_SHARE_URL),
	});
}

export const shareRoutes: readonly Route[] = [
	{
		method: "POST",
		path: "/share",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as {
				sessionId?: string;
				kind?: "conversation" | "file";
				name?: string;
				ttlSeconds?: number;
				theme?: string;
			};
			try {
				const share = service(ctx);
				const { token, expiresAt } = await share.create({
					sessionId: body.sessionId,
					kind: body.kind === "file" ? "file" : "conversation",
					name: body.name,
					ttlSeconds: body.ttlSeconds,
					theme: body.theme,
				});
				// 用请求自身的域名拼绝对地址：页面在哪个域名打开，链接就指向哪里
				return Response.json({ ok: true, token, url: share.urlFor(token), expiresAt });
			} catch (err) {
				return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
			}
		},
	},
	{
		method: "GET",
		path: "/shares",
		needsHarness: true,
		handle: async (ctx) => {
			const kind = ctx.url.searchParams.get("kind") === "file" ? "file" : "conversation";
			const name = ctx.url.searchParams.get("name") ?? undefined;
			if (kind === "file" && !name?.trim()) {
				return Response.json({ error: "缺少文件名" }, { status: 400 });
			}
			const share = service(ctx);
			const shares = (await share.list(ctx.url.searchParams.get("sessionId") ?? undefined, kind, name)).map(
				(record) => ({ ...record, url: share.urlFor(record.token) }),
			);
			return Response.json({ shares });
		},
	},
	{
		method: "GET",
		path: "/s/",
		needsHarness: false,
		handle: async (ctx) => {
			const page = await service(ctx).render(ctx.url.pathname.slice(3), ctx.url.searchParams.get("theme"));
			if (!page) {
				return new Response("分享链接不存在或已失效", {
					status: 404,
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}
			return new Response(page.body, {
				status: page.status,
				headers: {
					"content-type": page.contentType,
					"cache-control": "no-store",
					"x-robots-tag": "noindex, nofollow",
					"referrer-policy": "no-referrer",
					"x-content-type-options": "nosniff",
					...page.headers,
				},
			});
		},
	},
];

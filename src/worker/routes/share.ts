import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, errorText } from "../http/errors";
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

/** 打开来源：Cloudflare 优先，其次反代 XFF 的第一跳；都没有时留下空串（仍按同一指纹去重）。 */
function clientIp(req: Request): string {
	const cloudflare = req.headers.get("cf-connecting-ip")?.trim();
	if (cloudflare) return cloudflare;
	return (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
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
				throw new AppError("share_failed", 400, errorText(err));
			}
		},
	},
	{
		// NERE-42：全量清单（active|expired|all，缺省 active）；不读会话，不启动 Harness。
		method: "GET",
		path: "/shares/all",
		needsHarness: false,
		handle: async (ctx) => {
			const shares = service(ctx).listAll(ctx.url.searchParams.get("status"));
			return Response.json({ shares });
		},
	},
	{
		method: "GET",
		path: "/shares",
		needsHarness: true,
		handle: async (ctx) => {
			const kind = ctx.url.searchParams.get("kind") === "file" ? "file" : "conversation";
			const name = ctx.url.searchParams.get("name") ?? undefined;
			if (kind === "file" && !name?.trim()) throw new AppError("bad_request", 400, "缺少文件名");
			const share = service(ctx);
			const shares = (await share.list(ctx.url.searchParams.get("sessionId") ?? undefined, kind, name)).map(
				(record) => ({ ...record, url: share.urlFor(record.token) }),
			);
			return Response.json({ shares });
		},
	},
	{
		// NERE-42：撤销（立即失效）。404 = 本用户库里不存在；403 = token 前缀属于其他用户。
		method: "DELETE",
		path: "/shares/",
		needsHarness: false,
		handle: async (ctx) => {
			const raw = ctx.url.pathname.slice("/shares/".length);
			let token = raw;
			try {
				token = decodeURIComponent(raw);
			} catch {
				// 非法百分号编码按原样处理，最终落到 404
			}
			service(ctx).revoke(token);
			return Response.json({ ok: true });
		},
	},
	{
		method: "GET",
		path: "/s/",
		needsHarness: false,
		handle: async (ctx) => {
			const page = await service(ctx).render(
				ctx.url.pathname.slice(3),
				ctx.url.searchParams.get("theme"),
				clientIp(ctx.req),
			);
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

import { AppError } from "../http/errors";
import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { createKbService, KbIngestError, KB_VECTOR_BATCH, type KbService } from "../services/kb-service";

/** 知识库路由（ADR-0001 §1）：解析与状态码，编排在 kb-service，SQL 在 kb-repo。 */
function service(ctx: RequestContext): KbService {
	return createKbService({
		sql: ctx.sql(),
		env: ctx.env,
		scopeId: ctx.scopeId,
		settings: ctx.settings,
		webFetch: ctx.webFetch,
	});
}

/** ingest 的失败体是 `{ ok:false, code, message }`（契约固定），不是 AppError 的 `{ error }`。 */
function ingestFailure(err: unknown): Response {
	if (err instanceof KbIngestError) {
		return Response.json({ ok: false, code: err.code, message: err.message }, { status: err.status });
	}
	throw err;
}

export const kbRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/kb",
		needsHarness: false,
		handle: async (ctx) => Response.json({ docs: service(ctx).listDocs() }),
	},
	{
		method: "POST",
		path: "/kb",
		needsHarness: false,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as {
				title?: string;
				content?: string;
				source?: string;
				tags?: string;
			};
			const title = String(body.title ?? "").trim().slice(0, 120);
			const content = String(body.content ?? "").trim();
			if (!title || !content) throw new AppError("bad_request", 400, "标题和正文都不能为空");
			const result = await service(ctx).addIndexed({
				title,
				content,
				source: String(body.source ?? "").trim().slice(0, 300),
				tags: String(body.tags ?? "").trim().slice(0, 120),
			});
			return Response.json({ ok: true, ...result });
		},
	},
	// 知识库导入（v0.56.0）：multipart 文件或 JSON {url}
	{
		method: "POST",
		path: "/kb/ingest",
		needsHarness: false,
		handle: async (ctx) => {
			const contentType = (ctx.req.headers.get("content-type") ?? "").toLowerCase();
			try {
				if (contentType.includes("application/json")) {
					const body = (await ctx.req.json().catch(() => null)) as { url?: unknown } | null;
					return Response.json(await service(ctx).ingestUrl(body?.url));
				}
				if (!contentType.includes("multipart/form-data")) {
					throw new KbIngestError(415, "unsupported_type", "请用 multipart/form-data 上传文件，或用 application/json 传 {url}。");
				}
				let form: FormData;
				try {
					form = await ctx.req.formData();
				} catch {
					throw new KbIngestError(415, "unsupported_type", "上传内容不是有效的 multipart/form-data。");
				}
				return Response.json(await service(ctx).ingestFile(form.get("file")));
			} catch (err) {
				return ingestFailure(err);
			}
		},
	},
	{
		method: "GET",
		path: "/kb/doc",
		needsHarness: false,
		handle: async (ctx) => {
			const id = Number(ctx.url.searchParams.get("id") ?? 0);
			const doc = service(ctx).getDoc(id);
			if (!doc) throw new AppError("not_found", 404, "文档不存在");
			return Response.json(doc);
		},
	},
	{
		method: "GET",
		path: "/kb/search",
		needsHarness: false,
		handle: async (ctx) => {
			const q = ctx.url.searchParams.get("q") ?? "";
			if (!q.trim()) return Response.json({ hits: [] });
			return Response.json({ hits: await service(ctx).searchAsync(q, Number(ctx.url.searchParams.get("limit") ?? 8)) });
		},
	},
	// 预检索预览（v0.46.0）：返回本轮会注入 instructions 的原文，便于排查
	{
		method: "GET",
		path: "/kb/prefetch",
		needsHarness: false,
		handle: async (ctx) => Response.json(await service(ctx).prefetchPreview(ctx.url.searchParams.get("q") ?? "")),
	},
	{
		method: "DELETE",
		path: "/kb",
		needsHarness: false,
		handle: async (ctx) => {
			const id = Number(ctx.url.searchParams.get("id") ?? 0);
			if (!id) throw new AppError("bad_request", 400, "缺少文档 id");
			return Response.json({ ok: await service(ctx).remove(id) });
		},
	},
	{
		method: "GET",
		path: "/kb/status",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).status()),
	},
	{
		method: "POST",
		path: "/kb/reindex",
		needsHarness: false,
		handle: async (ctx) => {
			const kb = service(ctx);
			if (!kb.vectorAvailable()) {
				throw new AppError("vector_unavailable", 400, "向量检索未启用（缺少 AI / KB_VEC 绑定）");
			}
			try {
				const result = await kb.reindex(Number(ctx.url.searchParams.get("limit") ?? KB_VECTOR_BATCH));
				return Response.json({ ok: true, ...result });
			} catch (err) {
				throw new AppError("reindex_failed", 500, String(err).slice(0, 200));
			}
		},
	},
];

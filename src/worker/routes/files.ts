import { createFileService } from "../services/file-service";
import { AppError } from "../http/errors";
import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";

/** 文件域路由（ADR-0001 §1）：只读/删除 vfs_v2，不做 SQL。 */
function service(ctx: RequestContext) {
	return createFileService({ sql: ctx.sql() });
}

export const fileRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/files",
		needsHarness: false,
		handle: async (ctx) => {
			const sessionId = ctx.url.searchParams.get("sessionId") ?? "1";
			return Response.json({ files: service(ctx).list(sessionId) });
		},
	},
	{
		method: "GET",
		path: "/files/content",
		needsHarness: false,
		handle: async (ctx) => {
			const name = ctx.url.searchParams.get("name") ?? "";
			const sessionId = ctx.url.searchParams.get("sessionId") ?? "1";
			const file = service(ctx).read(sessionId, name);
			if (!file) throw new AppError("not_found", 404, "文件不存在");
			return Response.json(file);
		},
	},
	{
		method: "DELETE",
		path: "/files",
		needsHarness: false,
		handle: async (ctx) => {
			const sessionId = ctx.url.searchParams.get("sessionId") ?? "1";
			service(ctx).delete(sessionId, ctx.url.searchParams.get("name") ?? "");
			return Response.json({ ok: true });
		},
	},
	{
		method: "GET",
		path: "/files/all",
		needsHarness: false,
		handle: async (ctx) => Response.json({ files: service(ctx).listAll(ctx.url.searchParams.get("q") ?? "") }),
	},
];

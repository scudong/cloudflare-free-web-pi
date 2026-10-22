import { AppError } from "../http/errors";
import type { Route } from "../http/router";
import { readBootstrap } from "../services/bootstrap-service";
import { kernelInfo } from "../services/kernel-service";

/**
 * 系统域路由（阶段 6）：版本、首屏聚合、注册表调试、内核版本。
 * 只做解析与状态码；聚合与版本判断在 Service，注册表快照由 DO 端口提供。
 */
export const systemRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/version",
		needsHarness: true,
		// 旧 `/version` 在任何路径下都不碰 SQL：构建号来自 env。
		handle: async (ctx) => Response.json({ build: ctx.env.BUILD ?? "dev", images: true, search: true }),
	},
	{
		method: "GET",
		path: "/bootstrap",
		needsHarness: true,
		handle: async (ctx) => {
			const raw = (ctx.url.searchParams.get("sessionId") ?? "").trim();
			const sessionId = raw || "1";
			// 会话 id 由 Harness 以正整数分配；非法值直接 400，避免落到根会话造成误读。
			if (!/^[1-9]\d{0,15}$/.test(sessionId)) {
				throw new AppError("bad_request", 400, "sessionId 必须是正整数");
			}
			return Response.json(
				await readBootstrap(
					{ sql: ctx.sql(), settings: ctx.settings, env: ctx.env, sessionRuntime: ctx.sessionRuntime },
					sessionId,
				),
			);
		},
	},
	{
		method: "GET",
		path: "/debug/agent",
		needsHarness: true,
		handle: async (ctx) =>
			Response.json(
				await ctx.debugRuntime.inspect({
					message: ctx.url.searchParams.get("message"),
					sessionId: ctx.url.searchParams.get("sessionId") ?? "1",
				}),
			),
	},
	{
		method: "GET",
		path: "/kernel",
		needsHarness: true,
		handle: async (ctx) =>
			Response.json(
				await kernelInfo({
					settings: { get: (key, fallback) => ctx.settings.get(key, fallback), set: (key, value) => ctx.setSetting(key, value) },
					refresh: ctx.url.searchParams.get("refresh") === "1",
				}),
			),
	},
];

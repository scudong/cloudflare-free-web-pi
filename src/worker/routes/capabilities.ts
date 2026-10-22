import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, errorText } from "../http/errors";
import { capabilities } from "../services/capability-service";
import { listServers, removeServer, saveServer, type SavedMcpServer } from "../services/mcp-service";
import { approvalSettings, toolCategory, toolPolicy } from "../services/approval-service";
import { settingsView } from "../services/settings-service";

/**
 * 能力 / 工具 / MCP 路由（ADR-0001 §1）：`/tools` 的已安装工具名来自 DO 端口，
 * 计数走仓储，策略解析与设置页共用同一实现。
 */
function view(ctx: RequestContext) {
	return settingsView((key, fallback) => ctx.settings.get(key, fallback), ctx.env);
}

export const capabilityRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/capabilities",
		needsHarness: false,
		handle: async (ctx) => Response.json(capabilities({ sql: ctx.sql(), settings: view(ctx) })),
	},
	{
		method: "GET",
		path: "/tools",
		needsHarness: true,
		handle: async (ctx) => {
			const get = (key: string, fallback: string) => ctx.settings.get(key, fallback);
			const custom = new Set(ctx.toolRuntime.customNames());
			const names = [...ctx.toolRuntime.names()].sort();
			return Response.json({
				approval: approvalSettings(get),
				tools: names.map((name) => ({
					name,
					category: toolCategory(name, custom),
					policy: toolPolicy(get, name, custom),
					override: get(`approval_tool_${name}`, "follow"),
				})),
			});
		},
	},
	{
		method: "GET",
		path: "/mcp",
		needsHarness: false,
		handle: async (ctx) => Response.json({ servers: listServers(ctx.sql()) }),
	},
	{
		method: "POST",
		path: "/mcp",
		needsHarness: true,
		handle: async (ctx) => {
			let saved: SavedMcpServer;
			try {
				saved = saveServer(ctx.sql(), (await ctx.req.json()) as never);
			} catch (err) {
				throw new AppError("invalid_mcp_server", 400, errorText(err));
			}
			const tools = await ctx.mcpRuntime.rebuild();
			return Response.json({ ok: true, id: saved.id, tools });
		},
	},
	{
		method: "DELETE",
		path: "/mcp",
		needsHarness: true,
		handle: async (ctx) => {
			removeServer(ctx.sql(), ctx.url.searchParams.get("id") ?? "");
			const tools = await ctx.mcpRuntime.rebuild();
			return Response.json({ ok: true, tools });
		},
	},
];

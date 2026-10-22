import type { RequestContext } from "../http/context";
import { toResponse } from "../http/errors";
import { matchRoute, type Route } from "../http/router";
import { approvalRoutes } from "./approvals";
import { automationRoutes } from "./automations";
import { capabilityRoutes } from "./capabilities";
import { fileRoutes } from "./files";
import { kbRoutes } from "./kb";
import { sessionRoutes } from "./session";
import { settingsRoutes } from "./settings";
import { shareRoutes } from "./share";
import { skillRoutes } from "./skills";

/**
 * 路由表（ADR-0001 §9.1）：已迁移的域在这里登记，未登记的端点继续走 legacy 委托。
 * 阶段 1：会话与文件域。阶段 2：知识库域。阶段 3：分享域（/s/ 不启 Harness）。
 * 阶段 4：技能域（NERE-55，hub 需排在 `/skills` 之前）；设置/自动化/审批/能力域（NERE-32）。
 */
export const ROUTES: readonly Route[] = [
	...sessionRoutes,
	...fileRoutes,
	...kbRoutes,
	...shareRoutes,
	...skillRoutes,
	// 阶段 4（NERE-32）：设置/供应商/模型、自动化/目标/计划、审批/问答、能力/工具/MCP。
	...settingsRoutes,
	...automationRoutes,
	...approvalRoutes,
	...capabilityRoutes,
];

export async function dispatch(ctx: RequestContext, routes: readonly Route[] = ROUTES): Promise<Response> {
	const route = matchRoute(routes, ctx.req.method, ctx.url.pathname);
	if (!route) return ctx.legacy();
	try {
		await ctx.ready();
		if (route.needsHarness) await ctx.harness();
		return await route.handle(ctx);
	} catch (err) {
		// AppError 走 §9.3 映射；未知异常仍是 500 + String(e).slice(0, 500)。
		return toResponse(err);
	}
}

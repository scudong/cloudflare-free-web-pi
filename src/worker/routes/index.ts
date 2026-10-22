import type { RequestContext } from "../http/context";
import { AppError, toResponse } from "../http/errors";
import { matchRoute, type Route } from "../http/router";
import { approvalRoutes } from "./approvals";
import { automationRoutes } from "./automations";
import { capabilityRoutes } from "./capabilities";
import { dataRoutes } from "./data";
import { chatRoutes } from "./chat";
import { fileRoutes } from "./files";
import { kbRoutes } from "./kb";
import { promptRoutes } from "./prompts";
import { sessionRoutes } from "./session";
import { settingsRoutes } from "./settings";
import { shareRoutes } from "./share";
import { skillRoutes } from "./skills";
import { systemRoutes } from "./system";

/**
 * 路由表（ADR-0001 §9.1）：所有端点都在这里登记（阶段 6 起没有 legacy 兜底）。
 * 阶段 1：会话与文件域。阶段 2：知识库域。阶段 3：分享域（/s/ 不启 Harness）。
 * 阶段 4：技能域（NERE-55，hub 需排在 `/skills` 之前）；设置/自动化/审批/能力域（NERE-32）。
 * 阶段 5：对话域（NERE-33），`/chat` 与 `/chat/stream` 共用 chat-service。
 * 阶段 6（NERE-34）：系统/数据/提示模板域；`handleLegacyFetch` 全部删除，未命中直接 404。
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
	// 阶段 5（NERE-33）：对话 / 插话 / 中止 / 重置 / 压缩。
	...chatRoutes,
	// 阶段 6（NERE-34）：系统、数据、提示模板 / 规则 / 自定义工具。
	...systemRoutes,
	...dataRoutes,
	...promptRoutes,
];

export async function dispatch(ctx: RequestContext, routes: readonly Route[] = ROUTES): Promise<Response> {
	const route = matchRoute(routes, ctx.req.method, ctx.url.pathname);
	// 阶段 6：没有 legacy 兜底；未知路径不触发迁移/ Harness，错误体统一经 toResponse。
	if (!route) return toResponse(new AppError("not_found", 404, "not found"));
	try {
		await ctx.ready();
		if (route.needsHarness) await ctx.harness();
		return await route.handle(ctx);
	} catch (err) {
		// AppError 走 §9.3 映射；未知异常仍是 500 + String(e).slice(0, 500)。
		return toResponse(err);
	}
}

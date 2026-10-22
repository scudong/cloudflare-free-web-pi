import type { RequestContext } from "../http/context";
import { matchRoute, type Route } from "../http/router";

/**
 * 路由表（ADR-0001 §9.1）：阶段 0b 不迁移业务域，各域在阶段 1-5 追加。
 * 未迁移端点不在这里登记，dispatch 直接走 legacy 委托，行为与旧 handleFetch 相同。
 */
export const ROUTES: readonly Route[] = [];

export async function dispatch(ctx: RequestContext, routes: readonly Route[] = ROUTES): Promise<Response> {
	const route = matchRoute(routes, ctx.req.method, ctx.url.pathname);
	if (!route) return ctx.legacy();
	await ctx.ready();
	if (route.needsHarness) await ctx.harness();
	return route.handle(ctx);
}

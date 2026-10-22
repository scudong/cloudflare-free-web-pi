import type { RequestContext } from "./context";

export type Route = {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	/** DO 内部短路径，如 "/sessions"；"/s/" 作为前缀匹配（阶段 3 分享页）。 */
	path: string;
	needsHarness: boolean;
	handle(ctx: RequestContext): Promise<Response>;
};

/** 以 "/" 结尾的路由是前缀路由：`/s/<token>`、`/shares/<token>`；历史 `/s` 同等对待。 */
function pathMatches(routePath: string, pathname: string): boolean {
	if (routePath === pathname) return true;
	if (routePath === "/s") return pathname.startsWith("/s/");
	if (routePath.endsWith("/") && pathname.startsWith(routePath)) return true;
	return false;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): Route | null {
	for (const route of routes) {
		if (route.method === method && pathMatches(route.path, pathname)) return route;
	}
	return null;
}

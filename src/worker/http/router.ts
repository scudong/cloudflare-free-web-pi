import type { RequestContext } from "./context";

export type Route = {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	/** DO 内部短路径，如 "/sessions"；"/s/" 作为前缀匹配（阶段 3 分享页）。 */
	path: string;
	needsHarness: boolean;
	handle(ctx: RequestContext): Promise<Response>;
};

/** "/s/" 是前缀路由：/s/<token>、/s/<token>/<file> 都归分享域。 */
function pathMatches(routePath: string, pathname: string): boolean {
	if (routePath === pathname) return true;
	if (routePath === "/s" || routePath === "/s/") return pathname.startsWith("/s/");
	return false;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): Route | null {
	for (const route of routes) {
		if (route.method === method && pathMatches(route.path, pathname)) return route;
	}
	return null;
}

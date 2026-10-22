import type { Harness } from "@earendil-works/pi-durable";
import type { SqlHandle } from "../db/migrations";

/** Worker 绑定（ADR-0001 §9.2）；只在 Http 层按需读取，不落库。 */
export type AppEnv = {
	DEEPSEEK_API_KEY?: string;
	ACCESS_PASSWORD?: string;
	AI?: unknown;
	KB_VEC?: unknown;
	CF_DISABLE_VECTOR?: string;
	DEEPSEEK_BASE_URL?: string;
	BUILD?: string;
	SpikeAgent: DurableObjectNamespace;
	UserRegistry: DurableObjectNamespace;
};

/** 一次请求的显式依赖：Route/Service 不再读模块级 agentScope。 */
export type RequestContext = {
	readonly req: Request;
	readonly url: URL;
	readonly env: AppEnv;
	readonly scopeId: string;
	readonly userKey: string;
	readonly origin: string;
	/** 已执行迁移的 SQL 句柄；migrate 由 ready() 保证先跑完。 */
	sql(): SqlHandle;
	/** 触发一次（幂等的）迁移；dispatch 在调用 handler 前 await。 */
	ready(): Promise<void>;
	/** 惰性 open()；只有 needsHarness 的路由调用。 */
	harness(): Promise<Harness>;
	/** 阶段 0-4 的过渡委托：未迁移端点原样走旧 handleFetch。 */
	legacy(): Promise<Response>;
};

export type BuildContextInput = {
	req: Request;
	env: AppEnv;
	scopeId: string;
	userKey: string;
	origin: string;
	sql: SqlHandle;
	ensureMigrated(): Promise<void>;
	open(): Promise<Harness>;
	legacy(): Promise<Response>;
};

export function buildContext(input: BuildContextInput): RequestContext {
	return {
		req: input.req,
		url: new URL(input.req.url),
		env: input.env,
		scopeId: input.scopeId,
		userKey: input.userKey,
		origin: input.origin,
		sql: () => input.sql,
		ready: () => input.ensureMigrated(),
		harness: () => input.open(),
		legacy: () => input.legacy(),
	};
}

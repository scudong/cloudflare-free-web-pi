import type { Harness } from "@earendil-works/pi-durable";
import type { SqlHandle } from "../db/migrations";
import type { KbSettings, WebFetchResult } from "../services/kb-service";
import type { SessionRuntime } from "../services/session-service";
import type {
	AlarmRuntime,
	ContextRuntime,
	GoalRuntime,
	McpRuntime,
	SettingsRuntime,
	ShareRuntime,
	ToolRuntime,
} from "./ports";

/** Worker 绑定（ADR-0001 §9.2）；只在 Http 层按需读取，不落库。 */
export type AppEnv = {
	DEEPSEEK_API_KEY?: string;
	ACCESS_PASSWORD?: string;
	AI?: unknown;
	KB_VEC?: unknown;
	CF_DISABLE_VECTOR?: string;
	DEEPSEEK_BASE_URL?: string;
	BUILD?: string;
	/** 登录页「看一个真实对话」入口：站内 /s/<token> 或 https 绝对地址。 */
	DEMO_SHARE_URL?: string;
	/** 测试专用（wrangler.test.jsonc）：打开 /debug/harness 观测端点。 */
	TEST_HARNESS_STATS?: string;
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
	/** 会话域的 Harness 端口（open/重试/模型配置在 DO 组合根）；由路由注入 session-service。 */
	readonly sessionRuntime: SessionRuntime;
	/** 分享域的 Harness 端口（阶段 3）：只有会话分享真正读条目时才 open()。 */
	readonly shareRuntime: ShareRuntime;
	/** 设置读取端口（DO 用既有 getSetting 实现），供服务替代模块级 getSetting。 */
	readonly settings: KbSettings;
	/** 设置域：压缩策略 / 当前供应商变更后重建 Harness。 */
	readonly settingsRuntime: SettingsRuntime;
	/** 自动化域：任务或目标调度变更后重排 alarm。 */
	readonly alarmRuntime: AlarmRuntime;
	/** 上下文用量端口（GET /context）。 */
	readonly contextRuntime: ContextRuntime;
	/** 目标域：POST /goal 需要会话累计 token 基线。 */
	readonly goalRuntime: GoalRuntime;
	/** 能力域：GET /tools 需要当前已安装扩展的工具名与自定义工具集合。 */
	readonly toolRuntime: ToolRuntime;
	/** MCP 域：配置变更后重建扩展。 */
	readonly mcpRuntime: McpRuntime;
	/** DeepSeek 网页抓取端口（web_fetch_page 与链接 ingest 共用适配器）。 */
	webFetch(url: string): Promise<WebFetchResult>;
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
	sessionRuntime: SessionRuntime;
	shareRuntime: ShareRuntime;
	settings: KbSettings;
	settingsRuntime: SettingsRuntime;
	alarmRuntime: AlarmRuntime;
	contextRuntime: ContextRuntime;
	goalRuntime: GoalRuntime;
	toolRuntime: ToolRuntime;
	mcpRuntime: McpRuntime;
	webFetch(url: string): Promise<WebFetchResult>;
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
		sessionRuntime: input.sessionRuntime,
		shareRuntime: input.shareRuntime,
		settings: input.settings,
		settingsRuntime: input.settingsRuntime,
		alarmRuntime: input.alarmRuntime,
		contextRuntime: input.contextRuntime,
		goalRuntime: input.goalRuntime,
		toolRuntime: input.toolRuntime,
		mcpRuntime: input.mcpRuntime,
		webFetch: (url: string) => input.webFetch(url),
	};
}

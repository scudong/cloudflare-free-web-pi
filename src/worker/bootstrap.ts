/**
 * 首屏聚合（NERE-23）：把 17 个只读面板合并成一次响应。
 *
 * 这里只做编排与容错，不碰 SQL / Harness：
 * - 各面板的读取函数由 SpikeAgent 传入，与对应单端点共用同一实现；
 * - 单个面板抛错只影响自己的字段（数组 → []，其它 → null），其余照常返回；
 * - `errors` 只放稳定码（NERE-78），原文只进 `console.warn`，避免表名 / SQL 泄漏到响应。
 */

import { AppError } from "./http/errors";

export const BOOTSTRAP_KEYS = [
	"session",
	"entries",
	"sessions",
	"files",
	"memories",
	"approvals",
	"settings",
	"plan",
	"goal",
	"questions",
	"prompts",
	"rules",
	"customTools",
	"skills",
	"automations",
	"mcpServers",
	"models",
] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/** 数组字段失败时回退空数组；其余字段回退 null，前端已有的容错解析会兜住。 */
const ARRAY_FALLBACK: Partial<Record<BootstrapKey, true>> = {
	entries: true,
	sessions: true,
	files: true,
	memories: true,
	approvals: true,
	plan: true,
	questions: true,
	prompts: true,
	rules: true,
	customTools: true,
	skills: true,
	automations: true,
	mcpServers: true,
};

export type BootstrapLoaders = { [K in BootstrapKey]: () => unknown };

/** `errors` 只暴露稳定码；异常原文（可能带表名 / SQL）只进服务端日志。 */
export type BootstrapErrorCode = "internal_error" | "unavailable";

export type BootstrapPayload = { [K in BootstrapKey]: unknown } & {
	errors: Partial<Record<BootstrapKey, BootstrapErrorCode>>;
};

/** Harness 会话 / 存储请求失败意味着依赖暂时不可用；其余归为内部错误。 */
const UNAVAILABLE_NAMES: Record<string, true> = {
	SessionFailed: true,
	StorageRequestError: true,
};

function errorCode(err: unknown): BootstrapErrorCode {
	if (err instanceof Error && UNAVAILABLE_NAMES[err.name] === true) return "unavailable";
	if (err instanceof AppError && (err.status === 503 || err.code === "unavailable")) return "unavailable";
	return "internal_error";
}

function warnFailure(key: BootstrapKey, err: unknown): void {
	console.warn(`bootstrap panel failed: ${key}`, err);
}

export async function collectBootstrap(loaders: BootstrapLoaders): Promise<BootstrapPayload> {
	const settled = await Promise.all(
		BOOTSTRAP_KEYS.map(async (key) => {
			try {
				return { key, value: await loaders[key]() };
			} catch (err) {
				warnFailure(key, err);
				return { key, value: ARRAY_FALLBACK[key] ? [] : null, error: errorCode(err) };
			}
		}),
	);

	const payload = {} as BootstrapPayload;
	const errors: Partial<Record<BootstrapKey, BootstrapErrorCode>> = {};
	// 按固定字段顺序赋值，响应体字段顺序稳定，便于快照/体积对比。
	for (const item of settled) {
		payload[item.key] = item.value;
		if ("error" in item) errors[item.key] = item.error;
	}
	payload.errors = errors;
	return payload;
}

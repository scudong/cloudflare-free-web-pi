/**
 * 首屏聚合（NERE-23）：把 17 个只读面板合并成一次响应。
 *
 * 这里只做编排与容错，不碰 SQL / Harness：
 * - 各面板的读取函数由 SpikeAgent 传入，与对应单端点共用同一实现；
 * - 单个面板抛错只影响自己的字段（数组 → []，其它 → null），其余照常返回；
 * - 出错摘要放在 errors，便于线上定位，不把内部异常扩散成 500。
 */

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

export type BootstrapPayload = { [K in BootstrapKey]: unknown } & {
	errors: Partial<Record<BootstrapKey, string>>;
};

function message(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err);
	return text.slice(0, 200);
}

export async function collectBootstrap(loaders: BootstrapLoaders): Promise<BootstrapPayload> {
	const settled = await Promise.all(
		BOOTSTRAP_KEYS.map(async (key) => {
			try {
				return { key, value: await loaders[key]() };
			} catch (err) {
				return { key, value: ARRAY_FALLBACK[key] ? [] : null, error: message(err) };
			}
		}),
	);

	const payload = {} as BootstrapPayload;
	const errors: Partial<Record<BootstrapKey, string>> = {};
	// 按固定字段顺序赋值，响应体字段顺序稳定，便于快照/体积对比。
	for (const item of settled) {
		payload[item.key] = item.value;
		if ("error" in item) errors[item.key] = item.error;
	}
	payload.errors = errors;
	return payload;
}

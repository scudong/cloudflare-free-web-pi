import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import { KB_VECTOR_DEFAULT_INDEX } from "./kb-service";
import { MAX_SHARE_TTL, shareDefaultTtl } from "./share-service";
import * as providersRepo from "../repo/providers-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import * as settingsRepo from "../repo/settings-repo";
import type { SettingsRuntime } from "../http/ports";

/**
 * 设置 / 供应商 / 模型域用例（ADR-0001 §2）：
 * - `app_settings` 的默认值与写入口径；
 * - `providers` 的密钥回落、当前供应商、模型列表；
 * - 需要 Harness 重建的时机（压缩策略、当前供应商）经 `runtime.recover()` 交给 DO。
 *
 * 端点契约逐字保持：`/settings`、`/providers*`、`/models`、`/model`。
 */

/** 读取设置的函数形状（DO 传 `getSetting`，测试传内存实现）。 */
export type GetSetting = (key: string, fallback: string) => string;

export type SettingsEnv = { AI?: unknown; KB_VEC?: unknown; CF_DISABLE_VECTOR?: string };

export type ApprovalPolicy = "allow" | "ask" | "deny";
export type ThinkingLevel = "off" | "low" | "high";

/** 与 pi-durable 内置默认一致，作为设置项的回落值。 */
export const DEFAULT_COMPACTION = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

export type CompactionSettings = {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	backgroundTokens: number;
};

/** 思考档位：off / low / high。 */
export function thinkingLevel(get: GetSetting): ThinkingLevel {
	const value = get("thinking_level", "low");
	return value === "off" || value === "high" ? value : "low";
}

export function compactionSettings(get: GetSetting): CompactionSettings {
	const num = (key: string, fallback: number, min: number) => {
		const value = Number(get(key, String(fallback)));
		return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
	};
	return {
		enabled: get("compaction_enabled", "1") === "1",
		reserveTokens: num("compaction_reserve", DEFAULT_COMPACTION.reserveTokens, 1024),
		keepRecentTokens: num("compaction_keep_recent", DEFAULT_COMPACTION.keepRecentTokens, 0),
		backgroundTokens: num("compaction_background", DEFAULT_COMPACTION.backgroundTokens, 0),
	};
}

/** 三档策略（供设置页、能力清单与审批闸门共用）。 */
export function approvalSettings(get: GetSetting): { read: ApprovalPolicy; write: ApprovalPolicy; exec: ApprovalPolicy } {
	const pick = (level: "read" | "write" | "exec"): ApprovalPolicy => {
		const value = get(`approval_${level}`, "allow");
		return value === "ask" || value === "deny" ? value : "allow";
	};
	return { read: pick("read"), write: pick("write"), exec: pick("exec") };
}

export type KbRetrievalMode = "fts" | "vector" | "hybrid";

export function kbRetrievalMode(get: GetSetting): KbRetrievalMode {
	const value = get("kb_retrieval", "fts");
	return value === "vector" || value === "hybrid" ? value : "fts";
}

export function vectorAvailable(env: SettingsEnv): boolean {
	if (env.CF_DISABLE_VECTOR === "1") return false;
	return Boolean(env.AI && env.KB_VEC);
}

export type SettingsView = {
	webSearch: boolean;
	kbPrefetch: boolean;
	kbRetrieval: KbRetrievalMode;
	kbVector: { available: boolean; index: string };
	thinkingLevel: ThinkingLevel;
	compaction: CompactionSettings;
	approval: { read: ApprovalPolicy; write: ApprovalPolicy; exec: ApprovalPolicy };
	displayName: string;
	shareTtlSeconds: number;
};

/** GET /settings 的响应体；POST /settings 与 /bootstrap 复用，避免键漂移。 */
export function settingsView(get: GetSetting, env: SettingsEnv): SettingsView {
	return {
		webSearch: get("web_search", "1") === "1",
		kbPrefetch: get("kb_prefetch", "1") === "1",
		kbRetrieval: kbRetrievalMode(get),
		kbVector: { available: vectorAvailable(env), index: KB_VECTOR_DEFAULT_INDEX },
		thinkingLevel: thinkingLevel(get),
		compaction: compactionSettings(get),
		approval: approvalSettings(get),
		displayName: get("display_name", ""),
		shareTtlSeconds: shareDefaultTtl({ get }),
	};
}

/* ---------------- 供应商与模型 ---------------- */

/** 内置默认供应商（DeepSeek 官方，走 DEEPSEEK_API_KEY）。 */
export const DEFAULT_PROVIDER = { id: "deepseek", name: "DeepSeek 官方", models: ["deepseek-flash", "deepseek-v4-pro"] };
export const DEFAULT_MODEL_ID = "deepseek-flash";

/** 当前启用的供应商 id；空串 = 默认 DeepSeek。 */
export function activeProviderId(sql: SqlHandle): string {
	return settingsRepo.get(sql, "active_provider", "");
}

export function splitModels(raw: string): string[] {
	return raw
		.split(/[,，\s]+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 20);
}

/** 当前可用的模型 id 列表。 */
export function activeModelIds(sql: SqlHandle): string[] {
	const id = activeProviderId(sql);
	if (!id) return DEFAULT_PROVIDER.models;
	const row = providersRepo.find(sql, id);
	const models = row ? splitModels(row.models) : [];
	return models.length ? models : DEFAULT_PROVIDER.models;
}

export type ProviderView = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	hasKey: boolean;
	keyHint: string;
	active: boolean;
};

export type ProviderInput = {
	id?: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	models?: string | string[];
};

export type SettingsUpdateBody = {
	webSearch?: boolean;
	kbPrefetch?: boolean;
	kbRetrieval?: string;
	thinkingLevel?: string;
	displayName?: string;
	shareTtlSeconds?: number;
	approval?: Record<string, unknown>;
	approvalTools?: Record<string, unknown>;
	compaction?: Record<string, unknown>;
};

/** 端点错误 -> Route 映射为 `{ error }` + status（与旧响应逐字一致）。 */
export class SettingsApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "SettingsApiError";
	}
}

export type SettingsServiceDeps = { sql: SqlHandle; env: SettingsEnv; runtime: SettingsRuntime };

export interface SettingsService {
	view(): SettingsView;
	update(body: SettingsUpdateBody): Promise<SettingsView>;
	listProviders(): { active: string; default: typeof DEFAULT_PROVIDER; providers: ProviderView[] };
	saveProvider(input: ProviderInput): Promise<{ ok: true; id: string; models: string[] }>;
	removeProvider(id: string): Promise<{ ok: true }>;
	activate(id: string | undefined): Promise<{ ok: true; active: string; provider: string; models: string[] }>;
	models(): { models: string[]; default: string; provider: string };
	setModel(sessionId: string | undefined, modelId: string | undefined): void;
}

export function createSettingsService({ sql, env, runtime }: SettingsServiceDeps): SettingsService {
	const get: GetSetting = (key, fallback) => settingsRepo.get(sql, key, fallback);
	const set = (key: string, value: string) => settingsRepo.set(sql, key, value);

	return {
		view: () => settingsView(get, env),

		async update(body) {
			if (typeof body.webSearch === "boolean") set("web_search", body.webSearch ? "1" : "0");
			if (typeof body.kbPrefetch === "boolean") set("kb_prefetch", body.kbPrefetch ? "1" : "0");
			// 检索模式（v0.53.0）：fts / vector / hybrid
			if (body.kbRetrieval === "fts" || body.kbRetrieval === "vector" || body.kbRetrieval === "hybrid") {
				set("kb_retrieval", body.kbRetrieval);
			}
			if (body.thinkingLevel === "off" || body.thinkingLevel === "low" || body.thinkingLevel === "high") {
				set("thinking_level", body.thinkingLevel);
			}
			// 分享页署名与默认有效期（v0.55.0）
			if (typeof body.displayName === "string") set("display_name", body.displayName.trim().slice(0, 40));
			if (typeof body.shareTtlSeconds === "number" && Number.isFinite(body.shareTtlSeconds) && body.shareTtlSeconds >= 0) {
				set("share_ttl_seconds", String(Math.min(Math.floor(body.shareTtlSeconds), MAX_SHARE_TTL)));
			}
			// 工具审批（v0.33.0）：三档策略 + 逐工具覆盖
			if (body.approval && typeof body.approval === "object") {
				for (const level of ["read", "write", "exec"] as const) {
					const value = body.approval[level];
					if (value === "allow" || value === "ask" || value === "deny") set(`approval_${level}`, value);
				}
			}
			if (body.approvalTools && typeof body.approvalTools === "object") {
				for (const [name, value] of Object.entries(body.approvalTools)) {
					if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) continue;
					if (value === "follow" || value === "allow" || value === "ask" || value === "deny") {
						set(`approval_tool_${name}`, value);
					}
				}
			}
			let compactionChanged = false;
			if (body.compaction && typeof body.compaction === "object") {
				const c = body.compaction;
				if (typeof c.enabled === "boolean") {
					set("compaction_enabled", c.enabled ? "1" : "0");
					compactionChanged = true;
				}
				for (const [patchKey, settingKey, min] of [
					["reserveTokens", "compaction_reserve", 1024],
					["keepRecentTokens", "compaction_keep_recent", 0],
					["backgroundTokens", "compaction_background", 0],
				] as const) {
					const raw = Number(c[patchKey]);
					if (Number.isFinite(raw) && raw >= min) {
						set(settingKey, String(Math.floor(raw)));
						compactionChanged = true;
					}
				}
			}
			// 压缩策略在 Harness.open 时读取，改了要重建（先写库后重建）。
			if (compactionChanged) await runtime.recover();
			return settingsView(get, env);
		},

		listProviders() {
			const active = activeProviderId(sql);
			const rows = providersRepo.list(sql).map((r) => ({
				id: r.id,
				name: r.name,
				baseUrl: r.base_url,
				models: splitModels(r.models),
				hasKey: Boolean(r.api_key),
				keyHint: r.api_key ? "••••" + r.api_key.slice(-4) : "",
				active: r.id === active,
			}));
			return { active, default: DEFAULT_PROVIDER, providers: rows };
		},

		async saveProvider(body) {
			const name = (body.name ?? "").trim().slice(0, 40);
			const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
			if (!name || !/^https?:\/\//.test(baseUrl)) throw new SettingsApiError(400, "需要名称与 http(s) 地址");
			const modelList = (Array.isArray(body.models) ? body.models : splitModels(String(body.models ?? "")))
				.map((m) => String(m).trim())
				.filter(Boolean)
				.slice(0, 20);
			const id =
				(body.id ?? "").trim() ||
				baseUrl.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 24) ||
				"p" + Date.now().toString(36);
			const existing = providersRepo.find(sql, id);
			// 编辑时 apiKey 留空 = 保留原密钥
			const apiKey = (body.apiKey ?? "").trim() || existing?.api_key || "";
			if (!apiKey) throw new SettingsApiError(400, "需要 API Key");
			providersRepo.upsert(sql, {
				id,
				name,
				base_url: baseUrl,
				api_key: apiKey,
				models: modelList.join(","),
				createdAt: new Date().toISOString(),
			});
			if (activeProviderId(sql) === id) await runtime.recover();
			return { ok: true as const, id, models: modelList };
		},

		async removeProvider(id) {
			providersRepo.remove(sql, id);
			if (activeProviderId(sql) === id) set("active_provider", "");
			await runtime.recover();
			return { ok: true as const };
		},

		async activate(rawId) {
			const id = (rawId ?? "").trim();
			if (id && !providersRepo.find(sql, id)) throw new SettingsApiError(404, "供应商不存在");
			set("active_provider", id);
			await runtime.recover();
			return {
				ok: true as const,
				active: id,
				provider: activeProviderId(sql) || DEFAULT_PROVIDER.id,
				models: activeModelIds(sql),
			};
		},

		models() {
			const available = activeModelIds(sql);
			return {
				models: available,
				default: available[0] ?? DEFAULT_MODEL_ID,
				provider: activeProviderId(sql) || DEFAULT_PROVIDER.id,
			};
		},

		setModel(sessionId, modelId) {
			if (!activeModelIds(sql).includes(modelId ?? "")) throw new SettingsApiError(400, "不支持的模型");
			if (!sessionId) throw new SettingsApiError(400, "缺少 sessionId");
			sessionsRepo.upsertModel(sql, sessionId, modelId!, new Date().toISOString());
		},
	};
}

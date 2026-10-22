/**
 * Skill Hub 的解析、筛选与展示口径（NERE-54）。
 *
 * - 契约：NERE-53 `docs/skill-hub-contract.md`（§5.2 列表 / §7 筛选 / §4.4 审计报告）。
 * - 解析宽容：契约漂移时降级成默认值，不抛错、不让面板崩。
 * - 取数只在 `hooks/useSkillHub`；组件拿这里的结果做渲染与筛选。
 */

import type { SkillAudit, SkillAuditReason, SkillAuditStatus, SkillHubEntry } from "../types";
import { arrayOf, isObject, pickString } from "./collections";

/** 市场筛选条件：与契约 §5.2 的查询参数一一对应。 */
export interface SkillHubFilters {
	q: string;
	runtime: string;
	tag: string;
	audit: "" | SkillAuditStatus;
	/** host 子串（契约 §5.2 `source`）；空串表示不过滤。 */
	source: string;
}

export const EMPTY_SKILL_HUB_FILTERS: SkillHubFilters = {
	q: "",
	runtime: "",
	tag: "",
	audit: "",
	source: "",
};

/** 可安装 / 可筛选的运行时白名单（契约 §5.2 硬规则）：Python / Shell 不作为筛选项出现。 */
export const INSTALLABLE_RUNTIMES = ["prompt", "javascript", "typescript"] as const;

/**
 * 运行时下拉：只列契约允许的三种 + JS/TS 组合。
 * python / shell / binary / other 只能通过审计筛选（或不过滤）看到，避免误导为可安装。
 */
export const HUB_RUNTIME_FILTERS = [
	{ value: "", label: "全部运行时" },
	{ value: "javascript,typescript", label: "JS / TS" },
	{ value: "typescript", label: "TypeScript" },
	{ value: "javascript", label: "JavaScript" },
	{ value: "prompt", label: "提示词" },
] as const;

export const HUB_AUDIT_FILTERS = [
	{ value: "", label: "全部审计" },
	{ value: "pass", label: "通过" },
	{ value: "warn", label: "警告" },
	{ value: "blocked", label: "不可安装" },
] as const;

export const SKILL_AUDIT_LABELS: Record<SkillAuditStatus, string> = {
	pass: "审计通过",
	warn: "有警告",
	blocked: "不可安装",
};

export const SKILL_AUDIT_STYLES: Record<SkillAuditStatus, string> = {
	pass: "bg-emerald-500/15 text-emerald-300",
	warn: "bg-amber-500/15 text-amber-300",
	blocked: "bg-rose-500/15 text-rose-300",
};

/** blocked 条目的统一说明：Worker 只能跑 JS/TS 与纯提示词技能。 */
export const BLOCKED_HINT = "不可安装：仅支持 JS/TS 运行（含纯提示词技能）";

/** 审计排序（契约 §7.2）：可安装的在前，不可安装的沉底。 */
const AUDIT_RANK: Record<SkillAuditStatus, number> = { pass: 0, warn: 1, blocked: 2 };

const RUNTIME_ALIASES: Record<string, string> = {
	js: "javascript",
	javascript: "javascript",
	ecmascript: "javascript",
	ts: "typescript",
	typescript: "typescript",
	py: "python",
	python: "python",
	python3: "python",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	shell: "shell",
	prompt: "prompt",
	markdown: "prompt",
	md: "prompt",
	text: "prompt",
};

const RUNTIME_LABELS: Record<string, string> = {
	javascript: "JavaScript",
	typescript: "TypeScript",
	prompt: "提示词",
	python: "Python",
	shell: "Shell",
	binary: "二进制",
	other: "其他",
};

const AUDIT_ALIASES: Record<string, SkillAuditStatus> = {
	pass: "pass",
	passed: "pass",
	ok: "pass",
	clean: "pass",
	warn: "warn",
	warning: "warn",
	blocked: "blocked",
	block: "blocked",
	reject: "blocked",
	rejected: "blocked",
};

/** 运行时归一：TS / ts / typescript 视为同一类。 */
export function canonicalRuntime(value: string): string {
	const key = value.trim().toLowerCase();
	return RUNTIME_ALIASES[key] ?? key;
}

export function runtimeLabel(value: string): string {
	const canonical = canonicalRuntime(value);
	return RUNTIME_LABELS[canonical] ?? (value.trim() || "未知");
}

/** 下拉值允许逗号分隔（如 javascript,typescript）；空串表示不过滤。 */
function runtimeFilterValues(filter: string): string[] {
	return filter
		.split(",")
		.map((item) => canonicalRuntime(item))
		.filter(Boolean);
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			if (typeof item === "string" && item.trim()) return [item.trim()];
			if (isObject(item)) {
				const name = pickString(item, ["name", "host", "domain", "tool", "id"]);
				return name ? [name] : [];
			}
			return [];
		});
	}
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function parseBoolean(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** 单条审计原因：契约是对象，早期 `string[]` 仍兼容。 */
function parseAuditReason(raw: unknown): SkillAuditReason | null {
	if (typeof raw === "string") {
		const message = raw.trim();
		return message ? { message } : null;
	}
	if (!isObject(raw)) return null;
	const message = pickString(raw, ["message", "reason", "text"]);
	if (!message) return null;
	const rule = pickString(raw, ["rule"]);
	const evidence = pickString(raw, ["evidence"]);
	const levelKey = pickString(raw, ["level"]).toLowerCase();
	const level = AUDIT_ALIASES[levelKey];
	return {
		...(rule ? { rule } : {}),
		...(level ? { level } : {}),
		message,
		...(evidence ? { evidence } : {}),
	};
}

function parseAuditReasons(value: unknown): SkillAuditReason[] {
	if (Array.isArray(value)) {
		return value.map(parseAuditReason).filter((reason): reason is SkillAuditReason => reason !== null);
	}
	if (typeof value === "string" && value.trim()) return [{ message: value.trim() }];
	return [];
}

function parseAudit(raw: unknown, runtime: string, fallbackHash: string, requires: Record<string, unknown>): SkillAudit {
	const audit = isObject(raw) ? raw : {};
	const detected = isObject(audit.detected) ? audit.detected : {};
	const statusKey = pickString(audit, ["status"]).toLowerCase();
	const status = AUDIT_ALIASES[statusKey];
	const reasons = parseAuditReasons(audit.reasons);
	if (!status) reasons.push({ message: "审计状态缺失或无法识别，按「有警告」处理" });
	const auditSource = pickString(audit, ["auditSource", "audit_source"]);
	const rulesVersion = parseNumber(audit.rulesVersion);
	const network = stringList(detected.network);
	const tools = stringList(detected.tools);
	return {
		status: status ?? "warn",
		reasons,
		detected: {
			runtime: pickString(detected, ["runtime"]) || runtime,
			network: network.length > 0 ? network : stringList(requires.network),
			tools: tools.length > 0 ? tools : stringList(requires.tools),
		},
		auditedAt: pickString(audit, ["auditedAt", "audited_at"]) || undefined,
		hash: pickString(audit, ["hash", "contentHash", "content_hash"]) || fallbackHash || undefined,
		...(rulesVersion !== undefined ? { rulesVersion } : {}),
		...(auditSource === "local" || auditSource === "catalog" ? { auditSource } : {}),
	};
}

/** GET /api/skills/hub → 领域条目；没有名字的条目直接丢弃。 */
export function parseHubSkills(raw: unknown): SkillHubEntry[] {
	const list = arrayOf(raw, ["skills", "items"]).filter(isObject);
	const entries: SkillHubEntry[] = [];
	for (const item of list) {
		const name = pickString(item, ["name"]);
		if (!name) continue;
		const runtime = pickString(item, ["runtime"]) || "unknown";
		const contentHash = pickString(item, ["contentHash", "content_hash", "hash"]);
		const installedHash = pickString(item, ["installedHash", "installed_hash"]);
		const requires = isObject(item.requires) ? item.requires : {};
		entries.push({
			name,
			version: pickString(item, ["version"]),
			description: pickString(item, ["description"]),
			author: pickString(item, ["author"]),
			source: pickString(item, ["source"]),
			runtime,
			tags: stringList(item.tags),
			license: pickString(item, ["license"]),
			contentHash,
			installed: parseBoolean(item.installed),
			...(installedHash ? { installedHash } : {}),
			audit: parseAudit(item.audit, runtime, contentHash, requires),
			installUrl: pickString(item, ["installUrl", "install_url", "url", "contentUrl", "content_url"]) || undefined,
		});
	}
	return entries;
}

/** 目录快照信息（契约 §5.2 `catalog`）。 */
export interface SkillHubCatalog {
	source: string;
	fetchedAt?: string;
	/** 远程刷新失败：列表仍可用，前端展示「目录可能过期」。 */
	stale: boolean;
	count?: number;
}

/** 服务端给的筛选项（契约 §5.2 `filters`，取自目录全集）。 */
export interface SkillHubFilterOptions {
	runtimes: string[];
	tags: string[];
	/** host（不是完整 URL）。 */
	sources: string[];
}

export interface SkillHubPage {
	entries: SkillHubEntry[];
	total: number;
	catalog: SkillHubCatalog | null;
	options: SkillHubFilterOptions;
}

const INSTALLABLE_SET = new Set<string>(INSTALLABLE_RUNTIMES);

/** 解析整个列表响应；缺字段时给空值，不抛错。 */
export function parseHubPage(raw: unknown): SkillHubPage {
	const root = isObject(raw) ? raw : {};
	const entries = parseHubSkills(root);
	const catalogRaw = isObject(root.catalog) ? root.catalog : null;
	const filtersRaw = isObject(root.filters) ? root.filters : {};
	return {
		entries,
		total: parseNumber(root.total) ?? entries.length,
		catalog: catalogRaw
			? {
					source: pickString(catalogRaw, ["source"]),
					fetchedAt: pickString(catalogRaw, ["fetchedAt", "fetched_at"]) || undefined,
					stale: parseBoolean(catalogRaw.stale),
					count: parseNumber(catalogRaw.count),
				}
			: null,
		options: {
			// 契约只允许三种可安装运行时；服务端若误带 python/shell 也在这里滤掉。
			runtimes: stringList(filtersRaw.runtimes)
				.map((value) => canonicalRuntime(value))
				.filter((value) => INSTALLABLE_SET.has(value)),
			tags: stringList(filtersRaw.tags),
			sources: stringList(filtersRaw.sources),
		},
	};
}

/** 来源展示 / 筛选口径：URL 取 host，存量 `local` 原样返回。 */
export function sourceHost(source: string): string {
	const value = source.trim();
	if (!value) return "";
	try {
		return new URL(value).host || value;
	} catch {
		return value;
	}
}

/** 搜索命中名称 / 描述 / 标签（契约 §5.2：小写子串），其余维度按契约匹配。 */
export function filterHubSkills(entries: readonly SkillHubEntry[], filters: SkillHubFilters): SkillHubEntry[] {
	const query = filters.q.trim().toLowerCase();
	const runtimes = runtimeFilterValues(filters.runtime);
	const audits = filters.audit
		.split(",")
		.map((value) => AUDIT_ALIASES[value.trim().toLowerCase()])
		.filter((value): value is SkillAuditStatus => Boolean(value));
	const tags = filters.tag
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	const source = sourceHost(filters.source).toLowerCase();
	return entries.filter((entry) => {
		if (query) {
			const haystack = `${entry.name} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase();
			if (!haystack.includes(query)) return false;
		}
		if (runtimes.length > 0 && !runtimes.includes(canonicalRuntime(entry.runtime))) return false;
		if (audits.length > 0 && !audits.includes(entry.audit.status)) return false;
		if (tags.length > 0 && !entry.tags.some((tag) => tags.includes(tag.toLowerCase()))) return false;
		if (source && !sourceHost(entry.source).toLowerCase().includes(source)) return false;
		return true;
	});
}

/** 默认排序：audit 优先（pass → warn → blocked），同级按名称。 */
export function sortHubSkills(entries: readonly SkillHubEntry[]): SkillHubEntry[] {
	return [...entries].sort((a, b) => {
		const rank = AUDIT_RANK[a.audit.status] - AUDIT_RANK[b.audit.status];
		return rank !== 0 ? rank : a.name.localeCompare(b.name, "zh-CN");
	});
}

export function hasActiveHubFilters(filters: SkillHubFilters): boolean {
	return Boolean(filters.q.trim() || filters.runtime || filters.tag || filters.audit || filters.source);
}

/** 安装地址：优先 manifest 的 installUrl，其次 source（两者都必须是 http(s)）。 */
export function hubEntryInstallUrl(entry: SkillHubEntry): string {
	const direct = entry.installUrl?.trim() ?? "";
	if (/^https?:\/\//i.test(direct)) return direct;
	const source = entry.source.trim();
	return /^https?:\/\//i.test(source) ? source : "";
}

/** blocked 一律不可安装；没有安装地址的条目也不发请求。 */
export function canInstallHubEntry(entry: SkillHubEntry): boolean {
	return entry.audit.status !== "blocked" && hubEntryInstallUrl(entry) !== "";
}

/** 同名已安装但内容不同（契约 §5.2 `installedHash`）→ 展示「可更新」。 */
export function isHubEntryUpdatable(entry: SkillHubEntry): boolean {
	return (
		entry.installed &&
		Boolean(entry.installedHash) &&
		Boolean(entry.contentHash) &&
		entry.installedHash !== entry.contentHash
	);
}

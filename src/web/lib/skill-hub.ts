/**
 * Skill Hub 的解析、筛选与展示口径（NERE-54）。
 *
 * - 契约：NERE-53（`docs/skill-hub-contract.md` 合并后字段名以文档为准）。
 * - 解析宽容：契约漂移时降级成默认值，不抛错、不让面板崩。
 * - 取数只在 `hooks/useSkillHub`；组件拿这里的结果做渲染与筛选。
 */

import type { SkillAudit, SkillAuditStatus, SkillHubEntry } from "../types";
import { arrayOf, isObject, pickString } from "./collections";

/** 市场筛选条件：source 只在本地过滤（契约 §6 的查询串没有 source）。 */
export interface SkillHubFilters {
	q: string;
	runtime: string;
	tag: string;
	audit: "" | SkillAuditStatus;
	source: string;
}

export const EMPTY_SKILL_HUB_FILTERS: SkillHubFilters = {
	q: "",
	runtime: "",
	tag: "",
	audit: "",
	source: "",
};

/** 运行时下拉：JS/TS 与纯提示词可安装；Python / Shell 留着是为了让用户看见被挡下的条目。 */
export const HUB_RUNTIME_FILTERS = [
	{ value: "", label: "全部运行时" },
	{ value: "javascript,typescript", label: "JS / TS" },
	{ value: "typescript", label: "TypeScript" },
	{ value: "javascript", label: "JavaScript" },
	{ value: "prompt", label: "提示词" },
	{ value: "python", label: "Python" },
	{ value: "shell", label: "Shell" },
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

/** 审计排序（NERE-53 §6「默认 audit 优先」）：可安装的在前，不可安装的沉底。 */
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

function parseAudit(raw: unknown, runtime: string, fallbackHash: string): SkillAudit {
	const audit = isObject(raw) ? raw : {};
	const detected = isObject(audit.detected) ? audit.detected : {};
	const statusKey = pickString(audit, ["status"]).toLowerCase();
	const status = AUDIT_ALIASES[statusKey];
	const reasons = stringList(audit.reasons);
	if (!status) reasons.push("审计状态缺失或无法识别，按「有警告」处理");
	return {
		status: status ?? "warn",
		reasons,
		detected: {
			runtime: pickString(detected, ["runtime"]) || runtime,
			network: stringList(detected.network),
			tools: stringList(detected.tools),
		},
		auditedAt: pickString(audit, ["auditedAt", "audited_at"]) || undefined,
		hash: pickString(audit, ["hash", "contentHash", "content_hash"]) || fallbackHash || undefined,
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
		const hash = pickString(item, ["contentHash", "content_hash", "hash"]);
		entries.push({
			name,
			version: pickString(item, ["version"]),
			description: pickString(item, ["description"]),
			author: pickString(item, ["author"]),
			source: pickString(item, ["source"]),
			runtime,
			tags: stringList(item.tags),
			audit: parseAudit(item.audit, runtime, hash),
			installUrl: pickString(item, ["installUrl", "install_url", "url", "contentUrl", "content_url"]) || undefined,
		});
	}
	return entries;
}

/** 搜索命中名称与描述（大小写不敏感），其余维度精确匹配。 */
export function filterHubSkills(entries: readonly SkillHubEntry[], filters: SkillHubFilters): SkillHubEntry[] {
	const query = filters.q.trim().toLowerCase();
	const runtimes = runtimeFilterValues(filters.runtime);
	return entries.filter((entry) => {
		if (query) {
			const haystack = `${entry.name} ${entry.description}`.toLowerCase();
			if (!haystack.includes(query)) return false;
		}
		if (runtimes.length > 0 && !runtimes.includes(canonicalRuntime(entry.runtime))) return false;
		if (filters.audit && entry.audit.status !== filters.audit) return false;
		if (filters.tag && !entry.tags.includes(filters.tag)) return false;
		if (filters.source && entry.source !== filters.source) return false;
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

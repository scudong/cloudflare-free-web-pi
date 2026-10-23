import type { SqlHandle } from "../db/migrations";
import { AppError } from "../http/errors";
import type { SettingsPort } from "../http/ports";
import {
	CONTENT_MAX_BYTES,
	HASH_RE,
	INSTALLABLE_RUNTIMES,
	MANIFEST_MAX_BYTES,
	RULES_VERSION,
	SKILL_NAME_RE,
	SKILL_RUNTIMES,
	auditSkill,
	byteLength,
	parseFrontmatter,
	parseManifest,
	sha256Content,
	slugifySkillName,
	stripFrontmatter,
	synthesizeManifest,
	untrustedCatalogReason,
	type AuditReport,
	type SkillManifest,
	type SkillRuntime,
} from "../lib/skill-audit";
import { BUNDLED_CATALOG, BUNDLED_CATALOG_GENERATED_AT, catalogRuntime, type CatalogEntry } from "../lib/skill-catalog";
import { SkillFetchError, fetchSkillText, normalizeSkillUrl, rewriteSkillStub, type FetchSkillText } from "../lib/skill-import";
import {
	countSkills,
	deleteSkill,
	eventCounts,
	getCachedAudit,
	getSkillRow,
	invokedNames,
	lastInvokedMap,
	listSkillMeta,
	listSkillRows,
	putCachedAudit,
	recordEvent,
	updateSkillAudit,
	upsertManualSkill,
	upsertSkill,
	type SkillEventType,
	type SkillMeta,
	type SkillRow,
} from "../repo/skills-repo";

/**
 * 技能域用例（NERE-55）：目录装载 + 已安装合并 + 导入审计 + 埋点聚合。
 * SQL 全部经 repo；HTTP 状态码与响应体在 `routes/skills.ts`。
 */

export class SkillApiError extends AppError {
	constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
		super(code, status, message, false, details);
		this.name = "SkillApiError";
	}
}

export type SkillServiceDeps = {
	sql: SqlHandle;
	settings?: SettingsPort;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	/** 测试注入：跳过内置模块，直接用给定目录。 */
	catalog?: CatalogEntry[];
};

export type HubQuery = {
	q?: string | null;
	runtime?: string | null;
	tag?: string | null;
	audit?: string | null;
	source?: string | null;
	origin?: string | null;
	installed?: string | null;
	sort?: string | null;
	limit?: string | null;
	offset?: string | null;
};

export type HubSkill = {
	name: string;
	version: string;
	description: string;
	author: string;
	source: string;
	license: string;
	runtime: SkillRuntime;
	tags: string[];
	requires: { tools: string[]; bindings: string[]; network: string[] };
	contentHash: string;
	installed: boolean;
	installedHash?: string;
	audit: AuditReport;
	origin: "bundled" | "remote";
	/** 安装地址：前端 `hubEntryInstallUrl` 优先读 installUrl，再回退 contentUrl/source。 */
	installUrl?: string;
	contentUrl?: string;
};

export type HubResponse = {
	skills: HubSkill[];
	total: number;
	nextOffset: number | null;
	catalog: { source: "bundled" | "remote"; fetchedAt: string | null; stale: boolean; count: number };
	filters: { runtimes: SkillRuntime[]; tags: string[]; sources: string[] };
};

export type ImportResult = {
	ok: true;
	installed: true;
	changed: boolean;
	name: string;
	version: string;
	description: string;
	source: string;
	contentHash: string;
	audit: AuditReport;
};

export type MetricsResponse = {
	days: number;
	since: number;
	hubViews: number;
	installOk: number;
	installBlocked: number;
	blockedRatio: number;
	installed: number;
	called7d: number;
};

/** 社区目录（badlogic/pi-skills）8 条：全部需要本地运行时或宿主命令，统一映射为 blocked。 */
export const COMMUNITY_SKILLS = [
	{ name: "brave-search", description: "通过 Brave Search API 搜索网页与提取正文", needsLocal: false },
	{ name: "youtube-transcript", description: "抓取 YouTube 视频字幕用于总结分析", needsLocal: false },
	{ name: "browser-tools", description: "通过 Chrome DevTools 协议做浏览器自动化", needsLocal: true },
	{ name: "transcribe", description: "本地语音转写（Apple Silicon / ffmpeg）", needsLocal: true },
	{ name: "gdcli", description: "Google Drive 命令行（列目录/上传/下载/分享）", needsLocal: true },
	{ name: "gccli", description: "Google Calendar 命令行（查看/创建事件）", needsLocal: true },
	{ name: "gmcli", description: "Gmail 命令行（搜索/读信/发信）", needsLocal: true },
	{ name: "vscode", description: "VS Code 集成（查看 diff / 比较文件）", needsLocal: true },
] as const;
const COMMUNITY_RAW_BASE = "https://raw.githubusercontent.com/badlogic/pi-skills/main";

const HUB_LIMIT_DEFAULT = 50;
const HUB_LIMIT_MAX = 200;
const REMOTE_TTL_MS = 10 * 60 * 1000;
const METRICS_MAX_DAYS = 90;

type RemoteCache = { url: string; at: number; entries: CatalogEntry[] };
/** 进程内 LRU（按 isolate）：远程目录 TTL 10 分钟；失败时用最近一次成功结果。 */
let remoteCache: RemoteCache | null = null;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function tagList(raw: string): string[] {
	const parsed = parseJson<unknown>(raw, null);
	if (Array.isArray(parsed)) return parsed.filter((tag): tag is string => typeof tag === "string");
	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function coerceRuntime(value: string | undefined): SkillRuntime {
	return (SKILL_RUNTIMES as readonly string[]).includes(value ?? "") ? (value as SkillRuntime) : "other";
}

function sourceHost(source: string): string {
	if (!source || source === "local") return "";
	try {
		return new URL(source).hostname.toLowerCase();
	} catch {
		return source.toLowerCase();
	}
}

function parseCsv(value: string | null | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** 目录快照审计：缺 audit 或 hash 不一致一律 blocked（fail closed，契约 §4.5 / §6.1）。 */
function snapshotAudit(entry: CatalogEntry, generatedAt: string): AuditReport {
	const audit = entry.audit as AuditReport | undefined;
	const hash = String(entry.contentHash ?? "");
	const runtime = catalogRuntime(entry);
	if (!audit || !hash || audit.hash !== hash || !Array.isArray(audit.reasons)) {
		return {
			status: "blocked",
			reasons: [untrustedCatalogReason()],
			detected: { runtime, network: [], tools: [] },
			auditedAt: generatedAt,
			hash,
			rulesVersion: RULES_VERSION,
			auditSource: "catalog",
		};
	}
	return { ...audit, detected: { ...audit.detected, runtime }, auditSource: "catalog" };
}

function rowManifest(row: SkillMeta): SkillManifest {
	const stored = parseJson<unknown>(row.manifest, null);
	if (stored) {
		const parsed = parseManifest(stored);
		if (parsed.ok) return parsed.manifest;
	}
	return synthesizeManifest({
		name: row.name,
		description: row.description,
		runtime: coerceRuntime(row.runtime),
		source: row.source || "local",
	});
}

function hubFromCatalog(entry: CatalogEntry, installed: SkillMeta | undefined, installedAudit: AuditReport | undefined, generatedAt: string): HubSkill {
	const runtime = catalogRuntime(entry);
	const contentHash = String(entry.contentHash ?? "");
	return {
		name: String(entry.name ?? ""),
		version: String(entry.version ?? ""),
		description: String(entry.description ?? ""),
		author: String(entry.author ?? ""),
		source: String(entry.source ?? ""),
		license: String(entry.license ?? ""),
		runtime,
		tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
		requires: {
			tools: Array.isArray(entry.requires?.tools) ? entry.requires.tools : [],
			bindings: Array.isArray(entry.requires?.bindings) ? entry.requires.bindings : [],
			network: Array.isArray(entry.requires?.network) ? entry.requires.network : [],
		},
		contentHash,
		installed: Boolean(installed),
		...(installed && installed.contentHash !== contentHash
			? { installedHash: installedAudit?.hash ?? installed.contentHash }
			: {}),
		// 已安装技能的本地重审计优先于目录快照（契约 §4.5）
		audit: installedAudit ?? snapshotAudit(entry, generatedAt),
		origin: entry.origin === "remote" ? "remote" : "bundled",
		installUrl: String(entry.contentUrl ?? ""),
		contentUrl: String(entry.contentUrl ?? ""),
	};
}

function hubFromInstalled(row: SkillMeta, audit: AuditReport): HubSkill {
	const manifest = rowManifest(row);
	return {
		name: row.name,
		version: row.version || manifest.version,
		description: row.description,
		author: row.author || manifest.author,
		source: row.source || manifest.source,
		license: row.license || manifest.license,
		runtime: coerceRuntime(row.runtime),
		tags: tagList(row.tags),
		requires: manifest.requires,
		contentHash: audit.hash || row.contentHash,
		installed: true,
		audit,
		origin: "bundled",
	};
}

export type CommunityResponse = {
	source: string;
	skills: {
		name: string;
		description: string;
		needsLocal: boolean;
		url: string;
		runtime: SkillRuntime;
		audit_status: "blocked";
		audit: AuditReport;
	}[];
};

const AUDIT_RANK: Record<string, number> = { pass: 0, warn: 1, blocked: 2 };

/** 模型侧 load_skill / 显式技能调用写同一套事件（NERE-59）；失败不影响主流程。 */
export function trackSkillCall(sql: SqlHandle, name: string, kind: "loaded" | "invoked"): void {
	try {
		recordEvent(sql, {
			name: name.slice(0, 80),
			type: kind === "loaded" ? "skill_loaded" : "skill_invoked",
			source: kind,
			at: Date.now(),
		});
	} catch {
		// 事件表不可用时静默降级
	}
}

export function createSkillService(deps: SkillServiceDeps): SkillService {
	const { sql, settings, fetchImpl = fetch } = deps;
	const now = () => (deps.now ? deps.now() : new Date());

	/** 埋点失败不阻断主流程（契约追加 A）。 */
	function track(type: SkillEventType, name: string, source = "", meta = ""): void {
		try {
			recordEvent(sql, { name: name.slice(0, 80), type, source: source.slice(0, 200), at: now().getTime(), meta: meta.slice(0, 500) });
		} catch {
			// 事件表缺失/写入失败：降级，不影响安装与列表
		}
	}

	/** 已安装行的本地重审计：按 content_hash 缓存，命中直接复用报告。 */
	async function auditRow(row: SkillRow): Promise<AuditReport> {
		const runtime = coerceRuntime(row.runtime);
		const hash = await sha256Content(runtime === "prompt" ? stripFrontmatter(row.content) : row.content);
		const cached = getCachedAudit(sql, hash, RULES_VERSION);
		if (cached) {
			const report = parseJson<AuditReport | null>(cached.report, null);
			if (report) {
				const current = { ...report, hash, auditSource: "local" as const };
				persistAudit(row, current);
				return current;
			}
		}
		const manifest = rowManifest(row);
		const report = await auditSkill({
			manifest,
			content: row.content,
			filename: manifest.entry ?? (runtime === "prompt" ? "SKILL.md" : undefined),
			exemptMeta: true,
			auditSource: "local",
			auditedAt: now().toISOString(),
		});
		putCachedAudit(sql, {
			hash: report.hash,
			rulesVersion: RULES_VERSION,
			status: report.status,
			report: JSON.stringify(report),
			auditedAt: report.auditedAt,
		});
		persistAudit(row, report);
		return report;
	}

	/** 重审计是判定真相：把状态/报告回写，避免 `GET /skills` 与 hub / 提示词索引各读各的。 */
	function persistAudit(row: SkillRow, report: AuditReport): void {
		const auditReport = JSON.stringify(report);
		if (row.auditStatus === report.status && row.auditReport === auditReport && row.contentHash) return;
		updateSkillAudit(sql, row.name, {
			contentHash: report.hash,
			auditStatus: report.status,
			auditReport,
		});
	}

	/**
	 * 落库报告可以直接复用：哈希与规则版本都对得上，就不必读正文重算。
	 * 旧库行（报告缺失 / 空 hash）与规则升级后的行回落到重审计。
	 */
	function storedAudit(row: SkillMeta): AuditReport | null {
		const report = parseJson<AuditReport | null>(row.auditReport, null);
		if (!report || !row.contentHash || report.hash !== row.contentHash) return null;
		if (report.rulesVersion !== RULES_VERSION || !Array.isArray(report.reasons) || typeof report.status !== "string") return null;
		return report;
	}

	async function installedRows(): Promise<{ rows: SkillMeta[]; audits: Map<string, AuditReport> }> {
		const rows = listSkillMeta(sql);
		const audits = new Map<string, AuditReport>();
		for (const row of rows) {
			const stored = storedAudit(row);
			if (stored) {
				audits.set(row.name, stored);
				continue;
			}
			// 只有存量行 / 旧规则版本的报告才读正文重审计（正常路径零正文、零 SHA-256）。
			const full = getSkillRow(sql, row.name);
			if (full) audits.set(row.name, await auditRow(full));
		}
		return { rows, audits };
	}

	/** 内置目录 + 可选远程目录（远程失败回落内置并标 stale，不 5xx）。 */
	async function loadCatalog(): Promise<{
		entries: CatalogEntry[];
		source: "bundled" | "remote";
		fetchedAt: string | null;
		stale: boolean;
	}> {
		const bundled = (deps.catalog ?? (BUNDLED_CATALOG.entries as CatalogEntry[])).map((entry) => ({
			...entry,
			origin: entry.origin ?? "bundled",
		}));
		const remoteUrl = (settings?.get("skill_catalog_url", "") ?? "").trim();
		if (!remoteUrl) {
			return { entries: bundled, source: "bundled", fetchedAt: BUNDLED_CATALOG_GENERATED_AT, stale: false };
		}
		const cached = remoteCache && remoteCache.url === remoteUrl ? remoteCache : null;
		if (cached && now().getTime() - cached.at < REMOTE_TTL_MS) {
			return { entries: [...bundled, ...cached.entries], source: "remote", fetchedAt: new Date(cached.at).toISOString(), stale: false };
		}
		try {
			const response = await fetchImpl(remoteUrl, {
				headers: { "user-agent": "pi-harness-skill-catalog" },
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const text = await response.text();
			if (byteLength(text) > 512 * 1024) throw new Error("目录超过 512 KiB");
			const parsed = JSON.parse(text) as { schemaVersion?: number; entries?: unknown };
			if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error("目录结构非法");
			const seen = new Set(bundled.map((entry) => entry.name));
			const remote: CatalogEntry[] = [];
			for (const raw of parsed.entries.slice(0, 200)) {
				const entry = raw as CatalogEntry;
				if (!entry || typeof entry.name !== "string" || !SKILL_NAME_RE.test(entry.name)) continue;
				if (seen.has(entry.name)) continue; // 重名保留首条
				seen.add(entry.name);
				remote.push({ ...entry, origin: "remote" });
			}
			remoteCache = { url: remoteUrl, at: now().getTime(), entries: remote };
			return {
				entries: [...bundled, ...remote],
				source: "remote",
				fetchedAt: now().toISOString(),
				stale: false,
			};
		} catch {
			return {
				entries: [...bundled, ...(cached?.entries ?? [])],
				source: "remote",
				fetchedAt: cached ? new Date(cached.at).toISOString() : null,
				stale: true,
			};
		}
	}

	async function hub(query: HubQuery = {}): Promise<HubResponse> {
		const qt = (query.q ?? "").trim().toLowerCase().slice(0, 100);
		const runtimeFilter = parseCsv(query.runtime).map((value) =>
			value === "js" ? "javascript" : value === "ts" ? "typescript" : value,
		);
		for (const runtime of runtimeFilter) {
			if (!(SKILL_RUNTIMES as readonly string[]).includes(runtime)) {
				throw new SkillApiError(400, "bad_request", `runtime 不支持：${runtime}`);
			}
		}
		const auditFilter = parseCsv(query.audit);
		for (const status of auditFilter) {
			if (status !== "pass" && status !== "warn" && status !== "blocked") {
				throw new SkillApiError(400, "bad_request", `audit 只接受 pass/warn/blocked：${status}`);
			}
		}
		const tagFilter = parseCsv(query.tag);
		const originFilter = query.origin === "bundled" || query.origin === "remote" ? query.origin : "";
		const installedFilter = query.installed === "1" ? true : query.installed === "0" ? false : null;
		const sourceFilter = (query.source ?? "").trim().toLowerCase();
		const sort = query.sort === "name" || query.sort === "updated" ? query.sort : "audit";
		const limit = Math.min(HUB_LIMIT_MAX, Math.max(1, Number(query.limit ?? HUB_LIMIT_DEFAULT) || HUB_LIMIT_DEFAULT));
		const offset = Math.max(0, Number(query.offset ?? 0) || 0);

		const catalog = await loadCatalog();
		const { rows, audits } = await installedRows();
		const installedByName = new Map(rows.map((row) => [row.name, row]));
		const seen = new Set<string>();
		const merged: HubSkill[] = [];
		for (const entry of catalog.entries) {
			if (!entry?.name || seen.has(entry.name)) continue;
			seen.add(entry.name);
			merged.push(
				hubFromCatalog(entry, installedByName.get(entry.name), audits.get(entry.name), catalog.fetchedAt ?? BUNDLED_CATALOG_GENERATED_AT),
			);
		}
		for (const row of rows) {
			if (seen.has(row.name)) continue;
			seen.add(row.name);
			const audit = audits.get(row.name);
			if (audit) merged.push(hubFromInstalled(row, audit));
		}

		if (auditFilter.includes("blocked")) {
			for (const skill of communityHubEntries()) {
				if (seen.has(skill.name)) continue;
				seen.add(skill.name);
				merged.push(skill);
			}
		}

		const runtimeSet = runtimeFilter.length ? new Set(runtimeFilter) : null;
		const auditSet = auditFilter.length ? new Set(auditFilter) : null;
		const tagSet = tagFilter.length ? new Set(tagFilter) : null;
		const filtered = merged.filter((item) => {
			if (qt && !`${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(qt)) return false;
			if (runtimeSet && !runtimeSet.has(item.runtime)) return false;
			if (auditSet && !auditSet.has(item.audit.status)) return false;
			if (tagSet && !item.tags.some((tag) => tagSet.has(tag))) return false;
			if (originFilter && item.origin !== originFilter) return false;
			if (installedFilter !== null && item.installed !== installedFilter) return false;
			if (sourceFilter && !`${item.source} ${sourceHost(item.source)}`.toLowerCase().includes(sourceFilter)) return false;
			return true;
		});

		if (sort === "name") filtered.sort((a, b) => a.name.localeCompare(b.name));
		else if (sort === "updated") {
			const updatedAt = (name: string) => installedByName.get(name)?.updatedAt ?? "";
			filtered.sort((a, b) => updatedAt(b.name).localeCompare(updatedAt(a.name)) || a.name.localeCompare(b.name));
		} else {
			filtered.sort(
				(a, b) => (AUDIT_RANK[a.audit.status] ?? 9) - (AUDIT_RANK[b.audit.status] ?? 9) || a.name.localeCompare(b.name),
			);
		}

		const page = filtered.slice(offset, offset + limit);
		track("skill_hub_view", "", "hub");
		return {
			skills: page,
			total: filtered.length,
			nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
			catalog: {
				source: catalog.source,
				fetchedAt: catalog.fetchedAt,
				stale: catalog.stale,
				count: catalog.entries.length,
			},
			filters: {
				runtimes: [...INSTALLABLE_RUNTIMES],
				tags: [...new Set(catalog.entries.flatMap((entry) => (Array.isArray(entry.tags) ? entry.tags : [])))].sort(),
				sources: [...new Set(merged.map((item) => sourceHost(item.source)).filter(Boolean))].sort(),
			},
		};
	}

	async function auditFor(name: string): Promise<{ name: string; version: string; contentHash: string; source: string; audit: AuditReport }> {
		if (!SKILL_NAME_RE.test(name)) throw new SkillApiError(400, "bad_request", "技能名不合法");
		const row = getSkillRow(sql, name);
		if (row) {
			const audit = await auditRow(row);
			track("skill_detail_view", name, "installed");
			return { name: row.name, version: row.version, contentHash: audit.hash, source: row.source, audit };
		}
		const catalog = await loadCatalog();
		const entry = catalog.entries.find((item) => item.name === name);
		if (!entry) throw new SkillApiError(404, "not_found", "技能不存在");
		track("skill_detail_view", name, "catalog");
		return {
			name,
			version: String(entry.version ?? ""),
			contentHash: String(entry.contentHash ?? ""),
			source: String(entry.source ?? ""),
			audit: snapshotAudit(entry, catalog.fetchedAt ?? BUNDLED_CATALOG_GENERATED_AT),
		};
	}

	async function importSkill(body: unknown): Promise<ImportResult> {
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new SkillApiError(400, "bad_request", "请求体必须是 JSON 对象");
		}
		const input = body as {
			url?: unknown;
			manifest?: unknown;
			content?: unknown;
			expectedHash?: unknown;
			overwrite?: unknown;
			name?: unknown;
		};
		const overwrite = input.overwrite === true;
		const nameOverride = typeof input.name === "string" ? input.name.trim() : "";
		const expectedHash = typeof input.expectedHash === "string" ? input.expectedHash.trim() : "";
		if (expectedHash && !HASH_RE.test(expectedHash)) throw new SkillApiError(400, "bad_request", "expectedHash 必须是 sha256:<64 hex>");
		if (input.url !== undefined) {
			if (input.manifest !== undefined || input.content !== undefined) {
				throw new SkillApiError(400, "bad_request", "url 与 manifest+content 只能二选一");
			}
			if (typeof input.url !== "string" || !input.url.trim()) throw new SkillApiError(400, "bad_request", "缺少 url");
			return await importFromUrl(input.url.trim(), expectedHash, overwrite, nameOverride);
		}
		if (input.manifest === undefined || typeof input.content !== "string") {
			throw new SkillApiError(400, "bad_request", "需要 url，或 manifest + content");
		}
		if (byteLength(input.content) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "内容超过 256 KiB");
		const parsed = parseManifest(input.manifest);
		if (!parsed.ok) throw new SkillApiError(400, "bad_request", parsed.reason.message, { reason: parsed.reason });
		const manifest = parsed.manifest;
		if (byteLength(JSON.stringify(manifest)) > MANIFEST_MAX_BYTES) throw new SkillApiError(413, "too_large", "manifest 超过 16 KiB");
		const filename = manifest.entry ?? (manifest.runtime === "prompt" ? "SKILL.md" : undefined);
		const audit = await auditSkill({
			manifest,
			content: input.content,
			filename,
			expectedHash: expectedHash || undefined,
			auditSource: "local",
			auditedAt: now().toISOString(),
		});
		return finishImport({
			manifest,
			content: manifest.runtime === "prompt" ? stripFrontmatter(input.content) : input.content,
			audit,
			overwrite,
			urlSource: manifest.source,
			legacy: false,
		});
	}

	async function importFromUrl(
		url: string,
		expectedHash: string,
		overwrite: boolean,
		nameOverride = "",
	): Promise<ImportResult> {
		const target = normalizeSkillUrl(url);
		if (!target) throw new SkillApiError(400, "bad_request", "需要 http(s) 链接");
		let fetched: FetchSkillText;
		try {
			fetched = await fetchSkillText(target, fetchImpl);
		} catch (err) {
			if (err instanceof SkillFetchError) {
				const code = err.status === 413 ? "too_large" : err.status === 502 ? "upstream_failed" : "audit_blocked";
				throw new SkillApiError(err.status, code, err.message, {
					audit: {
						status: "blocked",
						reasons: [{ rule: err.rule, level: "blocked", message: err.message, ...(err.evidence ? { evidence: err.evidence } : {}) }],
						detected: { runtime: "other", network: [], tools: [] },
						auditedAt: now().toISOString(),
						hash: "",
						rulesVersion: RULES_VERSION,
						auditSource: "local",
					},
				});
			}
			throw err;
		}

		// URL 指向 skill.json → 再抓一次入口文件（契约 §5.4 A）。
		const manifestText = parseJson<{ schemaVersion?: unknown } | null>(fetched.text, null);
		if (manifestText && manifestText.schemaVersion === 1) {
			const parsed = parseManifest(manifestText);
			if (!parsed.ok) throw new SkillApiError(400, "bad_request", parsed.reason.message, { reason: parsed.reason });
			const manifest = parsed.manifest;
			if (!manifest.entry) {
				// prompt 技能的内容文件是同目录的 SKILL.md（契约 §2.1）。
				const contentUrl = new URL("SKILL.md", fetched.url).toString();
				let body: string;
				try {
					body = (await fetchSkillText(contentUrl, fetchImpl)).text;
				} catch (err) {
					if (err instanceof SkillFetchError) {
						throw new SkillApiError(err.status === 413 ? 413 : 502, err.status === 413 ? "too_large" : "upstream_failed", err.message);
					}
					throw err;
				}
				const audit = await auditSkill({
					manifest,
					content: body,
					filename: "SKILL.md",
					expectedHash: expectedHash || undefined,
					hashMismatch: Boolean(manifest.contentHash && manifest.contentHash !== (await sha256Content(stripFrontmatter(body)))),
					auditSource: "local",
					auditedAt: now().toISOString(),
				});
				return finishImport({
					manifest,
					content: stripFrontmatter(body),
					audit,
					overwrite,
					urlSource: fetched.url,
					legacy: false,
				});
			}
			const entryUrl = new URL(manifest.entry, fetched.url).toString();
			let entryText: string;
			try {
				entryText = (await fetchSkillText(entryUrl, fetchImpl)).text;
			} catch (err) {
				if (err instanceof SkillFetchError) {
					throw new SkillApiError(err.status === 413 ? 413 : 502, err.status === 413 ? "too_large" : "upstream_failed", err.message);
				}
				throw err;
			}
			if (byteLength(entryText) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "内容超过 256 KiB");
			const audit = await auditSkill({
				manifest,
				content: entryText,
				filename: manifest.entry,
				expectedHash: expectedHash || undefined,
				hashMismatch: Boolean(manifest.contentHash && manifest.contentHash !== (await sha256Content(entryText))),
				auditSource: "local",
				auditedAt: now().toISOString(),
			});
			return finishImport({ manifest, content: entryText, audit, overwrite, urlSource: fetched.url, legacy: false });
		}

		// 任意文本 → 合成 legacy prompt manifest（契约 §2.6）。
		const frontmatter = parseFrontmatter(fetched.text);
		const fallback = fetched.url.split("/").slice(-2, -1)[0] ?? "imported-skill";
		const override = nameOverride ? slugifySkillName(nameOverride) : "";
		if (nameOverride && !override) throw new SkillApiError(400, "bad_request", "覆盖的技能名不合法");
		const name = override || slugifySkillName(frontmatter.name) || slugifySkillName(fallback) || "imported-skill";
		const description = (frontmatter.description || "（从社区导入，未提供描述）").slice(0, 200);
		const manifest = synthesizeManifest({
			name,
			description,
			runtime: "prompt",
			source: fetched.url,
			frontmatter: { name, description },
		});
		const rawBody = stripFrontmatter(fetched.text);
		const body = rewriteSkillStub(rawBody);
		const catalogHash = await bundledHashFor(name);
		const audit = await auditSkill({
			manifest,
			content: body,
			filename: "SKILL.md",
			// 正文被本地改写后与发布哈希不再等价，此时不拿目录哈希做校验（改写只发生在导入侧）。
			expectedHash: expectedHash || (body === rawBody ? catalogHash : "") || undefined,
			auditSource: "local",
			auditedAt: now().toISOString(),
		});
		return finishImport({
			manifest,
			content: body,
			audit,
			overwrite,
			urlSource: fetched.url,
			legacy: true,
		});
	}

	/** 内置目录同名条目的哈希：安装时自动校验，目录被篡改即 blocked。 */
	async function bundledHashFor(name: string): Promise<string> {
		const catalog = await loadCatalog();
		const entry = catalog.entries.find((item) => item.name === name);
		return entry?.contentHash && HASH_RE.test(entry.contentHash) ? entry.contentHash : "";
	}

	async function finishImport(input: {
		manifest: SkillManifest;
		content: string;
		audit: AuditReport;
		overwrite: boolean;
		urlSource: string;
		legacy: boolean;
	}): Promise<ImportResult> {
		const { manifest, audit, legacy } = input;
		const name = manifest.name;
		if (byteLength(input.content) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "内容超过 256 KiB");
		track("skill_import", name, input.urlSource || "local");
		if (audit.status === "blocked") {
			track("skill_blocked", name, input.urlSource || "local", audit.reasons.map((reason) => reason.rule).join(","));
			throw new SkillApiError(422, "audit_blocked", `审计未通过：${audit.reasons[0]?.message ?? "运行时不受支持"}`, {
				audit,
			});
		}
		const existing = getSkillRow(sql, name);
		if (existing && existing.contentHash && existing.contentHash !== audit.hash && !input.overwrite) {
			throw new SkillApiError(409, "name_conflict", "同名技能内容不同，需要 overwrite=1 才能覆盖");
		}
		if (existing && !existing.contentHash && !input.overwrite) {
			throw new SkillApiError(409, "name_conflict", "同名技能已存在，需要 overwrite=1 才能覆盖");
		}
		const changed = !existing || existing.contentHash !== audit.hash;
		const nowIso = now().toISOString();
		putCachedAudit(sql, {
			hash: audit.hash,
			rulesVersion: RULES_VERSION,
			status: audit.status,
			report: JSON.stringify(audit),
			auditedAt: audit.auditedAt,
		});
		if (changed) {
			upsertSkill(sql, {
				name,
				description: manifest.description,
				content: input.content,
				version: manifest.version,
				source: manifest.source || input.urlSource || "local",
				author: manifest.author,
				license: manifest.license,
				runtime: manifest.runtime,
				tags: manifest.tags,
				contentHash: audit.hash,
				auditStatus: audit.status,
				auditReport: JSON.stringify(audit),
				manifest: JSON.stringify(manifest),
				createdAt: existing?.createdAt ?? nowIso,
				updatedAt: nowIso,
			});
			track("skill_install", name, legacy ? "import-url" : "import");
		}
		return {
			ok: true,
			installed: true,
			changed,
			name,
			version: manifest.version,
			description: manifest.description,
			source: manifest.source || input.urlSource || "local",
			contentHash: audit.hash,
			audit,
		};
	}

	/** 既有 `GET /skills` 兼容：字段只增不改；新增 lastInvokedAt（NERE-59）。 */
	function listCompat(): { skills: Record<string, unknown>[] } {
		const invoked = lastInvokedMap(sql);
		return {
			skills: listSkillRows(sql).map((row) => ({
				name: row.name,
				description: row.description,
				content: row.content,
				created_at: row.createdAt,
				version: row.version,
				source: row.source,
				author: row.author,
				runtime: coerceRuntime(row.runtime),
				tags: tagList(row.tags),
				contentHash: row.contentHash,
				auditStatus: row.auditStatus,
				updated_at: row.updatedAt,
				lastInvokedAt: invoked[row.name] ?? null,
			})),
		};
	}

	/**
	 * 手工粘贴（兼容旧 `POST /skills`）：先审计再落库，大小沿用 256 KiB 上限。
	 * blocked 内容仍写入（旧接口语义），但状态为 blocked，不会进入提示词索引。
	 */
	async function addManual(input: { name: string; description: string; content: string }): Promise<void> {
		if (byteLength(input.content) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "内容超过 256 KiB");
		const manifest = synthesizeManifest({
			name: input.name,
			description: input.description,
			runtime: "prompt",
		});
		const nowIso = now().toISOString();
		const report = await auditSkill({
			manifest,
			content: input.content,
			filename: "SKILL.md",
			exemptMeta: true,
			auditSource: "local",
			auditedAt: nowIso,
		});
		putCachedAudit(sql, {
			hash: report.hash,
			rulesVersion: RULES_VERSION,
			status: report.status,
			report: JSON.stringify(report),
			auditedAt: report.auditedAt,
		});
		upsertManualSkill(
			sql,
			{
				...input,
				contentHash: report.hash,
				auditStatus: report.status,
				auditReport: JSON.stringify(report),
				manifest: JSON.stringify(manifest),
			},
			nowIso,
		);
	}

	function remove(name: string): void {
		deleteSkill(sql, name);
	}

	function community(): CommunityResponse {
		return {
			source: "https://github.com/badlogic/pi-skills",
			skills: COMMUNITY_SKILLS.map((item) => ({
				...item,
				url: `${COMMUNITY_RAW_BASE}/${item.name}/SKILL.md`,
				runtime: "other" as SkillRuntime,
				audit_status: "blocked" as const,
				audit: {
					status: "blocked" as const,
					reasons: [
						{
							rule: "M3",
							level: "blocked" as const,
							message: item.needsLocal
								? "需要本机运行时可执行能力（命令行/子系统），托管环境无法运行"
								: "依赖托管环境未提供的宿主能力，安装后无法执行",
						},
					],
					detected: { runtime: "other" as SkillRuntime, network: [], tools: [] },
					auditedAt: now().toISOString(),
					hash: "",
					rulesVersion: RULES_VERSION,
					auditSource: "catalog" as const,
				},
			})),
		};
	}

	/** audit=blocked 视图要能看到 8 条社区技能（验收 9）：转成 Hub 条目，不可安装。 */
	function communityHubEntries(): HubSkill[] {
		return community().skills.map((skill) => ({
			name: skill.name,
			version: "0.0.0",
			description: skill.description,
			author: "badlogic",
			source: community().source,
			license: "UNLICENSED",
			runtime: "other",
			tags: [],
			requires: { tools: [], bindings: [], network: [] },
			contentHash: "",
			installed: false,
			audit: skill.audit,
			origin: "remote",
		}));
	}

	function metrics(daysRaw: unknown): MetricsResponse {
		const days = Math.min(METRICS_MAX_DAYS, Math.max(1, Math.floor(Number(daysRaw ?? 7)) || 7));
		const since = now().getTime() - days * 86_400_000;
		const counts = eventCounts(sql, since);
		const installOk = counts.skill_install ?? 0;
		const installBlocked = counts.skill_blocked ?? 0;
		const installed = countSkills(sql);
		return {
			days,
			since,
			hubViews: counts.skill_hub_view ?? 0,
			installOk,
			installBlocked,
			blockedRatio: installOk + installBlocked ? installBlocked / (installOk + installBlocked) : 0,
			installed,
			called7d: invokedNames(sql, since).length,
		};
	}

	return {
		hub,
		auditFor,
		importSkill,
		listCompat,
		addManual,
		remove,
		community,
		metrics,
		track,
		/** 供 worker.ts 的 load_skill / 显式技能调用写入同一套事件（NERE-59）。 */
		trackCall: (name: string, kind: "loaded" | "invoked") =>
			track(kind === "loaded" ? "skill_loaded" : "skill_invoked", name, kind),
	};
}

export type SkillService = {
	hub(query?: HubQuery): Promise<HubResponse>;
	auditFor(name: string): Promise<{ name: string; version: string; contentHash: string; source: string; audit: AuditReport }>;
	importSkill(body: unknown): Promise<ImportResult>;
	listCompat(): { skills: Record<string, unknown>[] };
	addManual(input: { name: string; description: string; content: string }): Promise<void>;
	remove(name: string): void;
	community(): CommunityResponse;
	metrics(daysRaw: unknown): MetricsResponse;
	track(type: SkillEventType, name: string, source?: string, meta?: string): void;
	trackCall(name: string, kind: "loaded" | "invoked"): void;
};

/**
 * 识别消息开头的「/技能名」（v0.23.0）：命中已安装且未 blocked 的技能时返回正文与去掉前缀的正文。
 * 显式调用会写 `skill_invoked` 埋点；任何读取失败都按「未命中」处理，不阻塞对话。
 */
export function parseSkillInvocation(
	sql: SqlHandle,
	message: string,
): { name: string; content: string; rest: string } | null {
	const trimmed = message.trimStart();
	if (!trimmed.startsWith("/")) return null;
	const match = /^\/(\S{1,60})(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	try {
		const row = getSkillRow(sql, match[1]!);
		if (!row || row.auditStatus === "blocked") return null;
		trackSkillCall(sql, row.name, "invoked");
		return { name: row.name, content: row.content, rest: (match[2] ?? "").trim() };
	} catch {
		return null;
	}
}

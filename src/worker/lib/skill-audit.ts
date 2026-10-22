/**
 * 技能审计引擎（NERE-55，契约 `docs/skill-hub-contract.md` §4）。
 *
 * 纯函数：只依赖入参与常量，不读 DO / env / 网络，可直接单测。
 * 唯一异步点是 `crypto.subtle.digest`（Workers 与 Node 22 都有，比纯 JS SHA-256 快一个量级）。
 * 同一组 (manifest, content) 在同一 rulesVersion 下必须产出完全相同的 reasons 顺序。
 */

export type SkillRuntime = "prompt" | "javascript" | "typescript" | "python" | "shell" | "binary" | "other";
export type AuditStatus = "pass" | "warn" | "blocked";
export type AuditSource = "local" | "catalog";

export interface AuditReason {
	rule: string;
	level: Exclude<AuditStatus, "pass">;
	message: string;
	evidence?: string;
}

export interface AuditDetected {
	runtime: SkillRuntime;
	network: string[];
	tools: string[];
}

export interface AuditReport {
	status: AuditStatus;
	reasons: AuditReason[];
	detected: AuditDetected;
	auditedAt: string;
	hash: string;
	rulesVersion: number;
	auditSource: AuditSource;
}

export interface SkillSignature {
	alg: "ed25519";
	keyId: string;
	sig: string;
}

export interface SkillRequires {
	tools: string[];
	bindings: string[];
	network: string[];
}

export interface SkillManifest {
	schemaVersion: 1;
	name: string;
	version: string;
	description: string;
	author: string;
	source: string;
	license: string;
	runtime: SkillRuntime;
	tags: string[];
	requires: SkillRequires;
	contentHash?: string;
	signature?: SkillSignature;
	entry?: string;
	entrySource?: string;
	homepage?: string;
	publishedAt?: string;
}

export const RULES_VERSION = 1;

/** 可安装运行时；其余恒 blocked。 */
export const INSTALLABLE_RUNTIMES: readonly SkillRuntime[] = ["prompt", "javascript", "typescript"];
/** manifest 的 runtime 枚举（含恒 blocked 的四类）。 */
export const SKILL_RUNTIMES: readonly SkillRuntime[] = [
	"prompt",
	"javascript",
	"typescript",
	"python",
	"shell",
	"binary",
	"other",
];

/** 可声明工具白名单（契约 §2.3）：以 `src/worker.ts` 的 TOOL_CATEGORY 为准。 */
export const TOOL_WHITELIST: readonly string[] = [
	"now",
	"recall",
	"list_skills",
	"load_skill",
	"read_file",
	"list_files",
	"kb_search",
	"kb_list",
	"web_search",
	"web_fetch_page",
	"http_fetch",
	"update_plan",
	"remember",
	"kb_add",
	"kb_delete",
	"write_file",
	"share_file",
	"share_conversation",
];

/** 明确禁止声明/调用的工具：自安装、递归执行、子代理放大、交互阻塞、工具面泄露、会话编排。 */
export const FORBIDDEN_TOOLS: readonly string[] = [
	"install_skill",
	"codemode",
	"dispatch_tasks",
	"ask_user",
	"tool_search",
	"set_goal",
	"complete_goal",
	"report_goal",
];

const TOOL_SET = new Set(TOOL_WHITELIST);
const FORBIDDEN_SET = new Set(FORBIDDEN_TOOLS);

export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export const MANIFEST_MAX_BYTES = 16 * 1024;
export const CONTENT_MAX_BYTES = 256 * 1024;
export const IMPORT_CONTENT_MAX_BYTES = 512 * 1024;
export const IMPORT_REDIRECT_LIMIT = 3;
export const IMPORT_TIMEOUT_MS = 10_000;
export const CATALOG_MAX_ENTRIES = 200;
export const CATALOG_MAX_BYTES = 256 * 1024;

const MANIFEST_FIELDS = new Set([
	"schemaVersion",
	"name",
	"version",
	"description",
	"author",
	"source",
	"license",
	"runtime",
	"tags",
	"requires",
	"contentHash",
	"signature",
	"entry",
	"entrySource",
	"homepage",
	"publishedAt",
]);

const NON_JS_EXECUTABLE = /\.(?:py|pyw|sh|bash|zsh|rb|php|pl|ps1|bat|cmd|awk|lua)$/i;
const BINARY_EXT = /\.(?:exe|dll|dylib|so|node|wasm|bin|pyc|class|jar)$/i;
const JS_ENTRY_EXT = /\.(?:js|mjs|cjs)$/i;

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
	{ re: /sk-[A-Za-z0-9]{20,}/, label: "OpenAI/DeepSeek 风格的 sk- 密钥" },
	{ re: /ghp_[A-Za-z0-9]{36}/, label: "GitHub 个人访问令牌（ghp_）" },
	{ re: /AKIA[0-9A-Z]{16}/, label: "AWS Access Key（AKIA）" },
	{ re: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: "Slack token（xox*）" },
];

const PROMPT_BLOCKED_FENCES = new Set(["python", "bash", "sh", "shell", "zsh", "powershell", "ps1"]);

/* ---------------- 基础工具 ---------------- */

const encoder = new TextEncoder();

export function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/** `sha256:<64 位小写十六进制>`。 */
export async function sha256Content(content: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(content));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `sha256:${hex}`;
}

/**
 * 去掉 YAML frontmatter，返回正文（原样，不做 trim / 换行归一化）。
 * 契约 §2.5：prompt 技能的哈希对象就是这个返回值。
 */
export function stripFrontmatter(text: string): string {
	const match = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
	return match ? text.slice(match[0].length) : text;
}

/** 解析 SKILL.md 的 YAML frontmatter（只取 name / description，兼容现有社区技能）。 */
export function parseFrontmatter(text: string): { name: string; description: string; body: string } {
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { name: "", description: "", body: text };
	const header = match[1] ?? "";
	const read = (key: string) => {
		const hit = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(header);
		return hit ? (hit[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
	};
	return { name: read("name"), description: read("description"), body: text.slice(match[0].length) };
}

/** 把任意展示名压成合法技能名（小写、连字符、≤40）。压不出来时返回空串。 */
export function slugifySkillName(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");
	return SKILL_NAME_RE.test(slug) ? slug : "";
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 去掉 JS 注释；字符串字面量原样保留（URL 扫描要用）。 */
export function stripJsComments(source: string): string {
	let out = "";
	for (let i = 0; i < source.length; ) {
		const char = source[i]!;
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			out += char;
			i += 1;
			while (i < source.length) {
				const inner = source[i]!;
				out += inner;
				i += 1;
				if (inner === "\\") {
					if (i < source.length) {
						out += source[i];
						i += 1;
					}
					continue;
				}
				if (inner === char) break;
			}
			continue;
		}
		out += char;
		i += 1;
	}
	return out;
}

/** 去掉注释与字符串内容（把字面量替换成空串），用于标识符匹配，避免字符串里的同名词误报。 */
export function stripJsStrings(source: string): string {
	let out = "";
	for (let i = 0; i < source.length; ) {
		const char = source[i]!;
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			i += 1;
			while (i < source.length) {
				const inner = source[i]!;
				i += 1;
				if (inner === "\\") {
					i += 1;
					continue;
				}
				if (inner === char) break;
			}
			out += '""';
			continue;
		}
		out += char;
		i += 1;
	}
	return out;
}

/* ---------------- URL / 主机校验（X1 / X2 / M6 / C3 / C4） ---------------- */

function isIpLiteral(host: string): boolean {
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host.split(".").every((part) => Number(part) <= 255);
	return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
}

function isPrivateIpv4(host: string): boolean {
	const parts = host.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function isPrivateHost(host: string): boolean {
	const lower = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) return true;
	if (lower === "::1" || lower === "0.0.0.0" || lower === "::") return true;
	if (/^f[cd][0-9a-f]{2}:/i.test(lower) || /^fe80:/i.test(lower)) return true;
	return isPrivateIpv4(lower);
}

/** 网络声明只接受主机名/最左通配；非法即 M6。 */
export function isValidNetworkHost(raw: string): boolean {
	const host = raw.trim().toLowerCase();
	if (!host || host.length > 253) return false;
	if (host === "*" || /[\s/\\@?#]/.test(host) || host.includes(":") || host.includes("..")) return false;
	const body = host.startsWith("*.") ? host.slice(2) : host;
	if (host.includes("*") && !host.startsWith("*.")) return false;
	if (!body || isIpLiteral(body) || isPrivateHost(body)) return false;
	if (!body.includes(".")) return false; // 裸 TLD
	const labels = body.split(".");
	if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
	const tld = labels.at(-1) ?? "";
	return /^[a-z]{2,63}$/.test(tld);
}

/** 声明域名是否覆盖某个实际主机（通配只匹配最左一级）。 */
export function networkCovers(declared: string, host: string): boolean {
	const target = host.toLowerCase();
	const rule = declared.trim().toLowerCase();
	if (rule === target) return true;
	if (rule.startsWith("*.")) {
		const suffix = rule.slice(2);
		if (!target.endsWith(`.${suffix}`)) return false;
		return target.slice(0, -(suffix.length + 1)).indexOf(".") === -1;
	}
	return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; rule: string; message: string; evidence: string };

/** 导入 URL 的 X1/X2 校验；重定向的每一跳都要再调用一次。 */
export function checkImportUrl(raw: string): UrlCheck {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, rule: "X1", message: "导入地址必须是合法的 HTTPS URL", evidence: truncate(raw, 120) };
	}
	if (url.protocol !== "https:") {
		return { ok: false, rule: "X1", message: "导入地址必须是 HTTPS", evidence: truncate(raw, 120) };
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIpLiteral(host) || isPrivateHost(host)) {
		return { ok: false, rule: "X2", message: "导入地址指向内网、环回或 IP 字面量，已拒绝", evidence: truncate(host, 120) };
	}
	return { ok: true, url };
}

/* ---------------- manifest 校验（M1 / M2） ---------------- */

export type ManifestParse = { ok: true; manifest: SkillManifest } | { ok: false; reason: AuditReason };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

function normalizeRuntime(value: string): SkillRuntime {
	return (SKILL_RUNTIMES as readonly string[]).includes(value) ? (value as SkillRuntime) : "other";
}

/** 校验显式 skill.json；未知字段直接 400（避免拼写错误静默生效）。 */
export function parseManifest(input: unknown): ManifestParse {
	if (!isRecord(input)) {
		return { ok: false, reason: { rule: "M1", level: "blocked", message: "manifest 必须是 JSON 对象" } };
	}
	const unknown = Object.keys(input).filter((key) => !MANIFEST_FIELDS.has(key));
	if (unknown.length) {
		return {
			ok: false,
			reason: { rule: "M1", level: "blocked", message: "manifest 含未知字段", evidence: truncate(unknown.join(", "), 120) },
		};
	}
	const fail = (message: string, evidence?: string): ManifestParse => ({
		ok: false,
		reason: { rule: "M1", level: "blocked", message, ...(evidence ? { evidence: truncate(evidence, 120) } : {}) },
	});
	if (input.schemaVersion !== 1) return fail("manifest.schemaVersion 必须是 1");
	const name = typeof input.name === "string" ? input.name : "";
	if (!SKILL_NAME_RE.test(name)) return fail("技能名不合法：需匹配 ^[a-z][a-z0-9-]{1,39}$", name);
	const version = typeof input.version === "string" ? input.version : "";
	if (!VERSION_RE.test(version) || version.length > 32) return fail("version 必须是 SemVer 2.0（≤32 字符）", version);
	const description = typeof input.description === "string" ? input.description : "";
	if (!description.trim() || description.length > 200) return fail("description 必填且不超过 200 字符");
	const author = typeof input.author === "string" ? input.author : "";
	if (!author.trim() || author.length > 80) return fail("author 必填且不超过 80 字符");
	const source = typeof input.source === "string" ? input.source : "";
	if (source !== "local") {
		if (!source.startsWith("https://") || source.length > 512) return fail("source 必须是 HTTPS URL 或 local", source);
	}
	const license = typeof input.license === "string" ? input.license : "";
	if (!license.trim() || license.length > 64) return fail("license 必填且不超过 64 字符", license);
	const runtimeRaw = typeof input.runtime === "string" ? input.runtime : "";
	if (!runtimeRaw) return fail("runtime 必填");
	const runtime = (SKILL_RUNTIMES as readonly string[]).includes(runtimeRaw) ? (runtimeRaw as SkillRuntime) : "other";
	const tagsRaw = stringArray(input.tags);
	if (!tagsRaw || tagsRaw.length > 8) return fail("tags 必须是 0–8 个字符串");
	const tags = [...new Set(tagsRaw)];
	if (tags.some((tag) => !TAG_RE.test(tag))) return fail("tag 不合法：需匹配 ^[a-z0-9][a-z0-9-]{0,23}$");
	if (!isRecord(input.requires)) return fail("requires 必填");
	const tools = stringArray(input.requires.tools);
	const bindings = stringArray(input.requires.bindings);
	const network = stringArray(input.requires.network);
	if (!tools || tools.length > 16) return fail("requires.tools 必须是 0–16 个字符串");
	if (!bindings) return fail("requires.bindings 必须是数组");
	if (!network || network.length > 16) return fail("requires.network 必须是 0–16 个字符串");
	if (input.entry !== undefined && typeof input.entry !== "string") return fail("entry 必须是相对路径字符串");
	if (input.entrySource !== undefined && typeof input.entrySource !== "string") return fail("entrySource 必须是字符串");
	if (input.homepage !== undefined && (typeof input.homepage !== "string" || !input.homepage.startsWith("https://"))) {
		return fail("homepage 必须是 HTTPS URL");
	}
	if (input.publishedAt !== undefined && typeof input.publishedAt !== "string") return fail("publishedAt 必须是 ISO 8601 字符串");
	if (input.contentHash !== undefined) {
		if (typeof input.contentHash !== "string" || !HASH_RE.test(input.contentHash)) return fail("contentHash 必须是 sha256:<64 hex>");
	}
	let signature: SkillSignature | undefined;
	if (input.signature !== undefined) {
		const sig = input.signature;
		if (
			!isRecord(sig) ||
			sig.alg !== "ed25519" ||
			typeof sig.keyId !== "string" ||
			!sig.keyId ||
			sig.keyId.length > 64 ||
			typeof sig.sig !== "string" ||
			!sig.sig ||
			sig.sig.length > 128
		) {
			return fail("signature 结构非法（需 {alg:'ed25519',keyId≤64,sig≤128}）");
		}
		signature = { alg: "ed25519", keyId: sig.keyId, sig: sig.sig };
	}
	const manifest: SkillManifest = {
		schemaVersion: 1,
		name,
		version,
		description,
		author,
		source,
		license,
		runtime,
		tags,
		requires: { tools, bindings, network },
		...(input.contentHash ? { contentHash: input.contentHash } : {}),
		...(signature ? { signature } : {}),
		...(typeof input.entry === "string" ? { entry: input.entry } : {}),
		...(typeof input.entrySource === "string" ? { entrySource: input.entrySource } : {}),
		...(typeof input.homepage === "string" ? { homepage: input.homepage } : {}),
		...(typeof input.publishedAt === "string" ? { publishedAt: input.publishedAt } : {}),
	};
	return { ok: true, manifest };
}

/** 无 manifest 的旧技能合成 manifest（契约 §2.6）；`meta.exempt` 为存量行豁免 I3。 */
export function synthesizeManifest(input: {
	name: string;
	description: string;
	runtime?: SkillRuntime;
	source?: string;
	frontmatter?: { name?: string; description?: string };
}): SkillManifest {
	const name = slugifySkillName(input.frontmatter?.name || input.name) || slugifySkillName(input.name) || "imported-skill";
	const description = (input.frontmatter?.description || input.description || "（未提供描述）").slice(0, 200);
	return {
		schemaVersion: 1,
		name,
		version: "0.0.0",
		description,
		author: "",
		source: input.source ?? "",
		license: "UNLICENSED",
		runtime: input.runtime ?? "prompt",
		tags: [],
		requires: { tools: [], bindings: [], network: [] },
	};
}

/* ---------------- 运行时判定与代码扫描 ---------------- */

function detectRuntimeFromName(filename: string | undefined): SkillRuntime | null {
	if (!filename) return null;
	const lower = filename.toLowerCase();
	if (NON_JS_EXECUTABLE.test(lower)) return /\.sh$|\.bash$|\.zsh$/i.test(lower) ? "shell" : "python";
	if (BINARY_EXT.test(lower)) return "binary";
	if (/\.ts$/i.test(lower)) return "typescript";
	if (JS_ENTRY_EXT.test(lower)) return "javascript";
	return null;
}

function shebangRuntime(text: string): SkillRuntime | null {
	const first = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
	if (!first.startsWith("#!")) return null;
	const lower = first.toLowerCase();
	if (/\bpython/.test(lower)) return "python";
	if (/\b(?:ba|z)?sh\b/.test(lower) && !/\bnode\b/.test(lower)) return "shell";
	if (/\bnode\b|\bdeno\b|\bbun\b/.test(lower)) return "javascript";
	return "other";
}

/** 没有 manifest 时的启发式：只认 shebang、fence language tag、入口扩展名，不按正文裸词。 */
export function detectRuntime(content: string, filename?: string): SkillRuntime {
	const byName = detectRuntimeFromName(filename);
	if (byName) return byName;
	const byShebang = shebangRuntime(content);
	if (byShebang) return byShebang;
	const fences = content.match(/```([A-Za-z0-9+#._-]*)/g) ?? [];
	const tags = fences.map((fence) => fence.slice(3).toLowerCase()).filter(Boolean);
	if (tags.some((tag) => tag === "python" || tag === "py")) return "python";
	if (tags.some((tag) => tag === "bash" || tag === "sh" || tag === "shell" || tag === "zsh")) return "shell";
	return "prompt";
}

const TOOL_CALL_RE = /\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function scanToolCalls(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(TOOL_CALL_RE)) if (match[1]) found.push(match[1]);
	return [...new Set(found)].sort();
}

function scanInlineTools(content: string): string[] {
	const found: string[] = [];
	for (const match of content.matchAll(/`([^`\n]{1,40})`/g)) {
		const name = (match[1] ?? "").trim();
		if (TOOL_SET.has(name) || FORBIDDEN_SET.has(name)) found.push(name);
	}
	return [...new Set(found)].sort();
}

function scanHosts(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
		const host = (match[1] ?? "").toLowerCase();
		if (host && !isIpLiteral(host)) found.push(host);
	}
	return [...new Set(found)].sort();
}

/* ---------------- 审计主函数 ---------------- */

export type AuditInput = {
	/** 显式 manifest；为空表示无 manifest 的旧技能（走合成 manifest）。 */
	manifest?: SkillManifest | null;
	/** prompt 为 SKILL.md 原文（含 frontmatter），js/ts 为入口文件原文。 */
	content: string;
	/** 入口文件名（index.js / main.py），用于 L1/L3/L4/L5 与运行时启发式。 */
	filename?: string;
	/** 额外文件名（目录条目里的支撑文件），只参与 L3/L4。 */
	extraNames?: string[];
	/** 存量 skills 行：豁免 I3 与 I1。 */
	exemptMeta?: boolean;
	/** 请求带的 expectedHash；与重算值不一致 → I1 blocked。 */
	expectedHash?: string;
	/** 目录条目/安装路径必须带哈希；缺失 → I1 blocked。 */
	requireHash?: boolean;
	/** 安装时内容哈希与目录快照不一致。 */
	hashMismatch?: boolean;
	auditSource?: AuditSource;
	/** 审计时间注入，便于确定性测试。 */
	auditedAt?: string;
};

/** 规则的固定顺序（同级别内按规则 ID 字典序，见契约 §4.3）。 */
const RULE_ORDER = [
	"M1", "M2", "M3", "M4", "M5", "M6", "M7",
	"L1", "L2", "L3", "L4", "L5",
	"C1", "C2", "C3", "C4", "C5", "C6", "C7",
	"I1", "I2", "I3",
	"S1", "S2", "S3",
	"X1", "X2", "X3", "X4",
];

function sortReasons(reasons: AuditReason[]): AuditReason[] {
	const levelRank: Record<AuditReason["level"], number> = { blocked: 0, warn: 1 };
	return [...reasons].sort((a, b) => {
		const byLevel = levelRank[a.level] - levelRank[b.level];
		if (byLevel !== 0) return byLevel;
		return (RULE_ORDER.indexOf(a.rule) === -1 ? 99 : RULE_ORDER.indexOf(a.rule)) -
			(RULE_ORDER.indexOf(b.rule) === -1 ? 99 : RULE_ORDER.indexOf(b.rule)) ||
			a.rule.localeCompare(b.rule);
	});
}

export async function auditSkill(input: AuditInput): Promise<AuditReport> {
	const reasons = new Map<string, AuditReason>();
	const add = (rule: string, level: AuditReason["level"], message: string, evidence?: string) => {
		const existing = reasons.get(rule);
		if (!existing) reasons.set(rule, { rule, level, message, ...(evidence ? { evidence: truncate(evidence, 120) } : {}) });
		else if (existing.level === "warn" && level === "blocked") {
			existing.level = "blocked";
			existing.message = message;
			if (evidence) existing.evidence = truncate(evidence, 120);
		}
	};

	const rawContent = input.content ?? "";
	const manifest = input.manifest ?? null;
	const runtime: SkillRuntime = manifest
		? normalizeRuntime(manifest.runtime)
		: detectRuntime(rawContent, input.filename);
	const promptBody = stripFrontmatter(rawContent);
	const hashObject = runtime === "prompt" || manifest?.runtime === "prompt" ? promptBody : rawContent;
	const hash = await sha256Content(hashObject);

	const usedTools = new Set<string>();
	const usedHosts = new Set<string>();
	const declaredTools = new Set(manifest?.requires.tools ?? []);
	const declaredNetwork = new Set(manifest?.requires.network ?? []);

	if (manifest) {
		// M2 体积
		if (byteLength(JSON.stringify(manifest)) > MANIFEST_MAX_BYTES) add("M2", "blocked", "manifest 超过 16 KiB");
		if (byteLength(rawContent) > CONTENT_MAX_BYTES) add("M2", "blocked", "技能内容超过 256 KiB");
		// M3 运行时
		if (!INSTALLABLE_RUNTIMES.includes(runtime)) {
			add("M3", "blocked", `运行时 ${runtime} 不受支持：Worker 只能执行 JS/TS`, runtime);
		}
		// M4 binding
		if (manifest.requires.bindings.length > 0) {
			add("M4", "blocked", "技能不能申请 binding", manifest.requires.bindings.join(", "));
		}
		// M5 工具声明
		for (const tool of manifest.requires.tools) {
			if (FORBIDDEN_SET.has(tool) || !TOOL_SET.has(tool) || tool.startsWith("mcp__")) {
				add("M5", "blocked", "声明了不可用或禁止的工具", tool);
			}
		}
		// M6 网络声明
		for (const host of manifest.requires.network) {
			if (!isValidNetworkHost(host)) add("M6", "blocked", "网络声明非法（只接受域名或最左一级通配）", host);
		}
		// M7 密钥
		const manifestText = JSON.stringify(manifest);
		for (const { re, label } of SECRET_PATTERNS) {
			const hit = re.exec(rawContent) ?? re.exec(manifestText);
			if (hit) add("M7", "blocked", `疑似密钥泄露：${label}`, `${hit[0].slice(0, 6)}…`);
		}
		// L1 entry 与 runtime
		if (runtime === "javascript" || runtime === "typescript") {
			if (!manifest.entry || !JS_ENTRY_EXT.test(manifest.entry)) {
				add("L1", "blocked", `${runtime} 技能必须提供 .js 入口`, manifest.entry ?? "(缺 entry)");
			}
		} else if (manifest.entry && runtime === "prompt") {
			add("L1", "blocked", "prompt 技能不能带可执行入口", manifest.entry);
		}
		// L2 TS 编译产物
		if (runtime === "typescript") {
			if (!manifest.entry || !/\.js$/i.test(manifest.entry)) add("L2", "blocked", "TypeScript 技能缺少编译后的 .js 入口");
			if (manifest.entrySource && !/\.ts$/i.test(manifest.entrySource)) {
				add("L2", "blocked", "entrySource 必须指向 .ts 源码", manifest.entrySource);
			}
		}
		// I1 哈希
		if (input.requireHash && !input.exemptMeta && !manifest.contentHash) {
			add("I1", "blocked", "目录条目缺少 contentHash");
		}
		if (input.hashMismatch || (input.expectedHash && input.expectedHash !== hash)) {
			add("I1", "blocked", "内容哈希与预期不一致", input.expectedHash ?? "");
		}
		if (!input.exemptMeta && !input.requireHash && !input.expectedHash && !manifest.contentHash) {
			add("I1", "warn", "manifest 未带 contentHash，已由服务端重新计算", hash);
		}
		// I2 签名
		if (manifest.signature) add("I2", "warn", "签名未验证（v1 无信任根）", manifest.signature.keyId);
		// I3 元数据
		if (!input.exemptMeta) {
			const missing: string[] = [];
			if (manifest.version === "0.0.0") missing.push("version");
			if (manifest.license === "UNLICENSED") missing.push("license");
			if (!manifest.author.trim()) missing.push("author");
			if (!manifest.source.trim()) missing.push("source");
			if (missing.length) add("I3", "warn", `元数据不完整：${missing.join(" / ")} 缺失或为占位值`);
		}
	} else if (input.exemptMeta) {
		// 存量行由迁移固定 pass；这里仍按内容重审计，只是不因元数据占位值告警。
	}

	// L3 / L4 / L5：入口与支撑文件名（有 manifest 或无 manifest 都检查）
	const names = [input.filename, ...(input.extraNames ?? [])].filter((name): name is string => Boolean(name));
	for (const name of names) {
		const base = name.split("/").pop() ?? "";
		if (NON_JS_EXECUTABLE.test(base)) add("L3", "blocked", `包含非 JS 可执行文件 ${base}`, base);
		if (BINARY_EXT.test(base)) add("L4", "blocked", `包含二进制或不支持的产物 ${base}`, base);
	}
	if (BINARY_EXT.test(input.filename ?? "")) {
		// 扩展名已覆盖；这里只补魔数判定
	} else {
		const head = [...rawContent.slice(0, 8)].map((char) => char.charCodeAt(0));
		const magic =
			(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) ||
			(head[0] === 0x4d && head[1] === 0x5a) ||
			(head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) ||
			(head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) ||
			(head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d);
		if (magic) add("L4", "blocked", "内容命中原生二进制魔数");
	}
	const shebang = shebangRuntime(rawContent);
	const shebangLine = rawContent.slice(0, rawContent.indexOf("\n") === -1 ? rawContent.length : rawContent.indexOf("\n"));
	if (shebang && (runtime === "javascript" || runtime === "typescript") && !/\bnode\b/i.test(shebangLine)) {
		add("L5", "blocked", "入口 shebang 不是 JavaScript 解释器", shebangLine);
	} else if (shebang && shebang !== "javascript" && runtime !== "prompt") {
		add("L5", "blocked", "入口 shebang 不是 JavaScript 解释器", shebangLine);
	}

	if (runtime === "javascript" || runtime === "typescript") {
		const withStrings = stripJsComments(rawContent);
		const noStrings = stripJsStrings(rawContent);
		// C1 宿主 API
		if (/\bchild_process\b/.test(noStrings)) add("C1", "blocked", "使用了 Node 子进程能力（child_process）");
		if (/\bprocess\b/.test(noStrings)) add("C1", "blocked", "使用了宿主 process 对象");
		if (/\brequire\s*\(/.test(noStrings)) add("C1", "blocked", "使用了 require()");
		if (/\bfs\b/.test(noStrings)) add("C1", "blocked", "使用了宿主文件系统（fs）");
		// C2 动态加载 / 编译
		if (/\bimport\s*\(/.test(noStrings)) add("C2", "blocked", "使用了动态 import()");
		if (/^\s*import\s+[\w{*]/m.test(noStrings)) add("C2", "blocked", "使用了模块 import");
		if (/\bWebAssembly\b/.test(noStrings)) add("C2", "blocked", "使用了 WebAssembly");
		if (/\bnew\s+Worker\b/.test(noStrings)) add("C2", "blocked", "创建了 Worker 线程");
		if (/\bDeno\b/.test(noStrings)) add("C2", "blocked", "依赖 Deno 运行时");
		if (/\bBun\b/.test(noStrings)) add("C2", "blocked", "依赖 Bun 运行时");
		// 工具调用（C5 / C6）
		for (const tool of scanToolCalls(noStrings)) {
			usedTools.add(tool);
			if (FORBIDDEN_SET.has(tool)) add("C6", "blocked", `调用了禁用工具 ${tool}`, tool);
			else if (TOOL_SET.has(tool) && !declaredTools.has(tool)) add("C5", "warn", "使用了未声明的工具", tool);
		}
		// C3 网络使用
		for (const host of scanHosts(withStrings)) {
			usedHosts.add(host);
			const covered = [...declaredNetwork].some((rule) => networkCovers(rule, host));
			if (!covered) add("C3", "warn", "使用了未声明的网络域名", host);
		}
		// C4 声明未使用（代码/说明里找不到声明域名）
		if (manifest) {
			for (const host of declaredNetwork) {
				if (!rawContent.toLowerCase().includes(host.replace(/^\*\./, "").toLowerCase())) {
					add("C4", "warn", `声明了未使用的网络域名 ${host}`, host);
				}
			}
			// C7 声明未使用工具（仅 js/ts）
			for (const tool of declaredTools) {
				if (!new RegExp(`\\btools\\.${tool}\\s*\\(`).test(noStrings)) add("C7", "warn", `声明了未使用的工具 ${tool}`, tool);
			}
		}
	} else if (runtime === "prompt") {
		// S1 非 JS fence
		for (const match of rawContent.matchAll(/```([A-Za-z0-9+#._-]*)[ \t]*\r?\n?/g)) {
			const tag = (match[1] ?? "").toLowerCase();
			if (PROMPT_BLOCKED_FENCES.has(tag)) add("S1", "blocked", `提示词里包含 ${tag} 代码块：需要宿主机执行`, `\`\`\`${tag}`);
		}
		// S2 宿主命令：只认「真的在调命令」的行（python x.py / bash x.sh / sh -c / pip install …），
		// 不按裸词判定——「Python 不受支持」这类说明不能误伤。
		const commandLine = new RegExp(
			"^[ \\t]*(?:\\$[ \\t]*)?(?:" +
				"python3?[ \\t]+(?:-m[ \\t]+\\S+|[\\w./-]+\\.py\\b|-\\S+)" +
				"|(?:bash|zsh)[ \\t]+[\\w./-]+\\.(?:sh|bash|zsh)\\b" +
				"|sh[ \\t]+-c\\b" +
				"|pip3?[ \\t]+install\\b" +
				"|npm[ \\t]+(?:i|install)[ \\t]+-g\\b" +
				"|brew[ \\t]+install\\b" +
				"|apt(?:-get)?[ \\t]+install\\b" +
				")",
			"gim",
		);
		for (const match of rawContent.matchAll(commandLine)) {
			add("S2", "blocked", "提示词要求宿主执行命令", (match[0] ?? "").trim());
		}
		// S3 管道执行 / 远程安装
		if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/i.test(rawContent) || /\biex\s*\(\s*irm\b/i.test(rawContent)) {
			add("S3", "blocked", "提示词要求把远程脚本直接交给 shell 执行");
		}
		// 工具名（反引号）
		for (const tool of scanInlineTools(rawContent)) {
			usedTools.add(tool);
			if (FORBIDDEN_SET.has(tool)) add("C6", "blocked", `说明里要求调用禁用工具 ${tool}`, tool);
			else if (!declaredTools.has(tool)) add("C5", "warn", "说明里使用了未声明的工具", tool);
		}
		// C4 声明网络未在说明里出现
		if (manifest) {
			for (const host of declaredNetwork) {
				if (!rawContent.toLowerCase().includes(host.replace(/^\*\./, "").toLowerCase())) {
					add("C4", "warn", `声明了未使用的网络域名 ${host}`, host);
				}
			}
		}
	}

	const reportReasons = sortReasons([...reasons.values()]);
	const status: AuditStatus = reportReasons.some((reason) => reason.level === "blocked")
		? "blocked"
		: reportReasons.length
			? "warn"
			: "pass";

	return {
		status,
		reasons: reportReasons,
		detected: {
			runtime,
			network: [...new Set([...declaredNetwork, ...usedHosts])].sort(),
			tools: [...new Set([...declaredTools, ...usedTools])].sort(),
		},
		auditedAt: input.auditedAt ?? new Date().toISOString(),
		hash,
		rulesVersion: RULES_VERSION,
		auditSource: input.auditSource ?? "local",
	};
}

/** 目录条目的审计快照是否可信；不可信时按 I1 blocked 处理（fail closed）。 */
export function untrustedCatalogReason(message = "目录条目缺少审计快照或哈希不一致"): AuditReason {
	return { rule: "I1", level: "blocked", message };
}

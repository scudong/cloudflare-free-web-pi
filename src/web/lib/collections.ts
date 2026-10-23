import type {
	AllFileInfo,
	AutomationInfo,
	AutomationRunStatus,
	CustomToolInfo,
	FileInfo,
	KbDocInfo,
	KbHit,
	MemoryInfo,
	PromptInfo,
	RuleInfo,
	SessionListItem,
	ShareRecord,
	SkillInfo,
} from "../types";
import { automationScheduleLabel, parseAutomationSchedule } from "./automation-schedule";
import { formatNextRunAt } from "./format";

/**
 * Tolerant parsers for panel data (sessions / files / memories).
 * The backend contract may drift between versions (v1 vs v3), so field lookup is lenient:
 * unknown shapes degrade to empty lists instead of crashing the UI.
 */

/** 供其它解析器复用（如 lib/skill-hub.ts）：宽容读取对象 / 字符串 / 列表包装。 */
export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pickString(o: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
	}
	return 0;
}

export function arrayOf(raw: unknown, wrapperKeys: string[]): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isObject(raw)) {
		for (const key of wrapperKeys) {
			const v = raw[key];
			if (Array.isArray(v)) return v;
		}
	}
	return [];
}

/** GET /api/sessions → list of sessions (falls back to a synthetic current one when empty). */
export function parseSessions(raw: unknown): SessionListItem[] {
	const list = arrayOf(raw, ["sessions"]).filter(isObject);
	return list.map((entry, index) => ({
		id: pickString(entry, ["id", "sessionId", "session_id"]) || String(index + 1),
		title: pickString(entry, ["title", "name", "label"]) || `会话 ${index + 1}`,
		createdAt: pickString(entry, ["created_at", "createdAt", "updated_at"]),
		model: pickString(entry, ["model", "model_id"]) || undefined,
		// 分支来源（v0.32.0）
		parentId: pickString(entry, ["parent_id", "parentId"]) || undefined,
		forkAt: pickNumber(entry, ["fork_at", "forkAt"]) || undefined,
	}));
}

/** GET /api/files → workbench files. */
export function parseFiles(raw: unknown): FileInfo[] {
	const list = arrayOf(raw, ["files"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name", "filename", "file", "path"]),
		size: pickNumber(entry, ["size", "length", "bytes"]),
		updatedAt: pickString(entry, ["updated_at", "updatedAt", "created_at"]),
	}));
}

/**
 * GET /api/memories → memory library entries.
 * Entries without a usable id get a negative placeholder id (delete button hidden for those).
 */
export function parseMemories(raw: unknown): MemoryInfo[] {
	const list = arrayOf(raw, ["memories", "items"]).filter(isObject);
	return list.map((entry, index) => ({
		id: pickNumber(entry, ["id"]) || -(index + 1),
		content: pickString(entry, ["content", "text", "value"]),
		createdAt: pickString(entry, ["created_at", "createdAt", "updated_at"]),
		source: pickString(entry, ["source"]) || undefined,
	}));
}

/** GET /api/automations → scheduled prompts. */
export function parseAutomations(raw: unknown): AutomationInfo[] {
	const list = arrayOf(raw, ["automations"]).filter(isObject);
	return list.map((entry, index) => {
		// NERE-65：保留原始调度与会话，编辑弹窗要回填；文案仍由同一份函数生成。
		const schedule = parseAutomationSchedule(entry.schedule);
		const next = typeof entry.next_run_at === "number" ? entry.next_run_at : undefined;
		return {
			id: pickString(entry, ["id"]) || `a${index}`,
			name: pickString(entry, ["name", "title"]) || `任务 ${index + 1}`,
			prompt: pickString(entry, ["prompt", "message"]),
			scheduleLabel: automationScheduleLabel(schedule),
			nextLabel: formatNextRunAt(next),
			enabled: entry.enabled !== 0 && entry.enabled !== false,
			schedule,
			sessionId: pickString(entry, ["session_id", "sessionId"]) || undefined,
			lastRunAt: pickLastRunAt(entry),
			lastStatus: pickLastStatus(entry),
			lastError: pickString(entry, ["last_error", "lastError"]) || undefined,
		};
	});
}

/** 上次运行结果（NERE-68 2b）：只认契约三值；NULL / 缺失 / 未知值一律 undefined（不猜状态）。 */
function pickLastStatus(entry: Record<string, unknown>): AutomationRunStatus | undefined {
	const value = pickString(entry, ["last_status", "lastStatus"]).toLowerCase();
	return value === "ok" || value === "failed" || value === "deferred" ? value : undefined;
}

/** 上次执行时间（NERE-68）：缺失 / null / 非法值都当「没有」，避免列表渲染假时间。 */
function pickLastRunAt(entry: Record<string, unknown>): number | undefined {
	for (const key of ["last_run_at", "lastRunAt"]) {
		const value = entry[key];
		const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
	}
	return undefined;
}

/**
 * 上次使用时间（NERE-59）：三种状态必须区分开，不能都塌成 0。
 * 字段缺失 → `undefined`（无埋点数据，卡片不渲染这一行）；显式 null → `null`（从未使用）。
 */
function pickLastInvoked(entry: Record<string, unknown>): number | null | undefined {
	const keys = ["lastInvokedAt", "last_invoked_at"];
	const present = keys.some((key) => key in entry);
	if (!present) return undefined;
	for (const key of keys) {
		const value = entry[key];
		if (value === null) return null;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	}
	return null;
}

/** 审计结论（NERE-59）：只认契约里的三个值，其它 / 缺失一律 undefined（不猜成 pass）。 */
function pickAuditStatus(entry: Record<string, unknown>): SkillInfo["auditStatus"] {
	const value = pickString(entry, ["auditStatus", "audit_status"]).toLowerCase();
	return value === "pass" || value === "warn" || value === "blocked" ? value : undefined;
}

/** GET /api/skills → skill list. */
export function parseSkills(raw: unknown): SkillInfo[] {
	const list = arrayOf(raw, ["skills"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name"]) || "未命名技能",
		description: pickString(entry, ["description"]),
		content: pickString(entry, ["content"]),
		// NERE-59：卡片上的运行时 / 审计 / 上次使用；老服务端没有这些字段时降级为不渲染。
		...(pickString(entry, ["runtime"]) ? { runtime: pickString(entry, ["runtime"]) } : {}),
		auditStatus: pickAuditStatus(entry),
		createdAt: pickString(entry, ["created_at", "createdAt"]) || undefined,
		lastInvokedAt: pickLastInvoked(entry),
	}));
}

/** GET /api/prompts → 提示模板。 */
export function parsePrompts(raw: unknown): PromptInfo[] {
	const list = arrayOf(raw, ["prompts"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name"]) || "未命名模板",
		description: pickString(entry, ["description"]),
		content: pickString(entry, ["content"]),
	}));
}

/** GET /api/custom-tools → 自定义工具。 */
export function parseCustomTools(raw: unknown): CustomToolInfo[] {
	const list = arrayOf(raw, ["tools"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name"]) || "未命名工具",
		description: pickString(entry, ["description"]),
		parameters: pickString(entry, ["parameters"]) || '{"type":"object","properties":{}}',
		code: pickString(entry, ["code"]),
		createdAt: pickString(entry, ["created_at", "createdAt"]),
	}));
}

/** GET /api/rules → 规则文件。 */
export function parseRules(raw: unknown): RuleInfo[] {
	const list = arrayOf(raw, ["rules"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name"]) || "未命名规则",
		content: pickString(entry, ["content"]),
		enabled: entry.enabled !== 0 && entry.enabled !== false,
	}));
}

/** GET /api/files/all → 当前用户所有会话的文件（v0.45.0）。 */
export function parseAllFiles(raw: unknown): AllFileInfo[] {
	const list = arrayOf(raw, ["files"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name"]),
		size: pickNumber(entry, ["size"]),
		updatedAt: pickString(entry, ["updated_at", "updatedAt"]),
		sessionId: pickString(entry, ["sessionId", "session_id", "conversation_id"]) || "1",
		sessionTitle: pickString(entry, ["sessionTitle", "session_title"]) || "未命名会话",
	}));
}

/** GET /api/kb → 知识库文档列表（v0.45.0）。 */
export function parseKbDocs(raw: unknown): KbDocInfo[] {
	const list = arrayOf(raw, ["docs"]).filter(isObject);
	return list.map((entry, index) => ({
		id: pickNumber(entry, ["id"]) || -(index + 1),
		title: pickString(entry, ["title"]) || "未命名文档",
		source: pickString(entry, ["source"]),
		tags: pickString(entry, ["tags"]),
		size: pickNumber(entry, ["size"]),
		chunks: pickNumber(entry, ["chunks"]),
		createdAt: pickString(entry, ["createdAt", "created_at"]),
		updatedAt: pickString(entry, ["updatedAt", "updated_at"]),
	}));
}

/** GET /api/kb/search → 命中片段（v0.45.0）。 */
export function parseKbHits(raw: unknown): KbHit[] {
	const list = arrayOf(raw, ["hits"]).filter(isObject);
	return list.map((entry) => ({
		docId: pickNumber(entry, ["docId", "doc_id"]),
		title: pickString(entry, ["title"]) || "未命名文档",
		source: pickString(entry, ["source"]),
		text: pickString(entry, ["text", "content"]),
		chunkSeq: pickNumber(entry, ["chunkSeq", "chunk_seq", "seq"]),
		score: pickNumber(entry, ["score"]),
	}));
}

/**
 * GET /api/shares/all → 分享清单（NERE-42）。
 * 丢弃 token 缺失或 kind 不在枚举内的项；数字字段缺失按 0，name 缺失按「（未命名）」。
 */
export function parseShareRecords(raw: unknown): ShareRecord[] {
	const list = arrayOf(raw, ["shares"]).filter(isObject);
	const records: ShareRecord[] = [];
	for (const entry of list) {
		const token = pickString(entry, ["token"]);
		const kind = entry.kind;
		if (!token || (kind !== "file" && kind !== "conversation")) continue;
		records.push({
			token,
			kind,
			name: pickString(entry, ["name"]) || "（未命名）",
			expiresAt: pickNumber(entry, ["expiresAt", "expires_at"]),
			createdAt: pickString(entry, ["createdAt", "created_at"]),
			openCount: pickNumber(entry, ["openCount", "open_count"]),
			lastOpenedAt: pickNumber(entry, ["lastOpenedAt", "last_opened_at"]),
			sessionId: pickString(entry, ["sessionId", "session_id"]),
			url: pickString(entry, ["url"]) || `/s/${token}`,
		});
	}
	return records;
}

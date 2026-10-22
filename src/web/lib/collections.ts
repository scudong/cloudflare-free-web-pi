import type {
	AllFileInfo,
	AutomationInfo,
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
		const rawSchedule = entry.schedule;
		let scheduleLabel = "每天 09:00";
		try {
			const schedule = (typeof rawSchedule === "string" ? JSON.parse(rawSchedule) : rawSchedule) as {
				kind?: string;
				time?: string;
				minutes?: number;
			};
			scheduleLabel =
				schedule?.kind === "interval" ? `每隔 ${schedule.minutes ?? 60} 分钟` : `每天 ${schedule?.time ?? "09:00"}`;
		} catch {
			// 保持默认文案
		}
		const next = typeof entry.next_run_at === "number" ? entry.next_run_at : undefined;
		return {
			id: pickString(entry, ["id"]) || `a${index}`,
			name: pickString(entry, ["name", "title"]) || `任务 ${index + 1}`,
			prompt: pickString(entry, ["prompt", "message"]),
			scheduleLabel,
			nextLabel: next ? new Date(next).toLocaleString("zh-CN", { hour12: false }) : undefined,
			enabled: entry.enabled !== 0 && entry.enabled !== false,
		};
	});
}

/** GET /api/skills → skill list. */
export function parseSkills(raw: unknown): SkillInfo[] {
	const list = arrayOf(raw, ["skills"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name"]) || "未命名技能",
		description: pickString(entry, ["description"]),
		content: pickString(entry, ["content"]),
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

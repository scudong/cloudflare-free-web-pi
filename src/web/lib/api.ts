/**
 * Same-origin API client: relative paths only (deployed alongside the Worker, no CORS needed).
 * /api/chat is non-streaming and may take 10-60s — no client timeout, only AbortSignal to stop waiting.
 * All list endpoints are parsed tolerantly on the caller side (see lib/collections.ts).
 */

export interface SessionInfo {
	ok: boolean;
	name?: string;
}

import type { GoalInfo } from "../types";
import { ingestNetworkFailure, parseIngestResponse, type IngestResult } from "./ingest";

export type { GoalInfo };

export interface ChatResult {
	answer: string;
	tools: { name?: string; summary?: string }[];
	error?: string;
}

/** 已生成的分享链接（v0.40.0）：打开分享弹窗时直接复用。 */
export interface ShareLinkInfo {
	token: string;
	url: string;
	kind: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
}

/** 邀请用户（v0.43.0）。 */
export interface UserInfo {
	id: string;
	name: string;
	codeHint: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, init);
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") throw err;
		throw new ApiError(0, "网络请求失败，请检查服务是否在运行。");
	}

	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		// Response body is not JSON: keep data = null, handle by HTTP status
	}

	if (!res.ok) {
		const detail =
			data !== null && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
				? ((data as { error: string }).error)
				: "";
		throw new ApiError(res.status, detail || `请求失败（HTTP ${res.status}）`);
	}
	if (data === null || typeof data !== "object") {
		throw new ApiError(res.status, "响应不是有效的 JSON 对象");
	}
	return data as T;
}

/** Append query params, skipping empty values. */
function withQuery(path: string, params: Record<string, string>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value);
	}
	const qs = search.toString();
	return qs ? `${path}?${qs}` : path;
}

function jsonPost(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

/* ---------------- 知识库导入（v0.54.3） ---------------- */

/**
 * 文件导入走 XHR 而不是 fetch：只有 XHR 能区分「上传中」与「服务端解析中」，
 * 也才能在 25MB 文件上传时给出真实进度。响应统一交给 parseIngestResponse 归一化。
 */
function ingestFileRequest(
	file: File,
	handlers?: { onProgress?: (percent: number) => void; onUploaded?: () => void },
): Promise<IngestResult> {
	if (typeof XMLHttpRequest === "undefined") {
		return Promise.resolve(ingestNetworkFailure());
	}
	return new Promise((resolve) => {
		const form = new FormData();
		form.append("file", file, file.name);
		const xhr = new XMLHttpRequest();
		let settled = false;
		const settle = (result: IngestResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		xhr.open("POST", "/api/kb/ingest");
		// 25MB PDF 的解析可能超过一分钟；超时也要落到可读错误，不能一直卡在「上传中」。
		xhr.timeout = 180_000;
		xhr.upload.onprogress = (event) => {
			if (!event.lengthComputable || event.total <= 0) return;
			handlers?.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
		};
		xhr.upload.onload = () => handlers?.onUploaded?.();
		xhr.onload = () => {
			let data: unknown = null;
			try {
				data = JSON.parse(xhr.responseText) as unknown;
			} catch {
				// 非 JSON（网关错误页等）：按 HTTP 状态码判定
			}
			settle(parseIngestResponse(data, xhr.status));
		};
		xhr.onerror = () => settle(ingestNetworkFailure());
		xhr.ontimeout = () =>
			settle({ ok: false, code: "network", message: "解析超时（180 秒），请换小一点的文件或稍后重试。" });
		xhr.onabort = () => settle({ ok: false, code: "network", message: "导入已取消。" });
		xhr.send(form);
	});
}

async function ingestUrlRequest(url: string): Promise<IngestResult> {
	let res: Response;
	try {
		res = await fetch("/api/kb/ingest", jsonPost({ url }));
	} catch {
		return ingestNetworkFailure();
	}
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		// 非 JSON 响应体由状态码兜底
	}
	return parseIngestResponse(data, res.status);
}

export const api = {
	session: () => requestJson<SessionInfo>("/api/session"),

	/** GET /api/sessions — v3 returns a list; v1 may return only the current one. */
	sessions: () => requestJson<{ sessions?: unknown[] }>("/api/sessions"),
	/** POST /api/sessions — create a new conversation and return its id. */
	createSession: () => requestJson<{ id?: string; title?: string }>("/api/sessions", { method: "POST" }),

	/** POST /api/branches — 从某条历史消息分叉出新会话（v0.32.0）。 */
	branch: (sessionId: string, entryId: number, title?: string) =>
		requestJson<{ ok?: boolean; id?: string; title?: string; error?: string }>(
			"/api/branches",
			jsonPost({ sessionId, entryId, title }),
		),

	/**
	 * POST /api/chat/stream — SSE。事件：
	 * thinking_start / thinking{delta}（思考过程）
	 * text{delta} / tool_start{name,id,parentId,args} / tool_end{name,id,parentId,summary}
	 * done{answer,tools} / error{message}
	 */
	streamChat: async (
		message: string,
		sessionId: string,
		images: string[],
		onEvent: (event: { type: string; [key: string]: unknown }) => void,
		signal?: AbortSignal,
	): Promise<void> => {
		const resp = await fetch("/api/chat/stream", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message, sessionId, ...(images.length ? { images } : {}) }),
			signal,
		});
		if (!resp.ok || !resp.body) throw new Error(`流式请求失败（HTTP ${resp.status}）`);
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE frames are separated by a blank line.
			let cut = buffer.indexOf("\n\n");
			while (cut >= 0) {
				const frame = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 2);
				// 事件名在 "event: xxx" 行；data 行是 JSON。
				const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
				const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
				if (dataLine) {
					try {
						const payload = JSON.parse(dataLine.slice(5).trim()) as { type?: string; [key: string]: unknown };
						onEvent({ type: eventLine ? eventLine.slice(6).trim() : (payload.type ?? "message"), ...payload });
					} catch {
						// Ignore malformed frames; the terminal done event still arrives.
					}
				}
				cut = buffer.indexOf("\n\n");
			}
		}
	},

	chat: (message: string, sessionId: string, signal?: AbortSignal) =>
		requestJson<ChatResult>("/api/chat", { ...jsonPost({ message, sessionId }), signal }),

	/** 后端返回条目数组本身（不是 { entries } 包装），由调用方宽容解析。 */
	entries: (sessionId?: string) => requestJson<unknown>(withQuery("/api/entries", { sessionId: sessionId ?? "" })),

	files: (sessionId: string) => requestJson<{ files?: unknown[] }>(withQuery("/api/files", { sessionId })),

	fileContent: (sessionId: string, name: string) =>
		requestJson<{ name?: string; content?: string }>(withQuery("/api/files/content", { sessionId, name })),

	deleteFile: (sessionId: string, name: string) =>
		requestJson<{ ok: boolean }>(withQuery("/api/files", { sessionId, name }), { method: "DELETE" }),

	/** 当前用户所有会话产出的文件（v0.45.0）。 */
	filesAll: (q?: string) => requestJson<{ files?: unknown[] }>(withQuery("/api/files/all", { q: q ?? "" })),

	/** 用户知识库（v0.45.0）：每人独立，接口自动落在当前用户 DO。 */
	kbDocs: () => requestJson<{ docs?: unknown[] }>("/api/kb"),
	kbAdd: (title: string, content: string, source?: string, tags?: string) =>
		requestJson<{ ok?: boolean; id?: number; chunks?: number; error?: string }>(
			"/api/kb",
			jsonPost({ title, content, source: source ?? "", tags: tags ?? "" }),
		),
	/**
	 * 知识库导入（v0.54.3）：multipart 文件，或 JSON `{url}`。
	 * 不走 requestJson —— 失败响应里的 `code` 是 UI 文案的分支依据，不能被 HTTP 状态吞掉。
	 */
	kbIngestFile: (file: File, handlers?: { onProgress?: (percent: number) => void; onUploaded?: () => void }) =>
		ingestFileRequest(file, handlers),
	kbIngestUrl: (url: string) => ingestUrlRequest(url),
	kbSearch: (q: string) => requestJson<{ hits?: unknown[] }>(withQuery("/api/kb/search", { q })),
	kbDoc: (id: number) =>
		requestJson<{ id?: number; title?: string; content?: string; error?: string }>(withQuery("/api/kb/doc", { id: String(id) })),
	kbDelete: (id: number) => requestJson<{ ok?: boolean }>(withQuery("/api/kb", { id: String(id) }), { method: "DELETE" }),
	kbStatus: () =>
		requestJson<{ mode?: string; available?: boolean; index?: string; model?: string; total?: number; indexed?: number }>("/api/kb/status"),
	kbReindex: (limit?: number) =>
		requestJson<{ ok?: boolean; indexed?: number; remaining?: number; error?: string }>(
			withQuery("/api/kb/reindex", { limit: limit ? String(limit) : "" }),
			{ method: "POST" },
		),
	/** 当前部署构建号（/api/version 转发到既有 DO 路由）。 */
	version: () => requestJson<{ build?: string; images?: boolean; search?: boolean }>("/api/version"),

	auth: () => requestJson<{ required?: boolean; authenticated?: boolean; owner?: boolean }>("/api/auth"),

	login: (password: string) =>
		requestJson<{ ok?: boolean; owner?: boolean; name?: string; error?: string }>("/api/login", jsonPost({ password })),

	logout: () => requestJson<{ ok?: boolean }>("/api/logout", { method: "POST" }),

	/** 用户管理（v0.43.0，仅主人）：邀请码只在创建/重置时返回一次。 */
	users: () => requestJson<{ users?: UserInfo[] }>("/api/users"),

	addUser: (name: string) =>
		requestJson<{ ok?: boolean; user?: UserInfo; code?: string; error?: string }>("/api/users", jsonPost({ name })),

	resetUserCode: (id: string) =>
		requestJson<{ ok?: boolean; code?: string; hint?: string; error?: string }>("/api/users/reset", jsonPost({ id })),

	deleteUser: (id: string) => requestJson<{ ok?: boolean }>(withQuery("/api/users", { id }), { method: "DELETE" }),

	abort: (sessionId: string) => requestJson<{ ok?: boolean }>("/api/abort", jsonPost({ sessionId })),

	skills: () => requestJson<{ skills?: unknown[] }>("/api/skills"),

	/** 提示模板（v0.31.0）。 */
	prompts: () => requestJson<{ prompts?: unknown[] }>("/api/prompts"),
	addPrompt: (name: string, description: string, content: string) =>
		requestJson<{ ok?: boolean; error?: string }>("/api/prompts", jsonPost({ name, description, content })),
	deletePrompt: (name: string) => requestJson<{ ok?: boolean }>(withQuery("/api/prompts", { name }), { method: "DELETE" }),

	/** 规则文件（v0.31.0）：每轮注入 instructions。 */
	rules: () => requestJson<{ rules?: unknown[] }>("/api/rules"),
	addRule: (name: string, content: string, enabled = true) =>
		requestJson<{ ok?: boolean; error?: string }>("/api/rules", jsonPost({ name, content, enabled })),
	toggleRule: (name: string, enabled: boolean) =>
		requestJson<{ ok?: boolean }>("/api/rules", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, enabled }),
		}),
	deleteRule: (name: string) => requestJson<{ ok?: boolean }>(withQuery("/api/rules", { name }), { method: "DELETE" }),

	/** 能力注册表（v0.31.0）：内置 / 数据 / 协议三类汇总。 */
	capabilities: () =>
		requestJson<{
			groups?: { key: string; label: string; items: { id: string; name: string; description: string; enabled: boolean; count?: number; detail?: string }[] }[];
		}>("/api/capabilities"),

	/** 手动压缩当前会话（v0.30.0）。 */
	compact: (sessionId: string, instructions?: string) =>
		requestJson<{ ok?: boolean; taskId?: string; error?: string }>("/api/compact", jsonPost({ sessionId, instructions })),

	/** 上下文占用估算（v0.42.0）：最近一次模型用量 + 新增内容估算。 */
	context: (sessionId: string) =>
		requestJson<{ usedTokens: number; contextWindow: number; percent: number; approximate?: boolean }>(
			withQuery("/api/context", { sessionId }),
		),

	communitySkills: () =>
		requestJson<{ source?: string; skills?: { name: string; description: string; needsLocal?: boolean; url: string }[] }>(
			"/api/skills/community",
		),

	importSkill: (url: string) =>
		requestJson<{ ok?: boolean; name?: string; error?: string }>("/api/skills/import", jsonPost({ url })),

	addSkill: (name: string, description: string, content: string) =>
		requestJson<{ ok?: boolean }>("/api/skills", jsonPost({ name, description, content })),

	deleteSkill: (name: string) => requestJson<{ ok?: boolean }>(withQuery("/api/skills", { name }), { method: "DELETE" }),

	backup: () => requestJson<unknown>("/api/backup"),

	restore: (payload: unknown) =>
		requestJson<{ ok?: boolean; counts?: Record<string, number>; error?: string }>("/api/restore", jsonPost(payload)),

	models: () => requestJson<{ models?: string[]; default?: string; provider?: string }>("/api/models"),

	/** LLM 供应商（v0.27.0，CCswitch 式）。 */
	providers: () =>
		requestJson<{
			active?: string;
			default?: { id: string; name: string; models: string[]; hasKey?: boolean };
			providers?: { id: string; name: string; baseUrl: string; models: string[]; hasKey?: boolean; keyHint?: string; active?: boolean }[];
		}>("/api/providers"),

	saveProvider: (body: { id?: string; name: string; baseUrl: string; apiKey?: string; models: string }) =>
		requestJson<{ ok?: boolean; id?: string; models?: string[]; error?: string }>("/api/providers", jsonPost(body)),

	deleteProvider: (id: string) =>
		requestJson<{ ok?: boolean }>(withQuery("/api/providers", { id }), { method: "DELETE" }),

	activateProvider: (id: string) =>
		requestJson<{ ok?: boolean; active?: string; models?: string[]; error?: string }>(
			"/api/providers/activate",
			jsonPost({ id }),
		),

	setModel: (sessionId: string, modelId: string) =>
		requestJson<{ ok?: boolean }>("/api/model", jsonPost({ sessionId, modelId })),

	/** 全局设置（v0.20.0 网页搜索；v0.22.0 思考档位；v0.33.0 工具审批）。 */
	settings: () =>
		requestJson<{
			webSearch?: boolean;
			/** 知识库预检索（v0.46.0）：每轮自动把命中的资料注入系统提示。 */
			kbPrefetch?: boolean;
			/** 知识库检索模式（v0.53.0）：fts / vector / hybrid。 */
			kbRetrieval?: string;
			kbVector?: { available?: boolean; index?: string };
			thinkingLevel?: string;
			/** 分享页署名（v0.55.0）。 */
			displayName?: string;
			/** 分享默认有效期（秒，0 = 永久，v0.55.0）。 */
			shareTtlSeconds?: number;
			compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number };
			approval?: { read: string; write: string; exec: string };
		}>("/api/settings"),

	setSettings: (patch: {
		webSearch?: boolean;
		kbPrefetch?: boolean;
		kbRetrieval?: string;
		thinkingLevel?: string;
		displayName?: string;
		shareTtlSeconds?: number;
		compaction?: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>;
		approval?: Partial<{ read: string; write: string; exec: string }>;
		approvalTools?: Record<string, string>;
	}) => requestJson<{ ok?: boolean }>("/api/settings", jsonPost(patch)),

	/** 待回答的问题（v0.37.0）。 */
	questions: (sessionId: string) =>
		requestJson<{ questions?: unknown[] }>(withQuery("/api/questions", { sessionId })),

	answerQuestion: (id: number, answers: { id: string; choice?: string; text?: string }[]) =>
		requestJson<{ ok?: boolean; id?: number; resume?: string; error?: string }>("/api/questions", jsonPost({ id, answers })),

	/** 自定义工具（v0.36.0）。 */
	customTools: () =>
		requestJson<{ tools?: unknown[] }>("/api/custom-tools"),

	addCustomTool: (body: { name: string; description: string; parameters: string; code: string }) =>
		requestJson<{ ok?: boolean; name?: string; tools?: number; error?: string }>("/api/custom-tools", jsonPost(body)),

	deleteCustomTool: (name: string) =>
		requestJson<{ ok?: boolean; tools?: number }>(withQuery("/api/custom-tools", { name }), { method: "DELETE" }),

	/** pi 内核版本（v0.35.0）：当前声明版本 + npm 最新版本。 */
	kernel: (refresh = false) =>
		requestJson<{
			current?: Record<string, string>;
			latest?: Record<string, string>;
			checkedAt?: string;
			updateAvailable?: boolean;
			outdated?: string[];
			upgrade?: { manual?: string; auto?: string };
		}>(refresh ? "/api/kernel?refresh=1" : "/api/kernel"),

	/** 工具清单与生效策略（v0.33.0）。 */
	tools: () =>
		requestJson<{
			approval?: { read: string; write: string; exec: string };
			tools?: { name: string; category: string; policy: string; override: string }[];
		}>("/api/tools"),

	/** 生成中插话（v0.34.0）：消息进入正在进行的这一轮。 */
	interject: (sessionId: string, message: string) =>
		requestJson<{ ok?: boolean; id?: string; error?: string }>("/api/interject", jsonPost({ sessionId, message })),

	/** 待审批的工具调用（v0.33.0）。 */
	approvals: (sessionId: string) =>
		requestJson<{
			approvals?: { id: number; tool: string; category: string; args: string; created_at: string }[];
		}>(withQuery("/api/approvals", { sessionId })),

	decideApproval: (id: number, action: "once" | "always" | "deny") =>
		requestJson<{ ok?: boolean; tool?: string; action?: string; resume?: string; error?: string }>(
			"/api/approvals",
			jsonPost({ id, action }),
		),

	/** 当前会话的分步计划（v0.22.0）。 */
	plan: (sessionId: string) =>
		requestJson<{ steps?: { title: string; status: string }[] }>(withQuery("/api/plan", { sessionId })),

	/** 目标（v0.31.0）：一个会话一份，active 时自动续转。 */
	goal: (sessionId: string) => requestJson<{ goal?: GoalInfo | null }>(withQuery("/api/goal", { sessionId })),

	setGoal: (body: { sessionId: string; objective: string; tokenBudget?: number; maxTurns?: number }) =>
		requestJson<{ ok?: boolean; goal?: GoalInfo | null; error?: string }>("/api/goal", jsonPost(body)),

	stopGoal: (sessionId: string) =>
		requestJson<{ ok?: boolean; goal?: GoalInfo | null }>(withQuery("/api/goal", { sessionId }), { method: "DELETE" }),

	share: (sessionId: string, theme?: string) =>
		requestJson<{ ok?: boolean; token?: string; url?: string; expiresAt?: number }>(
			"/api/share",
			jsonPost({ sessionId, kind: "conversation", theme }),
		),

	/** 分享工作台文件（v0.38.0）：md 渲染成分享页，html 原样输出；ttlSeconds=0 永久。 */
	shareFile: (sessionId: string, name: string, ttlSeconds: number, theme?: string) =>
		requestJson<{ ok?: boolean; token?: string; url?: string; expiresAt?: number; error?: string }>(
			"/api/share",
			jsonPost({ sessionId, kind: "file", name, ttlSeconds, theme }),
		),

	/** 列出未过期的分享链接（v0.40.0）：用于复用已生成的链接。 */
	shares: (sessionId: string, kind: "conversation" | "file", name?: string) =>
		requestJson<{ shares?: ShareLinkInfo[] }>(
			withQuery("/api/shares", { sessionId, kind, ...(name ? { name } : {}) }),
		),

	automations: () => requestJson<{ automations?: unknown[] }>("/api/automations"),

	addAutomation: (name: string, prompt: string, sessionId: string, schedule: { kind: string; time?: string; minutes?: number }) =>
		requestJson<{ ok?: boolean; id?: string }>("/api/automations", jsonPost({ name, prompt, sessionId, schedule })),

	toggleAutomation: (id: string, enabled: boolean) =>
		requestJson<{ ok?: boolean }>("/api/automations", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, enabled }),
		}),

	deleteAutomation: (id: string) => requestJson<{ ok?: boolean }>(withQuery("/api/automations", { id }), { method: "DELETE" }),

	mcpServers: () => requestJson<{ servers?: unknown[] }>("/api/mcp"),

	addMcp: (name: string, url: string, headers?: Record<string, string>) =>
		requestJson<{ ok?: boolean; tools?: number; error?: string }>("/api/mcp", jsonPost({ name, url, headers })),

	deleteMcp: (id: string) => requestJson<{ ok: boolean }>(withQuery("/api/mcp", { id }), { method: "DELETE" }),

	memories: () => requestJson<{ memories?: unknown[] }>("/api/memories"),

	deleteMemory: (id: number) => requestJson<{ ok: boolean }>(withQuery("/api/memories", { id: String(id) }), { method: "DELETE" }),

	/** 一键清空记忆库（v0.26.0）。 */
	clearMemories: () => requestJson<{ ok: boolean; deleted?: number }>("/api/memories?all=1", { method: "DELETE" }),

	reset: (sessionId: string) => requestJson<{ ok: boolean }>("/api/reset", jsonPost({ sessionId })),

	renameSession: (id: string, title: string) =>
		requestJson<{ ok: boolean }>("/api/sessions", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title }) }),

	deleteSession: (id: string) =>
		requestJson<{ ok: boolean }>(withQuery("/api/sessions", { id }), { method: "DELETE" }),
};

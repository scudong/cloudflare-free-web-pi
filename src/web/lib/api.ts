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

export type { GoalInfo };

export interface ChatResult {
	answer: string;
	tools: { name?: string; summary?: string }[];
	error?: string;
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

	auth: () => requestJson<{ required?: boolean; authenticated?: boolean }>("/api/auth"),

	login: (password: string) =>
		requestJson<{ ok?: boolean; error?: string }>("/api/login", jsonPost({ password })),

	logout: () => requestJson<{ ok?: boolean }>("/api/logout", { method: "POST" }),

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
			default?: { id: string; name: string; models: string[] };
			providers?: { id: string; name: string; baseUrl: string; models: string[]; keyHint?: string; active?: boolean }[];
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

	/** 全局设置（v0.20.0 网页搜索；v0.22.0 增加思考档位）。 */
	settings: () =>
		requestJson<{
			webSearch?: boolean;
			thinkingLevel?: string;
			compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number };
		}>("/api/settings"),

	setSettings: (patch: {
		webSearch?: boolean;
		thinkingLevel?: string;
		compaction?: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>;
	}) => requestJson<{ ok?: boolean }>("/api/settings", jsonPost(patch)),

	/** 当前会话的分步计划（v0.22.0）。 */
	plan: (sessionId: string) =>
		requestJson<{ steps?: { title: string; status: string }[] }>(withQuery("/api/plan", { sessionId })),

	/** 目标（v0.31.0）：一个会话一份，active 时自动续转。 */
	goal: (sessionId: string) => requestJson<{ goal?: GoalInfo | null }>(withQuery("/api/goal", { sessionId })),

	setGoal: (body: { sessionId: string; objective: string; tokenBudget?: number; maxTurns?: number }) =>
		requestJson<{ ok?: boolean; goal?: GoalInfo | null; error?: string }>("/api/goal", jsonPost(body)),

	stopGoal: (sessionId: string) =>
		requestJson<{ ok?: boolean; goal?: GoalInfo | null }>(withQuery("/api/goal", { sessionId }), { method: "DELETE" }),

	share: (sessionId: string) =>
		requestJson<{ ok?: boolean; token?: string; url?: string }>("/api/share", jsonPost({ sessionId, kind: "conversation" })),

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

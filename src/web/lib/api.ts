/**
 * Same-origin API client: relative paths only (deployed alongside the Worker, no CORS needed).
 * /api/chat is non-streaming and may take 10-60s — no client timeout, only AbortSignal to stop waiting.
 * All list endpoints are parsed tolerantly on the caller side (see lib/collections.ts).
 */

export interface SessionInfo {
	ok: boolean;
	name?: string;
}

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

	/**
	 * POST /api/chat/stream — SSE。onEvent 收到 {type:"text",delta} / {type:"tool_start",name}
	 * / {type:"tool_end",name} / {type:"done",answer,tools} / {type:"error",message}。
	 */
	streamChat: async (
		message: string,
		sessionId: string,
		onEvent: (event: { type: string; [key: string]: unknown }) => void,
		signal?: AbortSignal,
	): Promise<void> => {
		const resp = await fetch("/api/chat/stream", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message, sessionId }),
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
				const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
				if (dataLine) {
					try {
						onEvent(JSON.parse(dataLine.slice(5).trim()));
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

	entries: (sessionId?: string) => requestJson<{ entries: unknown[] }>(withQuery("/api/entries", { sessionId: sessionId ?? "" })),

	files: (sessionId: string) => requestJson<{ files?: unknown[] }>(withQuery("/api/files", { sessionId })),

	fileContent: (sessionId: string, name: string) =>
		requestJson<{ name?: string; content?: string }>(withQuery("/api/files/content", { sessionId, name })),

	deleteFile: (sessionId: string, name: string) =>
		requestJson<{ ok: boolean }>(withQuery("/api/files", { sessionId, name }), { method: "DELETE" }),

	auth: () => requestJson<{ required?: boolean; authenticated?: boolean }>("/api/auth"),

	login: (password: string) =>
		requestJson<{ ok?: boolean; error?: string }>("/api/login", jsonPost({ password })),

	logout: () => requestJson<{ ok?: boolean }>("/api/logout", { method: "POST" }),

	models: () => requestJson<{ models?: string[]; default?: string }>("/api/models"),

	setModel: (sessionId: string, modelId: string) =>
		requestJson<{ ok?: boolean }>("/api/model", jsonPost({ sessionId, modelId })),

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

	addMcp: (name: string, url: string) =>
		requestJson<{ ok?: boolean; tools?: number }>("/api/mcp", jsonPost({ name, url })),

	deleteMcp: (id: string) => requestJson<{ ok: boolean }>(withQuery("/api/mcp", { id }), { method: "DELETE" }),

	memories: () => requestJson<{ memories?: unknown[] }>("/api/memories"),

	deleteMemory: (id: number) => requestJson<{ ok: boolean }>(withQuery("/api/memories", { id: String(id) }), { method: "DELETE" }),

	reset: (sessionId: string) => requestJson<{ ok: boolean }>("/api/reset", jsonPost({ sessionId })),

	renameSession: (id: string, title: string) =>
		requestJson<{ ok: boolean }>("/api/sessions", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title }) }),

	deleteSession: (id: string) =>
		requestJson<{ ok: boolean }>(withQuery("/api/sessions", { id }), { method: "DELETE" }),
};

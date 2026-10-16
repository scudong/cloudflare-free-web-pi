/**
 * 同域 API 客户端：全部相对路径（与 Worker 同源部署，无需 CORS）。
 * /api/chat 非流式，可能耗时 10–60s——不设客户端超时，仅支持通过 AbortSignal 主动停止等待。
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
		// 响应体不是 JSON：data 保持 null，按 HTTP 状态处理
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

export const api = {
	session: () => requestJson<SessionInfo>("/api/session"),

	chat: (message: string, signal?: AbortSignal) =>
		requestJson<ChatResult>("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message }),
			signal,
		}),

	entries: () => requestJson<{ entries: unknown[] }>("/api/entries"),

	reset: () => requestJson<{ ok: boolean }>("/api/reset", { method: "POST" }),
};

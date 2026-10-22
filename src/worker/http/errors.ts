/**
 * HTTP 语义错误（ADR-0001 §9.3）：Route/Service 抛 AppError，由 dispatch 统一映射为
 * `{ error, code, details?, retryable? }`（NERE-79）；未知异常保持 500 + 截断原文。
 * 兼容字段（`/kb/ingest` 的 ok/message、`/skills/import` 的 installed）由 `toResponse` 的
 * 第二个参数附加，不另写响应体映射。
 */
export class AppError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly retryable = false,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AppError";
	}
}

/** 只带 HTTP 状态的老式端点错误：没有显式 code 时按状态补一个稳定码。 */
export function defaultErrorCode(status: number): string {
	switch (status) {
		case 400:
			return "bad_request";
		case 404:
			return "not_found";
		case 409:
			return "conflict";
		case 413:
			return "too_large";
		case 415:
			return "unsupported_type";
		case 422:
			return "unprocessable";
		case 429:
			return "rate_limited";
		default:
			return status >= 500 ? "internal_error" : "bad_request";
	}
}

/** 未知异常的可回传文案：优先 message，避免把 `Error: ` 前缀和堆栈带进响应体。 */
export function errorText(err: unknown, max = 200): string {
	const text = err instanceof Error ? err.message || err.name : String(err);
	return text.slice(0, max);
}

/**
 * 统一错误响应：AppError → 自身 status + `{ error, code }`（retryable/details 有则带）；
 * 未知异常 → 500 + `{ error, code: "internal_error" }`。
 * `extra` 只用于契约兼容字段，核心字段始终以错误对象为准。
 */
export function toResponse(err: unknown, extra?: Record<string, unknown>): Response {
	if (!(err instanceof AppError)) {
		return Response.json({ ...extra, error: errorText(err, 500), code: "internal_error" }, { status: 500 });
	}
	const body: Record<string, unknown> = { ...extra, error: err.message, code: err.code };
	if (err.retryable) body.retryable = true;
	if (err.details) body.details = err.details;
	return Response.json(body, { status: err.status });
}

/**
 * HTTP 语义错误（ADR-0001 §9.3）：Route/Service 抛 AppError，由 dispatch 统一映射；
 * 未知异常保持 500 + String(e).slice(0, 500)，文案与旧 handleFetch 逐字一致。
 */
export class AppError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "AppError";
	}
}

export function toResponse(err: unknown): Response {
	if (!(err instanceof AppError)) {
		return Response.json({ error: String(err).slice(0, 500) }, { status: 500 });
	}
	const body = err.retryable ? { error: err.message, retryable: true } : { error: err.message };
	return Response.json(body, { status: err.status });
}

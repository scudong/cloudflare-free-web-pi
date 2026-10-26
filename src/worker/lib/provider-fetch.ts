/**
 * 模型供应商 fetch 包装层（NERE-85，ADR-0001 §5.6 共享纯函数）。
 *
 * pi-ai 的 openai-completions 适配器把 `options.fetch` 直接交给 OpenAI SDK，
 * 因此这里只需包装 `fetch` 就能覆盖一轮模型请求的全部 HTTP 尝试，不用改内核：
 * - 瞬时错误（连接失败、首个字节前的流中断、408/429/5xx、空闲超时）自动重试，
 *   最多 2 次额外尝试，退避 500ms → 2s；
 * - 不可重试（401/403/400 等其它 4xx）原样返回响应，由 SDK 立即报错，不浪费配额；
 * - 空闲看门狗：从发起请求到收到首个响应字节期间，60s 无任何字节即中止本次尝试，
 *   按可重试处理；
 * - 重试只发生在返回首个字节之前，SSE 事件不会重复（NERE-85 验收）。
 *
 * 拿到首个字节之后的中断不再重试：模型输出已经进入事件流，重放会产生重复内容，
 * 这类失败交给 runner 记为 model_error。
 */

/** 默认策略（单测按这些常量断言）。 */
export const PROVIDER_FETCH_DEFAULTS = {
	/** 额外尝试次数：最多 3 次尝试。 */
	maxRetries: 2,
	/** 每次重试前的退避（毫秒），超出长度后沿用最后一项。 */
	backoffMs: [500, 2000] as readonly number[],
	/** 首个响应字节前的空闲上限（毫秒）。 */
	idleTimeoutMs: 60_000,
} as const;

export type ProviderFetchOptions = {
	/** 实际发起请求的实现；默认全局 `fetch`。 */
	fetchImpl?: typeof fetch;
	maxRetries?: number;
	backoffMs?: readonly number[];
	idleTimeoutMs?: number;
	/** 诊断输出；默认 `console.warn`（一行结构化，不含密钥）。 */
	warn?: (line: string) => void;
	/** 计时器，单测可注入。 */
	now?: () => number;
};

/**
 * 最终失败：重试已耗尽，属于终态错误。
 *
 * OpenAI SDK 会把 fetch 抛出的异常统一包成 `APIConnectionError`，
 * 所以没有状态码时 runner 的 `last_error` 里是 SDK 的 "Connection error."；
 * 本类的分类与尝试次数以 `console.warn` 的结构化诊断为准。
 */
export class ProviderFetchError extends Error {
	readonly attempts: number;
	readonly errorClass: string;

	constructor(attempts: number, errorClass: string) {
		super(`模型供应商请求失败（${attempts} 次尝试）：${errorClass}`);
		this.name = "ProviderFetchError";
		this.attempts = attempts;
		this.errorClass = errorClass;
	}
}

/** 一次尝试的失败分类；`errorClass` 进诊断日志与最终错误。 */
class AttemptFailure extends Error {
	constructor(readonly errorClass: string) {
		super(errorClass);
		this.name = "AttemptFailure";
	}
}

class IdleTimeout extends Error {
	constructor() {
		super("idle timeout");
		this.name = "IdleTimeout";
	}
}

function abortError(signal: AbortSignal): Error {
	const err = new Error("Request aborted");
	err.name = "AbortError";
	err.cause = signal.reason;
	return err;
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError(signal));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		clearTimeout(timer);
		reject(abortError(signal!));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, Math.max(0, ms));
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/** 把已读出的首个分块接回响应体，其余字节继续从原 reader 泵出。 */
function spliceFirstChunk(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, first: ReadableStreamReadResult<Uint8Array>): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (first.done) controller.close();
			else controller.enqueue(first.value);
		},
		async pull(controller) {
			const next = await reader.read();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * 包装一次 HTTP 尝试：看门狗覆盖「发起请求 → 首个响应字节」；
 * 瞬时状态码丢弃响应体后抛可重试错误。
 */
async function attemptFetch(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetchImpl: typeof fetch,
	idleTimeoutMs: number,
): Promise<Response> {
	const parent = init?.signal ?? null;
	if (parent?.aborted) throw abortError(parent);
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent?.reason);
	parent?.addEventListener("abort", onAbort, { once: true });

	let timedOut = false;
	const idle = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		timedOut = true;
		idle.reject(new IdleTimeout());
		controller.abort(new IdleTimeout());
	}, idleTimeoutMs);
	const cleanup = () => {
		clearTimeout(timer);
		parent?.removeEventListener("abort", onAbort);
	};

	try {
		const response = await Promise.race([
			fetchImpl(input, { ...init, signal: controller.signal }),
			idle.promise,
		]);
		if (response.status === 408 || response.status === 429 || response.status >= 500) {
			await response.body?.cancel().catch(() => {});
			throw new AttemptFailure(`http_${response.status}`);
		}
		// 无响应体或不可携带响应体的状态码：没有字节可等，直接交给 SDK。
		if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
			return response;
		}
		const reader = response.body.getReader();
		let first: ReadableStreamReadResult<Uint8Array>;
		try {
			first = await Promise.race([reader.read(), idle.promise]);
		} catch (err) {
			if (err instanceof IdleTimeout || timedOut) {
				await reader.cancel().catch(() => {});
				throw new AttemptFailure("no_bytes");
			}
			if (parent?.aborted) throw abortError(parent);
			throw new AttemptFailure("stream_broken");
		}
		// 首个字节已到：撤掉看门狗（后续停顿沿用 SDK 的默认超时语义）。
		cleanup();
		return spliceFirstChunk(response, reader, first);
	} catch (err) {
		if (parent?.aborted) throw abortError(parent);
		if (err instanceof AttemptFailure) throw err;
		if (err instanceof IdleTimeout || timedOut) {
			throw new AttemptFailure("no_bytes");
		}
		throw new AttemptFailure("connect_failed");
	} finally {
		cleanup();
	}
}

/**
 * 构造带重试与空闲看门狗的 fetch。
 * 返回值可直接作为 pi-ai 的 `options.fetch` 注入（见 `withProviderFetch`）。
 */
export function createProviderFetch(options: ProviderFetchOptions = {}): typeof fetch {
	const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	const maxRetries = Math.max(0, options.maxRetries ?? PROVIDER_FETCH_DEFAULTS.maxRetries);
	const backoffMs = options.backoffMs?.length ? options.backoffMs : PROVIDER_FETCH_DEFAULTS.backoffMs;
	const idleTimeoutMs = options.idleTimeoutMs ?? PROVIDER_FETCH_DEFAULTS.idleTimeoutMs;
	const warn = options.warn ?? ((line: string) => console.warn(line));
	const now = options.now ?? (() => Date.now());

	return async function providerFetch(input, init) {
		const parent = init?.signal ?? null;
		for (let attempt = 0; ; attempt++) {
			const startedAt = now();
			try {
				return await attemptFetch(input, init, fetchImpl, idleTimeoutMs);
			} catch (err) {
				if (parent?.aborted) throw abortError(parent);
				const failure = err instanceof AttemptFailure ? err : new AttemptFailure("connect_failed");
				if (attempt >= maxRetries) {
					throw new ProviderFetchError(attempt + 1, failure.errorClass);
				}
				warn(
					`[provider-fetch] retry attempt=${attempt + 1} errorClass=${failure.errorClass} elapsedMs=${Math.max(0, now() - startedAt)}`,
				);
				await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]!, parent);
			}
		}
	};
}

/** pi-ai Provider 中与本包装相关的方法（结构类型，不 import 内核类型）。 */
type ProviderStreams = {
	stream?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
	streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
	fetchDeferred?: (model: unknown, handle: unknown, options?: Record<string, unknown>) => unknown;
};

/**
 * 给 pi-ai Provider 注入供应商 fetch（自定义供应商与内置 DeepSeek 共用）。
 *
 * `maxRetries: 0` 显式关掉 pi-ai 自带的同层重试（默认已是 0），
 * 保证「最多 2 次额外尝试」只有这一处实现，重试节奏可测。
 */
export function withProviderFetch<T extends object>(provider: T, fetchImpl: typeof fetch): T {
	const source = provider as T & ProviderStreams;
	const inject = (options: unknown): Record<string, unknown> => ({
		...((options as Record<string, unknown> | undefined) ?? {}),
		fetch: fetchImpl,
		maxRetries: 0,
	});
	const wrapped: ProviderStreams = { ...source };
	if (typeof source.stream === "function") {
		wrapped.stream = (model, context, options) => source.stream!(model, context, inject(options));
	}
	if (typeof source.streamSimple === "function") {
		wrapped.streamSimple = (model, context, options) => source.streamSimple!(model, context, inject(options));
	}
	if (typeof source.fetchDeferred === "function") {
		wrapped.fetchDeferred = (model, handle, options) => source.fetchDeferred!(model, handle, inject(options));
	}
	return wrapped as T;
}

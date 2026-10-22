import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, errorText, toResponse } from "../http/errors";
import { createChatService, type ChatEvent } from "../services/chat-service";

/**
 * 对话域路由（ADR-0001 §1 / §5，NERE-33）：只做 JSON 解析、SSE 编码与状态码，
 * 编排放 `chat-service`；`/chat` 与 `/chat/stream` 共用 prepare → submit → finish。
 */
function service(ctx: RequestContext) {
	return createChatService({ sql: ctx.sql(), runtime: ctx.chatRuntime });
}

const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	"x-accel-buffering": "no",
};

export const chatRoutes: readonly Route[] = [
	{
		method: "POST",
		path: "/chat",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as { message: string; sessionId?: string; images?: string[] };
			return Response.json(
				await service(ctx).chat({ message: body.message, sessionId: body.sessionId, images: body.images }),
			);
		},
	},
	{
		method: "POST",
		path: "/chat/stream",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as { message: string; sessionId?: string; images?: string[] };
			const chat = service(ctx);
			// prepare 失败走 HTTP 错误（含同会话并发的 409 chat_busy）；进入泵之后才走 SSE error 帧。
			const prepared = await chat.prepare({ message: body.message, sessionId: body.sessionId, images: body.images });
			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();
			let closed = false;
			const emit = async (event: ChatEvent) => {
				if (closed) return;
				try {
					await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			const pump = chat.stream(prepared, emit).finally(async () => {
				closed = true;
				await writer.close().catch(() => {});
			});
			ctx.chatRuntime.waitUntil(pump);
			return new Response(readable, { headers: SSE_HEADERS });
		},
	},
	{
		method: "POST",
		path: "/interject",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string; message?: string };
			const message = String(body.message ?? "").trim();
			if (!message) return toResponse(new AppError("bad_request", 400, "插话内容不能为空"), { ok: false });
			try {
				return Response.json(await service(ctx).interject(message, body.sessionId));
			} catch (err) {
				return toResponse(new AppError("interject_failed", 500, errorText(err)), { ok: false });
			}
		},
	},
	{
		method: "POST",
		path: "/abort",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string };
			return Response.json(await service(ctx).abort(body.sessionId));
		},
	},
	{
		method: "POST",
		path: "/reset",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string };
			return Response.json(await service(ctx).reset(body.sessionId));
		},
	},
	{
		method: "POST",
		path: "/compact",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string; instructions?: string };
			const chat = service(ctx);
			return Response.json(
				await chat.compact(body.sessionId, typeof body.instructions === "string" ? body.instructions : undefined),
			);
		},
	},
];

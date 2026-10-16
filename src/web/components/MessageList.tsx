import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import { renderRichText } from "../lib/rich";
import { ToolBar } from "./ToolBar";

const AUTO_SCROLL_THRESHOLD = 80;

function UserBubble({ text }: { text: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sky-600 px-4 py-2.5 text-[15px] leading-relaxed text-white sm:max-w-[72%]">
				{renderRichText(text)}
			</div>
		</div>
	);
}

function AssistantBubble({ message }: { message: Extract<ChatMessage, { role: "assistant" }> }) {
	return (
		<div className="flex flex-col items-start gap-1.5">
			{message.tools && message.tools.length > 0 && <ToolBar tools={message.tools} />}
			<div
				className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[72%] ${
					message.error
						? "border-red-500/40 bg-red-950/40 text-red-200"
						: "border-slate-700/60 bg-slate-800/80 text-slate-100"
				}`}
			>
				{renderRichText(message.text)}
			</div>
		</div>
	);
}

function NoticeBubble({ text }: { text: string }) {
	return <div className="self-center rounded-full bg-slate-800/60 px-3.5 py-1 text-xs text-slate-400">{text}</div>;
}

function PendingBubble({ elapsed }: { elapsed: number }) {
	return (
		<div className="flex flex-col items-start gap-1.5">
			<div className="flex items-center gap-2.5 self-start rounded-2xl rounded-bl-md border border-slate-700/60 bg-slate-800/80 px-4 py-2.5 text-sm text-slate-300">
				<span aria-hidden className="flex items-end gap-1">
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms]" />
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms]" />
				</span>
				<span>思考中…</span>
				<span className="tabular-nums text-slate-500">{elapsed}s</span>
			</div>
		</div>
	);
}

interface MessageListProps {
	messages: ChatMessage[];
	pending: boolean;
	elapsed: number;
	loading: boolean;
	loadError: string | null;
	onRetry: () => void;
}

export function MessageList({ messages, pending, elapsed, loading, loadError, onRetry }: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);

	// 新内容到达时：若用户本来就在底部附近则自动滚动，否则保持当前位置
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [messages, pending, elapsed]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
	};

	const isEmpty = messages.length === 0 && !pending;

	return (
		<main ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
			<div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-4 py-5 sm:border-x sm:border-slate-800/60">
				{loading && isEmpty && (
					<div className="flex flex-1 items-center justify-center text-sm text-slate-500">正在加载会话…</div>
				)}

				{!loading && isEmpty && (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
						<div
							aria-hidden
							className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/15 text-2xl font-semibold text-sky-400"
						>
							π
						</div>
						<p className="text-sm text-slate-300">开始与 π 对话</p>
						<p className="max-w-xs text-xs leading-relaxed text-slate-500">
							回复由 Cloudflare Worker 生成，可能需要 10–60 秒，请耐心等待。
						</p>
					</div>
				)}

				{loadError && (
					<div className="flex items-center justify-center gap-2 text-xs text-amber-300/90">
						<span>历史记录加载失败：{loadError}</span>
						<button
							type="button"
							onClick={onRetry}
							className="rounded-md border border-slate-700 px-2 py-0.5 text-slate-300 transition-colors hover:bg-slate-800"
						>
							重试
						</button>
					</div>
				)}

				{messages.map((message) => {
					switch (message.role) {
						case "user":
							return <UserBubble key={message.id} text={message.text} />;
						case "assistant":
							return <AssistantBubble key={message.id} message={message} />;
						case "tool":
							return (
								<div key={message.id} className="flex flex-col items-start">
									<ToolBar tools={message.tools} />
								</div>
							);
						case "notice":
							return <NoticeBubble key={message.id} text={message.text} />;
					}
				})}

				{pending && <PendingBubble elapsed={elapsed} />}
			</div>
		</main>
	);
}

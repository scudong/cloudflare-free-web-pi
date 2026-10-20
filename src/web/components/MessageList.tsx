import { useEffect, useRef } from "react";
import type { ChatMessage, FileInfo, PlanStep } from "../types";
import { renderMarkdown, renderRichText } from "../lib/rich";
import { ToolBar } from "./ToolBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { PlanCard } from "./PlanCard";
import { ArtifactCard } from "./ArtifactCard";
import { Icon } from "./Icon";

const AUTO_SCROLL_THRESHOLD = 80;

function UserBubble({
	message,
	onBranch,
}: {
	message: Extract<ChatMessage, { role: "user" }>;
	/** 从这条消息分叉（v0.32.0）：这条消息之前的历史会带到新会话。 */
	onBranch?: (entryId: number) => void;
}) {
	return (
		<div className="group flex flex-col items-end gap-1.5">
			{message.images && message.images.length > 0 && (
				<div className="flex max-w-[85%] flex-wrap justify-end gap-1.5 sm:max-w-[72%]">
					{message.images.map((src, index) => (
						<img
							key={`${src.slice(0, 24)}-${index}`}
							src={src}
							alt={`图片 ${index + 1}`}
							className="max-h-44 max-w-[12rem] rounded-xl border border-slate-700 object-cover"
						/>
					))}
				</div>
			)}
			{message.text && message.text !== "（图片）" && (
				<div className="flex max-w-[85%] items-start justify-end gap-1.5 sm:max-w-[72%]">
					{onBranch && message.entryId !== undefined && (
						<button
							type="button"
							onClick={() => onBranch(message.entryId as number)}
							title="从这里分叉：新建一个会话，带上这条消息之前的对话"
							aria-label="从这条消息分叉"
							className="mt-1.5 shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-500 opacity-0 transition-opacity hover:bg-slate-800 hover:text-sky-300 focus-visible:opacity-100 group-hover:opacity-100"
						>
							⑂ 分支
						</button>
					)}
					<div className="min-w-0 whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sky-600 px-4 py-2.5 text-[15px] leading-relaxed text-white">
						{renderRichText(message.text)}
					</div>
				</div>
			)}
		</div>
	);
}

function AssistantBubble({
	message,
	streaming,
	onOpenFile,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	streaming?: boolean;
	onOpenFile?: (name: string) => void;
}) {
	const hasBody = message.text.trim().length > 0 || !message.tools?.length;
	return (
		<div className="flex w-full flex-col items-start gap-1.5">
			{message.thinking && <ThinkingBlock text={message.thinking} streaming={streaming} />}
			{message.tools && message.tools.length > 0 && <ToolBar tools={message.tools} />}
			{message.files && message.files.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{message.files.map((file, index) => (
						<ArtifactCard key={`${file.name}-${index}`} file={file} onOpen={onOpenFile} />
					))}
				</div>
			)}
			{hasBody && message.text.trim() && (
				<div
					className={`md-prose w-full break-words rounded-2xl rounded-bl-md border px-4 py-2.5 text-[15px] ${
						message.error
							? "border-red-500/40 bg-red-950/40 text-red-200"
							: "border-slate-700/60 bg-slate-800/80 text-slate-100"
					}`}
				>
					{renderMarkdown(message.text)}
				</div>
			)}
		</div>
	);
}

function NoticeBubble({ text }: { text: string }) {
	return <div className="self-center rounded-full bg-slate-800/60 px-3.5 py-1 text-xs text-slate-400">{text}</div>;
}

function PendingBubble({ elapsed, phase }: { elapsed: number; phase: "thinking" | "working" }) {
	return (
		<div className="flex flex-col items-start gap-1.5">
			<div className="flex items-center gap-2.5 self-start rounded-2xl rounded-bl-md border border-slate-700/60 bg-slate-800/80 px-4 py-2.5 text-sm text-slate-300">
				<span aria-hidden className="flex items-end gap-1">
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms]" />
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms]" />
				</span>
				<span>{phase === "thinking" ? "思考中…" : "执行中…"}</span>
				<span className="tabular-nums text-slate-500">{elapsed}s</span>
			</div>
		</div>
	);
}

/** 顶部常驻的计划面板（v0.22.0）：全部完成后收起成一行。 */
function PlanPanel({ plan }: { plan: PlanStep[] }) {
	if (!plan.length) return null;
	const done = plan.filter((s) => s.status === "completed").length;
	const body =
		done === plan.length ? (
			<details className="rounded-xl border border-emerald-500/25 bg-emerald-950/20 px-3 py-1.5 text-xs text-emerald-200/80">
				<summary className="inline-flex cursor-pointer items-center gap-1.5">
					<Icon name="done" className="h-3.5 w-3.5 text-emerald-400" />
					计划已完成（{plan.length} 步）
				</summary>
				<ul className="mt-1.5 space-y-0.5 text-[12.5px] text-slate-400">
					{plan.map((step, index) => (
						<li key={`${index}-${step.title}`} className="flex items-start gap-1.5">
							<Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400/80" />
							<span>{step.title}</span>
						</li>
					))}
				</ul>
			</details>
		) : (
			<PlanCard steps={plan} />
		);
	// 吸顶：滚动查看历史时不丢掉当前进度（背景用不透明色，避免正文透出来）
	return <div className="sticky top-0 z-10 -mx-1 bg-slate-950 px-1 py-1">{body}</div>;
}

/** 本会话产出文件（v0.22.0）：历史回放时也能一键打开工作台预览。 */
function ArtifactSummary({ files, onOpen }: { files: FileInfo[]; onOpen?: (name: string) => void }) {
	if (files.length === 0) return null;
	return (
		<div className="w-full rounded-xl border border-cyan-500/35 bg-cyan-950/40">
			<div className="flex items-center gap-2 border-b border-cyan-500/25 px-3 py-1.5">
				<Icon name="folder" className="h-4 w-4 text-cyan-400" />
				<span className="text-xs font-medium text-slate-200">产出文件</span>
				<span className="tabular-nums text-[11px] text-cyan-300/80">{files.length}</span>
			</div>
			<ul className="flex flex-wrap gap-1 p-2">
				{files.slice(0, 12).map((file) => (
					<li key={file.name}>
						<button
							type="button"
							onClick={() => onOpen?.(file.name)}
							disabled={!onOpen}
							className="rounded-lg border border-cyan-500/30 px-2 py-1 text-[12px] text-cyan-200 transition-colors enabled:hover:border-cyan-400 enabled:hover:bg-cyan-500/10"
						>
							{file.name}
						</button>
					</li>
				))}
			</ul>
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
	/** 当前会话的计划（update_plan）。 */
	plan: PlanStep[];
	/** 当前会话工作台里的文件（历史回放时显示产出清单）。 */
	files?: FileInfo[];
	/** 打开某个产出文件（右栏预览）。 */
	onOpenFile?: (name: string) => void;
	/** 从某条用户消息分叉出新会话（v0.32.0）。 */
	onBranch?: (entryId: number) => void;
}

export function MessageList({ messages, pending, elapsed, loading, loadError, onRetry, plan, files = [], onOpenFile, onBranch }: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);

	// 新内容到达时：若用户本来就在底部附近则自动滚动，否则保持当前位置
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [messages, pending, elapsed, plan]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
	};

	const isEmpty = messages.length === 0 && !pending;
	// 最后一条助手消息在 pending 期间仍在流式（思考块自动展开）
	const lastAssistantId = pending
		? [...messages].reverse().find((m) => m.role === "assistant")?.id
		: undefined;
	// 整个会话里最后一条助手消息（产出文件清单挂在它下面）
	const lastAssistantIdAll = [...messages].reverse().find((m) => m.role === "assistant")?.id;

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
							回复由 Cloudflare Worker 生成，多步任务会先列计划、再逐步执行。
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

				<PlanPanel plan={plan} />

				{messages.map((message, index) => {
					switch (message.role) {
						case "user":
							// 第一条消息之前没有历史，不能分叉（v0.32.0）
							return <UserBubble key={message.id} message={message} onBranch={index > 0 ? onBranch : undefined} />;
						case "assistant": {
							const isLast = message.id === lastAssistantIdAll;
							return (
								<div key={message.id} className="flex w-full flex-col items-start gap-1.5">
									<AssistantBubble
										message={message}
										streaming={message.id === lastAssistantId}
										onOpenFile={onOpenFile}
									/>
									{isLast && !pending && <ArtifactSummary files={files} onOpen={onOpenFile} />}
								</div>
							);
						}
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

				{pending && <PendingBubble elapsed={elapsed} phase={elapsed > 3 ? "working" : "thinking"} />}
			</div>
		</main>
	);
}

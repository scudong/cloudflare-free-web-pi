interface ChatHeaderProps {
	sessionId: string;
	sessionTitle: string;
	pending: boolean;
}

/** Slim status strip on top of the chat column: current model + session id. */
export function ChatHeader({ sessionId, sessionTitle, pending }: ChatHeaderProps) {
	return (
		<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 bg-slate-900/40 px-4 text-xs">
			<div className="flex shrink-0 items-center gap-2">
				<span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-300">deepseek-flash</span>
				<span className="hidden text-slate-500 sm:inline">当前模型</span>
			</div>
			<div className="flex min-w-0 items-center gap-2 text-slate-400">
				{pending && <span className="shrink-0 text-amber-300/80">生成中…</span>}
				<span className="min-w-0 truncate">
					会话 #{sessionId}
					{sessionTitle ? ` · ${sessionTitle}` : ""}
				</span>
			</div>
		</div>
	);
}

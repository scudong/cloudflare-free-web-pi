interface ChatHeaderProps {
	sessionId: string;
	sessionTitle: string;
	pending: boolean;
	/** 可选模型与当前模型（v6）。 */
	models: string[];
	model: string;
	onModelChange: (model: string) => void;
}

/** Slim status strip on top of the chat column: current model + session id. */
export function ChatHeader({ sessionId, sessionTitle, pending, models, model, onModelChange }: ChatHeaderProps) {
	return (
		<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 bg-slate-900/40 px-4 text-xs">
			<div className="flex shrink-0 items-center gap-2">
				<label className="flex items-center gap-1.5">
					<select
						value={model}
						onChange={(e) => onModelChange(e.target.value)}
						aria-label="选择模型"
						className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-300 outline-none"
					>
						{(models.length ? models : [model]).map((id) => (
							<option key={id} value={id} className="bg-slate-900 text-slate-100">
								{id}
							</option>
						))}
					</select>
					<span className="hidden text-slate-500 sm:inline">当前模型</span>
				</label>
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

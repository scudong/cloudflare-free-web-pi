import type { SessionListItem } from "../types";

interface SidebarProps {
	sessions: SessionListItem[];
	currentId: string;
	query: string;
	sessionsLoading: boolean;
	memoryCount: number;
	onQueryChange: (query: string) => void;
	onSelect: (id: string) => void;
	onNewSession: () => void;
	onOpenMemories: () => void;
}

function formatSessionTime(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Left column: new-session button + search, session list (current highlighted),
 * and the memory-library entry with a count badge at the bottom.
 */
export function Sidebar({
	sessions,
	currentId,
	query,
	sessionsLoading,
	memoryCount,
	onQueryChange,
	onSelect,
	onNewSession,
	onOpenMemories,
}: SidebarProps) {
	const keyword = query.trim().toLowerCase();
	const filtered = keyword ? sessions.filter((s) => s.title.toLowerCase().includes(keyword) || s.id.includes(keyword)) : sessions;

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<div className="shrink-0 space-y-2.5 border-b border-slate-800/70 p-3">
				<button
					type="button"
					onClick={onNewSession}
					className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span aria-hidden className="text-base leading-none">
						+
					</span>
					新会话
				</button>
				<input
					type="search"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder="搜索会话…"
					aria-label="搜索会话"
					className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/40"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				<p className="px-1.5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">会话</p>
				{sessionsLoading && filtered.length === 0 && (
					<p className="px-1.5 py-2 text-xs text-slate-500">正在加载会话…</p>
				)}
				{!sessionsLoading && filtered.length === 0 && (
					<p className="px-1.5 py-2 text-xs text-slate-500">{keyword ? "没有匹配的会话。" : "暂无会话。"}</p>
				)}
				<ul className="space-y-0.5">
					{filtered.map((session) => {
						const current = session.id === currentId;
						return (
							<li key={session.id}>
								<button
									type="button"
									onClick={() => onSelect(session.id)}
									aria-current={current ? "true" : undefined}
									className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
										current
											? "border-sky-500/40 bg-sky-500/15 text-white"
											: "border-transparent text-slate-300 hover:bg-slate-800 hover:text-slate-100"
									}`}
								>
									<span aria-hidden className="shrink-0 text-sm">
										{current ? "💬" : "○"}
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{session.title}</span>
										{session.createdAt && (
											<span className="block text-[11px] text-slate-500">{formatSessionTime(session.createdAt)}</span>
										)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="shrink-0 border-t border-slate-800/70 p-2">
				<button
					type="button"
					onClick={onOpenMemories}
					className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
				>
					<span aria-hidden className="shrink-0">
						🧠
					</span>
					<span className="min-w-0 flex-1 truncate">记忆库</span>
					<span className="shrink-0 rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-200">
						{memoryCount}
					</span>
				</button>
			</div>
		</div>
	);
}

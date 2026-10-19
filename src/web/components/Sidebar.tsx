import type { SessionListItem } from "../types";

interface SidebarProps {
	sessions: SessionListItem[];
	currentId: string;
	query: string;
	sessionsLoading: boolean;
	onQueryChange: (query: string) => void;
	onSelect: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
}

function formatSessionTime(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Left column content: search + session list (current highlighted).
 * 新会话按钮在左侧 Rail 上（v0.21.0）；记忆库入口在设置弹窗里。
 */
export function Sidebar({
	sessions,
	currentId,
	query,
	sessionsLoading,
	onQueryChange,
	onSelect,
	onRename,
	onDelete,
}: SidebarProps) {
	const keyword = query.trim().toLowerCase();
	const filtered = keyword ? sessions.filter((s) => s.title.toLowerCase().includes(keyword) || s.id.includes(keyword)) : sessions;

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<div className="shrink-0 border-b border-slate-800/70 p-3">
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
							<li key={session.id} className="group relative">
								<button
									type="button"
									onClick={() => onSelect(session.id)}
									aria-current={current ? "true" : undefined}
									className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 pr-12 text-left transition-colors ${
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
								<span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex group-focus-within:flex">
									<button
										type="button"
										title="重命名"
										aria-label={`重命名 ${session.title}`}
										onClick={(e) => {
											e.stopPropagation();
											const next = window.prompt("新的会话名称", session.title);
											if (next && next.trim() && next.trim() !== session.title) onRename(session.id, next.trim());
										}}
										className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
									>
										✎
									</button>
									<button
										type="button"
										title="删除"
										aria-label={`删除 ${session.title}`}
										onClick={(e) => {
											e.stopPropagation();
											if (window.confirm(`删除会话「${session.title}」？该会话的文件也会一并删除。`)) onDelete(session.id);
										}}
										className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
									>
										🗑
									</button>
								</span>
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}

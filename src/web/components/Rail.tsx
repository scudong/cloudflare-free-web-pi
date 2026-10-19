export type RailView = "sessions" | "mcp" | "automations" | "skills";

interface RailProps {
	view: RailView;
	onViewChange: (view: RailView) => void;
	onNewSession: () => void;
	newSessionDisabled?: boolean;
	onOpenSettings: () => void;
}

const railButton =
	"flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 aria-pressed:bg-sky-500/15 aria-pressed:text-sky-300";

/** 最左侧固定工具栏（v0.21.0）：新会话 + 会话/连接/定时/技能切换 + 设置。 */
export function Rail({ view, onViewChange, onNewSession, newSessionDisabled, onOpenSettings }: RailProps) {
	const item = (value: RailView, label: string, icon: string) => (
		<button
			key={value}
			type="button"
			onClick={() => onViewChange(value)}
			aria-pressed={view === value}
			title={label}
			aria-label={label}
			className={railButton}
		>
			<span aria-hidden className="text-base leading-none">
				{icon}
			</span>
		</button>
	);
	return (
		<nav
			aria-label="主导航"
			className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-slate-800/70 bg-slate-950/40 py-2"
		>
			<button
				type="button"
				onClick={onNewSession}
				disabled={newSessionDisabled}
				title="新会话"
				aria-label="新建会话"
				className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-600/90 text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
			>
				<span aria-hidden className="text-lg leading-none">
					＋
				</span>
			</button>
			<div aria-hidden className="my-1 h-px w-6 bg-slate-800" />
			{item("sessions", "会话", "💬")}
			{item("mcp", "连接", "🔌")}
			{item("automations", "定时", "⏰")}
			{item("skills", "能力", "⚡")}
			<div aria-hidden className="flex-1" />
			<button type="button" onClick={onOpenSettings} title="设置" aria-label="打开设置" className={railButton}>
				<span aria-hidden className="text-base leading-none">
					⚙️
				</span>
			</button>
		</nav>
	);
}

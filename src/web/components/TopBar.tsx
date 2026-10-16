interface TopBarProps {
	online: boolean;
	sessionLabel: string;
	leftOpen: boolean;
	rightOpen: boolean;
	onToggleLeft: () => void;
	onToggleRight: () => void;
	onOpenDrawer: () => void;
}

/** Collapsed/expanded state icon for a side panel (filled inner bar = expanded). */
function PanelIcon({ side, active }: { side: "left" | "right"; active: boolean }) {
	return (
		<svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
			<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
			{side === "left" ? (
				<>
					<line x1="7.5" y1="3.75" x2="7.5" y2="16.25" />
					{active && <rect x="3.75" y="4.75" width="2.75" height="10.5" rx="1" fill="currentColor" stroke="none" opacity="0.55" />}
				</>
			) : (
				<>
					<line x1="12.5" y1="3.75" x2="12.5" y2="16.25" />
					{active && <rect x="13.5" y="4.75" width="2.75" height="10.5" rx="1" fill="currentColor" stroke="none" opacity="0.55" />}
				</>
			)}
		</svg>
	);
}

/** Hamburger icon for opening the session drawer on mobile. */
function MenuIcon() {
	return (
		<svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
			<line x1="3" y1="5.5" x2="17" y2="5.5" />
			<line x1="3" y1="10" x2="17" y2="10" />
			<line x1="3" y1="14.5" x2="17" y2="14.5" />
		</svg>
	);
}

const panelButton =
	"hidden h-8 w-8 items-center justify-center rounded-lg border border-transparent text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 aria-pressed:border-slate-700 aria-pressed:bg-slate-800 aria-pressed:text-sky-300 md:inline-flex";

export function TopBar({ online, sessionLabel, leftOpen, rightOpen, onToggleLeft, onToggleRight, onOpenDrawer }: TopBarProps) {
	return (
		<header className="z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/80 px-3 backdrop-blur">
			<div className="flex min-w-0 items-center gap-2.5">
				<button
					type="button"
					onClick={onOpenDrawer}
					aria-label="打开会话列表"
					className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-800 hover:text-white md:hidden"
				>
					<MenuIcon />
				</button>
				<span
					aria-hidden
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-base font-semibold text-sky-400"
				>
					π
				</span>
				<h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-slate-100">π Harness</h1>
				<span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-700/70 px-2 py-0.5 text-xs text-slate-400">
					<span
						aria-hidden
						className={`h-1.5 w-1.5 rounded-full ${online ? "animate-pulse bg-emerald-400" : "bg-red-400"}`}
					/>
					{online ? "在线" : "离线"}
				</span>
				{sessionLabel && <span className="hidden min-w-0 truncate text-xs text-slate-500 lg:inline">{sessionLabel}</span>}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onClick={onToggleLeft}
					aria-pressed={leftOpen}
					aria-label={leftOpen ? "收起会话栏" : "展开会话栏"}
					title={leftOpen ? "收起会话栏" : "展开会话栏"}
					className={panelButton}
				>
					<PanelIcon side="left" active={leftOpen} />
				</button>
				<button
					type="button"
					onClick={onToggleRight}
					aria-pressed={rightOpen}
					aria-label={rightOpen ? "收起工作台" : "展开工作台"}
					title={rightOpen ? "收起工作台" : "展开工作台"}
					className={panelButton}
				>
					<PanelIcon side="right" active={rightOpen} />
				</button>
			</div>
		</header>
	);
}

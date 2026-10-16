interface TopBarProps {
	online: boolean;
	sessionName: string;
	resetting: boolean;
	onReset: () => void;
}

export function TopBar({ online, sessionName, resetting, onReset }: TopBarProps) {
	return (
		<header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/80 px-4 backdrop-blur">
			<div className="flex min-w-0 items-center gap-2.5">
				<span
					aria-hidden
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-base font-semibold text-sky-400"
				>
					π
				</span>
				<h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">π Harness</h1>
				<span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-700/70 px-2 py-0.5 text-xs text-slate-400">
					<span
						aria-hidden
						className={`h-1.5 w-1.5 rounded-full ${online ? "animate-pulse bg-emerald-400" : "bg-red-400"}`}
					/>
					{online ? "在线" : "离线"}
				</span>
				{sessionName && (
					<span className="hidden min-w-0 truncate text-xs text-slate-500 sm:inline">{sessionName}</span>
				)}
			</div>
			<button
				type="button"
				onClick={onReset}
				disabled={resetting}
				className="shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
			>
				{resetting ? "重置中…" : "新会话"}
			</button>
		</header>
	);
}

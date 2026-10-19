import type { PlanStep } from "../types";

/** 计划卡片（v0.22.0）：由 update_plan 工具驱动，实时反映每一步状态。 */
export function PlanCard({ steps }: { steps: PlanStep[] }) {
	if (!steps.length) return null;
	const done = steps.filter((s) => s.status === "completed").length;
	const allDone = done === steps.length;

	return (
		<div className="w-full max-w-[92%] overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900/70">
			<div className="flex items-center gap-2 border-b border-slate-800/80 px-3 py-1.5">
				<span aria-hidden>{allDone ? "✅" : "🗒️"}</span>
				<span className="text-xs font-medium text-slate-200">计划</span>
				<span className="tabular-nums text-[11px] text-slate-500">
					{done}/{steps.length}
				</span>
				<div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-slate-800">
					<div
						className={`h-full rounded-full transition-all ${allDone ? "bg-emerald-500" : "bg-sky-500"}`}
						style={{ width: `${Math.round((done / steps.length) * 100)}%` }}
					/>
				</div>
			</div>
			<ol className="space-y-0.5 px-3 py-2">
				{steps.map((step, index) => {
					const icon =
						step.status === "completed" ? "✓" : step.status === "in_progress" ? "◐" : "○";
					const tone =
						step.status === "completed"
							? "text-slate-500 line-through decoration-slate-600"
							: step.status === "in_progress"
								? "text-sky-200"
								: "text-slate-400";
					return (
						<li key={`${index}-${step.title}`} className="flex items-start gap-2 text-[13px] leading-relaxed">
							<span
								aria-hidden
								className={`mt-0.5 shrink-0 tabular-nums ${
									step.status === "completed"
										? "text-emerald-400"
										: step.status === "in_progress"
											? "animate-pulse text-sky-400"
											: "text-slate-600"
								}`}
							>
								{icon}
							</span>
							<span className={tone}>{step.title}</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

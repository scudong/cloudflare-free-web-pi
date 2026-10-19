import { useEffect, useState } from "react";
import type { GoalInfo } from "../types";

/** 目标状态的中文标签。 */
const STATUS_LABEL: Record<GoalInfo["status"], string> = {
	active: "进行中",
	done: "已完成",
	blocked: "受阻",
	paused: "已暂停",
	exhausted: "已达上限",
};

/** 进度条颜色：进行中琥珀、完成绿、受阻/上限红、暂停灰。 */
function barTone(status: GoalInfo["status"]): string {
	if (status === "done") return "bg-emerald-500";
	if (status === "blocked" || status === "exhausted") return "bg-rose-500";
	if (status === "paused") return "bg-slate-500";
	return "bg-amber-500";
}

interface GoalBarProps {
	goal: GoalInfo;
	/** 停止自动续转（v0.31.0）。 */
	onStop: () => void;
	/** 重新设定目标。 */
	onNew: () => void;
}

/** 输入框上方的目标条：目标、状态、轮次、token 预算进度。 */
export function GoalBar({ goal, onStop, onNew }: GoalBarProps) {
	const pct = Math.min(100, Math.round((goal.tokensUsed / Math.max(1, goal.tokenBudget)) * 100));
	const active = goal.status === "active";
	return (
		<div className="shrink-0 border-t border-slate-800/70 bg-slate-900/50 px-4 py-2" aria-label="目标状态">
			<div className="mx-auto flex max-w-3xl items-start gap-3">
				<span aria-hidden className="mt-0.5 text-base leading-none">
					🎯
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
						<span className={active ? "font-medium text-amber-300" : "font-medium text-slate-300"}>
							目标 · {STATUS_LABEL[goal.status]}
						</span>
						<span className="text-slate-500">
							第 {goal.turns}/{goal.maxTurns} 轮 · {goal.tokensUsed.toLocaleString()} /{" "}
							{goal.tokenBudget.toLocaleString()} tokens
						</span>
					</div>
					<p className="mt-0.5 truncate text-sm text-slate-200" title={goal.objective}>
						{goal.objective}
					</p>
					{goal.summary && <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{goal.summary}</p>}
					<div
						className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-700/60 ring-1 ring-inset ring-slate-700/80"
						role="progressbar"
						aria-valuenow={pct}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label="目标预算使用进度"
					>
						<div className={`h-full rounded-full transition-[width] ${barTone(goal.status)}`} style={{ width: `${pct}%` }} />
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{active && (
						<button
							type="button"
							onClick={onStop}
							className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-rose-500/50 hover:text-rose-300"
						>
							停止
						</button>
					)}
					<button
						type="button"
						onClick={onNew}
						className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300 transition-colors hover:bg-amber-500/20"
					>
						新目标
					</button>
				</div>
			</div>
		</div>
	);
}

interface GoalDialogProps {
	open: boolean;
	onClose: () => void;
	/** 提交后由 App 建立目标并发出第一轮消息。 */
	onSubmit: (objective: string, tokenBudget: number, maxTurns: number) => Promise<boolean>;
}

/** 建立目标的弹窗：目标描述 + token 预算 + 最大轮次。 */
export function GoalDialog({ open, onClose, onSubmit }: GoalDialogProps) {
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState(200000);
	const [turns, setTurns] = useState(12);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setObjective("");
			setError(null);
			setBusy(false);
		}
	}, [open]);

	if (!open) return null;

	const submit = async () => {
		const text = objective.trim();
		if (!text) {
			setError("先写清楚要达成的目标。");
			return;
		}
		setBusy(true);
		setError(null);
		const ok = await onSubmit(text, budget, turns);
		setBusy(false);
		if (ok) onClose();
		else setError("建立目标失败，请重试。");
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="设定目标"
				className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="text-base font-semibold text-slate-100">🎯 设定目标</h2>
				<p className="mt-1 text-xs leading-relaxed text-slate-500">
					设定后模型会自己一轮轮推进，直到完成（需给出验证证据）、预算用尽或报告受阻。每一轮都可以在聊天里看到。
				</p>
				<label className="mt-4 block text-xs text-slate-400">
					目标
					<textarea
						value={objective}
						onChange={(e) => setObjective(e.target.value)}
						rows={3}
						placeholder="例如：调研 3 家云厂商的 Durable Objects 计费并写一份对比报告到 report.md"
						className="mt-1 w-full resize-none rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/60"
					/>
				</label>
				<div className="mt-3 grid grid-cols-2 gap-2">
					<label className="text-xs text-slate-400">
						token 预算
						<input
							type="number"
							min={10000}
							step={10000}
							value={budget}
							onChange={(e) => setBudget(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
						/>
					</label>
					<label className="text-xs text-slate-400">
						最多自动续转轮次
						<input
							type="number"
							min={1}
							max={50}
							value={turns}
							onChange={(e) => setTurns(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
						/>
					</label>
				</div>
				{error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-md px-3 py-1.5 text-sm text-slate-400 transition-colors hover:text-slate-200"
					>
						取消
					</button>
					<button
						type="button"
						onClick={() => void submit()}
						disabled={busy}
						className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
					>
						{busy ? "启动中…" : "开始"}
					</button>
				</div>
			</div>
		</div>
	);
}

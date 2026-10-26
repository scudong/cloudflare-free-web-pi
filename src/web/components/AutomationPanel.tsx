import { useState } from "react";
import { automationOutputSessionId } from "../lib/automation-edit";
import { formatLastRunAt } from "../lib/format";
import { AutomationEditDialog } from "./AutomationEditDialog";
import { Icon } from "./Icon";
import { PanelHeader } from "./PanelHeader";
import type { AutomationInfo, AutomationPatch, AutomationRunStatus } from "../types";

/** 上次运行结果徽标（NERE-68 2b）：三种状态文案 / 色板各不相同，未知状态不渲染。 */
const RUN_STATUS_META: Record<AutomationRunStatus, { label: string; className: string }> = {
	ok: { label: "成功", className: "bg-emerald-500/10 text-emerald-300" },
	failed: { label: "失败", className: "bg-rose-500/10 text-rose-300" },
	deferred: { label: "顺延", className: "bg-amber-500/10 text-amber-300" },
};

function AutomationStatusBadge({ status }: { status: AutomationRunStatus }) {
	const meta = RUN_STATUS_META[status];
	return (
		<span
			className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${meta.className}`}
			title={`上次运行：${meta.label}`}
		>
			{meta.label}
		</span>
	);
}

/**
 * 定时任务的上次运行（NERE-68）：没有 `last_run_at` 与 `last_status` 时整行不渲染；
 * 有状态就渲染徽标（失败 / 顺延警示色），有归属会话时附「查看产出」跳转入口。
 */
function AutomationLastRun({
	job,
	onOpenSession,
}: {
	job: AutomationInfo;
	onOpenSession?: (sessionId: string) => void;
}) {
	const lastRunLabel = formatLastRunAt(job.lastRunAt);
	const status = job.lastStatus;
	if (!lastRunLabel && !status) return null;
	// NERE-86：跳最近一次执行实际用的会话；老数据回落到绑定会话。
	const sessionId = automationOutputSessionId(job);
	return (
		<>
			<p className="mt-0.5 text-[11px] text-slate-600">
				{lastRunLabel ? `上次 ${lastRunLabel}` : "上次运行"}
				{status && <AutomationStatusBadge status={status} />}
				{lastRunLabel && sessionId && onOpenSession && (
					<>
						{" · "}
						<button
							type="button"
							onClick={() => onOpenSession(sessionId)}
							aria-label={`查看 ${job.name} 上次运行的产出`}
							className="text-sky-400 hover:text-sky-300 hover:underline"
						>
							查看产出
						</button>
					</>
				)}
			</p>
			{/* 失败原因（v1.0.4）：服务端把异常消息写进 last_error，失败时展示给用户自查。 */}
			{status === "failed" && job.lastError && (
				<p className="mt-0.5 break-all text-[10.5px] leading-relaxed text-rose-400/80" title={job.lastError}>
					{job.lastError.length > 160 ? `${job.lastError.slice(0, 160)}…` : job.lastError}
				</p>
			)}
		</>
	);
}

/** 左栏「定时」：定时任务管理（v0.21.0 从工作台移入左侧工具栏）。 */
export function AutomationPanel({
	items,
	loading,
	error,
	onAdd,
	onToggle,
	onDelete,
	onUpdate,
	onRun,
	defaultSessionId = "",
	onOpenSession,
	onCollapse,
}: {
	items: AutomationInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, prompt: string, schedule: { kind: string; time?: string; minutes?: number }) => Promise<boolean>;
	onToggle: (id: string, enabled: boolean) => Promise<boolean>;
	onDelete: (id: string) => Promise<boolean>;
	/** 编辑保存（NERE-65）：走 PATCH，失败时返回可展示文案。 */
	onUpdate: (patch: AutomationPatch) => Promise<{ ok: boolean; error?: string }>;
	/** 立即运行（v1.0.4）：手动补跑一次；完整 chat 回合可能耗时几分钟，由调用方刷新列表。 */
	onRun?: (id: string) => Promise<{ ok: boolean; error?: string }>;
	/** 任务没有记录会话时的兜底回填。 */
	defaultSessionId?: string;
	/** 「查看产出」（NERE-68）：切到该任务上次运行的会话；缺省时不渲染入口。 */
	onOpenSession?: (sessionId: string) => void;
	onCollapse?: () => void;
}) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [kind, setKind] = useState<"daily" | "interval">("daily");
	const [time, setTime] = useState("09:00");
	const [minutes, setMinutes] = useState("60");
	const [busy, setBusy] = useState(false);
	/** 正在编辑的任务；非空即弹出编辑弹窗（NERE-65）。 */
	const [editing, setEditing] = useState<AutomationInfo | null>(null);
	/** 正在手动运行的任务（v1.0.4）：完整 chat 回合可能几分钟，按钮锁定到返回。 */
	const [runningId, setRunningId] = useState<string | null>(null);

	const runJob = (job: AutomationInfo) => {
		if (!onRun || runningId) return;
		setRunningId(job.id);
		void (async () => {
			const result = await onRun(job.id);
			if (!result.ok && result.error) window.alert(`立即运行失败：${result.error}`);
			setRunningId(null);
		})();
	};

	const submit = () => {
		if (!name.trim() || !prompt.trim() || busy) return;
		setBusy(true);
		void (async () => {
			const ok = await onAdd(
				name.trim(),
				prompt.trim(),
				kind === "daily" ? { kind, time } : { kind, minutes: Number(minutes) || 60 },
			);
			if (ok) {
				setName("");
				setPrompt("");
			}
			setBusy(false);
		})();
	};

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<PanelHeader title="定时任务" count={items.length} onCollapse={onCollapse} />
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="名称，如 每日摘要"
					aria-label="定时任务名称"
					className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="到点后发给助手的提示词"
					aria-label="定时任务提示词"
					rows={2}
					className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<div className="flex items-center gap-1.5">
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as "daily" | "interval")}
						aria-label="调度类型"
						className="rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
					>
						<option value="daily">每天</option>
						<option value="interval">每隔</option>
					</select>
					{kind === "daily" ? (
						<input
							type="time"
							value={time}
							onChange={(e) => setTime(e.target.value)}
							aria-label="执行时间"
							className="rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
						/>
					) : (
						<>
							<input
								type="number"
								min={1}
								value={minutes}
								onChange={(e) => setMinutes(e.target.value)}
								aria-label="间隔分钟"
								className="w-16 rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
							/>
							<span className="text-xs text-slate-500">分钟</span>
						</>
					)}
					<button
						type="button"
						onClick={submit}
						disabled={busy || !name.trim() || !prompt.trim()}
						className="ml-auto rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
					>
						{busy ? "创建中…" : "创建"}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{loading && items.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
				{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
				{!loading && items.length === 0 && !error && (
					<p className="px-1 py-2 text-xs text-slate-500">还没有定时任务。到点后助手会在指定会话里自动执行。</p>
				)}
				<ul className="space-y-1">
					{items.map((job) => (
						<li key={job.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
							<div className="flex items-center gap-2">
								<span aria-hidden className="text-xs">
									{job.enabled ? "⏰" : "⏸"}
								</span>
								<span className="min-w-0 flex-1 truncate text-[13px] text-slate-100">{job.name}</span>
								<button
									type="button"
									title="编辑"
									aria-label={`编辑 ${job.name}`}
									onClick={() => setEditing(job)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
								>
									<Icon name="edit" className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									title={runningId === job.id ? "运行中，完成后刷新" : "立即运行一次（不走闹钟）"}
									aria-label={`立即运行 ${job.name}`}
									disabled={runningId === job.id}
									onClick={() => runJob(job)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-50"
								>
									{runningId === job.id ? "运行中…" : "运行"}
								</button>
								<button
									type="button"
									title={job.enabled ? "暂停" : "启用"}
									aria-label={`${job.enabled ? "暂停" : "启用"} ${job.name}`}
									onClick={() => void onToggle(job.id, !job.enabled)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
								>
									{job.enabled ? "暂停" : "启用"}
								</button>
								<button
									type="button"
									title="删除"
									aria-label={`删除 ${job.name}`}
									onClick={() => {
										if (window.confirm(`删除定时任务「${job.name}」？`)) void onDelete(job.id);
									}}
									className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
								>
									<Icon name="trash" className="h-3.5 w-3.5" />
								</button>
							</div>
							<p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{job.prompt}</p>
							<p className="mt-0.5 text-[11px] text-slate-600">
								{job.scheduleLabel}
								{job.nextLabel ? ` · 下次 ${job.nextLabel}` : ""}
							</p>
							<AutomationLastRun job={job} onOpenSession={onOpenSession} />
						</li>
					))}
				</ul>
			</div>
			{editing && (
				<AutomationEditDialog
					key={editing.id}
					job={editing}
					defaultSessionId={defaultSessionId}
					onClose={() => setEditing(null)}
					onSave={onUpdate}
				/>
			)}
		</div>
	);
}

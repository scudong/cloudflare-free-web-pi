/**
 * 定时任务编辑弹窗（NERE-65）：名称 / 提示词 / 执行时间 / 会话。
 *
 * 打开即回填当前值；前端先校验，保存走 PATCH（NERE-64），失败保留输入并显示文案。
 * 外壳复用 ModalShell（NERE-62），本组件不直接发请求，保存由页面层注入。
 */

import { useId, useState } from "react";
import {
	AUTOMATION_NAME_MAX,
	AUTOMATION_PROMPT_MAX,
	draftFromJob,
	submitAutomationDraft,
	type AutomationDraft,
	type AutomationDraftField,
} from "../lib/automation-edit";
import type { AutomationInfo, AutomationPatch } from "../types";
import { ModalShell } from "./ModalShell";

export interface AutomationEditDialogProps {
	/** 要编辑的任务；弹窗只在有值时挂载，天然每次打开都重新回填。 */
	job: AutomationInfo;
	/** 当前会话：任务没有记录会话时的兜底回填。 */
	defaultSessionId?: string;
	onClose: () => void;
	/** 返回 `ok=false` 时保留输入并展示 `error`。 */
	onSave: (patch: AutomationPatch) => Promise<{ ok: boolean; error?: string }>;
}

const inputClass =
	"w-full rounded-md border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

export function AutomationEditDialog({ job, defaultSessionId = "", onClose, onSave }: AutomationEditDialogProps) {
	const [draft, setDraft] = useState<AutomationDraft>(() => draftFromJob(job, defaultSessionId));
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ error: string; field?: AutomationDraftField } | null>(null);
	const fieldId = useId();

	const update = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setFailure(null);
	};

	const submit = () => {
		if (busy) return;
		setBusy(true);
		setFailure(null);
		void submitAutomationDraft(job, draft, onSave).then((result) => {
			if (result.ok) {
				onClose();
				return;
			}
			setFailure({ error: result.error, field: result.field });
			setBusy(false);
		});
	};

	const invalid = (field: AutomationDraftField) => (failure?.field === field ? true : undefined);
	const nameId = `${fieldId}-name`;
	const promptId = `${fieldId}-prompt`;
	const timeId = `${fieldId}-time`;
	const minutesId = `${fieldId}-minutes`;
	const sessionId = `${fieldId}-session`;

	return (
		<ModalShell
			open
			title="编辑定时任务"
			size="md"
			onClose={busy ? () => undefined : onClose}
			closeOnScrim={!busy}
			testId="automation-edit-modal"
			footer={
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-[11px] text-slate-500">保存后按新调度重算下次运行时间。</span>
					<span className="flex items-center gap-2">
						<button
							type="button"
							onClick={onClose}
							disabled={busy}
							className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-40"
						>
							取消
						</button>
						<button
							type="button"
							onClick={submit}
							disabled={busy}
							className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
						>
							{busy ? "保存中…" : "保存"}
						</button>
					</span>
				</div>
			}
		>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">
				<div className="space-y-1.5">
					<div className="flex items-baseline justify-between">
						<label htmlFor={nameId} className="text-xs font-medium text-slate-300">
							名称
						</label>
						<span className={`text-[11px] tabular-nums ${draft.name.length > AUTOMATION_NAME_MAX ? "text-rose-300" : "text-slate-500"}`}>
							{draft.name.length}/{AUTOMATION_NAME_MAX}
						</span>
					</div>
					<input
						id={nameId}
						value={draft.name}
						onChange={(e) => update("name", e.target.value)}
						maxLength={AUTOMATION_NAME_MAX}
						placeholder="如 每日科技日报"
						aria-label="任务名称"
						aria-invalid={invalid("name")}
						className={inputClass}
					/>
				</div>

				<div className="space-y-1.5">
					<div className="flex items-baseline justify-between">
						<label htmlFor={promptId} className="text-xs font-medium text-slate-300">
							提示词
						</label>
						<span className={`text-[11px] tabular-nums ${draft.prompt.length > AUTOMATION_PROMPT_MAX ? "text-rose-300" : "text-slate-500"}`}>
							{draft.prompt.length}/{AUTOMATION_PROMPT_MAX}
						</span>
					</div>
					<textarea
						id={promptId}
						value={draft.prompt}
						onChange={(e) => update("prompt", e.target.value)}
						maxLength={AUTOMATION_PROMPT_MAX}
						rows={6}
						placeholder="到点后发给助手的提示词"
						aria-label="任务提示词"
						aria-invalid={invalid("prompt")}
						className={`${inputClass} resize-y`}
					/>
				</div>

				<div className="space-y-1.5">
					<span className="block text-xs font-medium text-slate-300">执行时间</span>
					<div className="flex flex-wrap items-center gap-2">
						<select
							value={draft.kind}
							onChange={(e) => update("kind", e.target.value as AutomationDraft["kind"])}
							aria-label="调度类型"
							className="rounded-md border border-slate-700 bg-slate-800/70 px-2 py-2 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
						>
							<option value="daily">每天</option>
							<option value="interval">每隔</option>
						</select>
						{draft.kind === "daily" ? (
							<input
								id={timeId}
								type="time"
								value={draft.time}
								onChange={(e) => update("time", e.target.value)}
								aria-label="执行时间"
								aria-invalid={invalid("time")}
								className="rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
							/>
						) : (
							<>
								<input
									id={minutesId}
									type="number"
									min={1}
									step={1}
									value={draft.minutes}
									onChange={(e) => update("minutes", e.target.value)}
									aria-label="间隔分钟"
									aria-invalid={invalid("minutes")}
									className="w-24 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
								/>
								<span className="text-xs text-slate-500">分钟</span>
							</>
						)}
					</div>
					<p className="text-[11px] text-slate-500">daily 按北京时间（UTC+8）执行；interval 从保存时刻起算。</p>
				</div>

				<div className="space-y-1.5">
					<label htmlFor={sessionId} className="text-xs font-medium text-slate-300">
						会话 ID <span className="font-normal text-slate-500">（可选）</span>
					</label>
					<input
						id={sessionId}
						value={draft.sessionId}
						onChange={(e) => update("sessionId", e.target.value)}
						placeholder="可留空；留空时到点写入默认会话"
						aria-label="会话 ID"
						className={`${inputClass} font-mono`}
					/>
				</div>

				{failure && (
					<p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
						{failure.error}
					</p>
				)}
			</div>
		</ModalShell>
	);
}

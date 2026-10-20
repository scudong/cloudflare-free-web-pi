import type { ApprovalInfo } from "../types";

const CATEGORY_LABEL: Record<string, string> = { read: "读取", write: "写入", exec: "执行" };

/** 参数预览：JSON 去掉换行，太长就截断。 */
function previewArgs(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as unknown;
		const text = JSON.stringify(parsed);
		return text && text !== "{}" ? text.slice(0, 160) : "";
	} catch {
		return raw.slice(0, 160);
	}
}

interface ApprovalBarProps {
	approvals: ApprovalInfo[];
	/** 正在提交决定（按钮禁用）。 */
	busy?: boolean;
	onDecide: (id: number, action: "once" | "always" | "deny") => void;
}

/** 输入框上方的待审批条（v0.33.0）：工具被策略拦下时出现。 */
export function ApprovalBar({ approvals, busy, onDecide }: ApprovalBarProps) {
	if (approvals.length === 0) return null;
	return (
		<div className="shrink-0 border-t border-amber-500/30 bg-amber-950/30 px-4 py-2" aria-label="待审批的工具调用">
			<div className="mx-auto flex max-w-3xl flex-col gap-2">
				{approvals.map((item) => (
					<div key={item.id} className="flex flex-wrap items-start gap-2 text-xs">
						<span aria-hidden className="mt-0.5 text-sm leading-none">
							🔐
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-x-2">
								<span className="font-medium text-amber-200">{item.tool}</span>
								<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
									{CATEGORY_LABEL[item.category] ?? item.category}级
								</span>
								<span className="text-slate-500">待确认</span>
							</div>
							{previewArgs(item.args) && (
								<p className="mt-0.5 truncate font-mono text-[11px] text-slate-400" title={item.args}>
									{previewArgs(item.args)}
								</p>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-1">
							<button
								type="button"
								disabled={busy}
								onClick={() => onDecide(item.id, "once")}
								className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
							>
								允许一次
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => onDecide(item.id, "always")}
								className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
							>
								始终允许
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => onDecide(item.id, "deny")}
								className="rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
							>
								拒绝
							</button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

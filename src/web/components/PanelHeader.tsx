import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** 左栏面板头部（NERE-43 起导出复用）：标题 + 可选操作 / 计数 / 收起。 */
export function PanelHeader({
	title,
	count,
	onCollapse,
	actions,
}: {
	title: string;
	count?: number;
	onCollapse?: () => void;
	/** 计数与收起之前的额外操作（如分享面板的刷新）。 */
	actions?: ReactNode;
}) {
	return (
		<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
			<span className="text-[12.5px] font-medium text-slate-300">{title}</span>
			<span className="flex items-center gap-1.5">
				{actions}
				{typeof count === "number" && (
					<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{count}</span>
				)}
				{onCollapse && (
					<button
						type="button"
						onClick={onCollapse}
						title="收起左栏"
						aria-label="收起左栏"
						className="inline-flex items-center justify-center rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
					>
						<Icon name="chevronsLeft" className="h-4 w-4" />
					</button>
				)}
			</span>
		</div>
	);
}


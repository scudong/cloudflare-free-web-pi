import { useState } from "react";
import type { ToolCallInfo } from "../types";

/** 折叠态下省略的子调用数量提示。 */
function childrenOf(tool: ToolCallInfo, all: ToolCallInfo[]): ToolCallInfo[] {
	if (!tool.id) return [];
	return all.filter((t) => t.parentId === tool.id);
}

/**
 * Expandable tool pill (green, pi-web read-pill style).
 * v0.22.0：codemode 脚本里发起的嵌套调用（有 parentId）挂到父调用下，可展开查看。
 */
function ToolPill({ tool, all }: { tool: ToolCallInfo; all: ToolCallInfo[] }) {
	const [open, setOpen] = useState(false);
	const full = (tool.full ?? "").trim() || tool.summary;
	const children = childrenOf(tool, all);
	const expandable = full !== tool.summary || children.length > 0;
	const running = tool.status === "running";

	return (
		<div
			className={`max-w-full self-start border text-xs ${
				tool.status === "error"
					? "border-rose-500/30 bg-rose-950/30 text-rose-200/90"
					: "border-emerald-500/30 bg-emerald-950/40 text-emerald-200/90"
			} ${open ? "rounded-xl" : "rounded-full"}`}
		>
			<button
				type="button"
				onClick={() => {
					if (expandable) setOpen((v) => !v);
				}}
				disabled={!expandable}
				aria-expanded={open}
				className="flex w-full items-center gap-1.5 rounded-[inherit] px-3 py-1 text-left transition-colors enabled:hover:bg-emerald-500/10"
			>
				<span aria-hidden className={running ? "animate-pulse" : ""}>
					{running ? "⏳" : "🔧"}
				</span>
				<span className="shrink-0 font-medium text-emerald-200">{tool.name}</span>
				{tool.summary && <span className="min-w-0 truncate">· {tool.summary}</span>}
				{children.length > 0 && (
					<span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 text-[10px] tabular-nums text-emerald-300">
						{children.length} 子调用
					</span>
				)}
				{expandable && (
					<span aria-hidden className="ml-0.5 shrink-0 text-emerald-400/70">
						{open ? "▾" : "▸"}
					</span>
				)}
			</button>
			{open && (
				<div className="rounded-b-xl border-t border-emerald-500/20 px-3 py-1.5">
					{full !== tool.summary && (
						<div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-emerald-100/80">
							{full}
						</div>
					)}
					{children.length > 0 && (
						<ul className="mt-1 space-y-0.5 border-l border-emerald-500/20 pl-2.5">
							{children.map((child, index) => (
								<li key={`${child.id}-${index}`} className="flex items-center gap-1.5 text-[11px] text-emerald-200/70">
									<span aria-hidden>{child.status === "running" ? "⏳" : child.status === "error" ? "⚠️" : "·"}</span>
									<span className="font-medium">{child.name}</span>
									{child.summary && <span className="min-w-0 truncate opacity-70">{child.summary}</span>}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

/** A row of tool pills (used above assistant bubbles and for orphan tool activity). */
export function ToolBar({ tools }: { tools: ToolCallInfo[] }) {
	if (tools.length === 0) return null;
	// 顶层 = 无 parentId，或父调用不在本批次里（避免嵌套项丢失）
	const known = new Set(tools.map((t) => t.id).filter(Boolean) as string[]);
	const top = tools.filter((t) => !t.parentId || !known.has(t.parentId));
	return (
		<div className="flex flex-col items-start gap-1">
			{top.map((tool, index) => (
				<ToolPill key={tool.id ?? `${tool.name}-${index}`} tool={tool} all={tools} />
			))}
		</div>
	);
}

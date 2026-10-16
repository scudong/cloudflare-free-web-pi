import { useState } from "react";
import type { ToolCallInfo } from "../types";

/**
 * Expandable tool pill (green, pi-web read-pill style): collapsed shows "🔧 name · brief",
 * clicking toggles the full untruncated summary below.
 */
function ToolPill({ tool }: { tool: ToolCallInfo }) {
	const [open, setOpen] = useState(false);
	const full = (tool.full ?? "").trim() || tool.summary;
	const expandable = full !== tool.summary;

	return (
		<div
			className={`max-w-full self-start border border-emerald-500/30 bg-emerald-950/40 text-xs text-emerald-200/90 ${
				open ? "rounded-xl" : "rounded-full"
			}`}
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
				<span aria-hidden>🔧</span>
				<span className="shrink-0 font-medium text-emerald-200">{tool.name}</span>
				{tool.summary && <span className="min-w-0 truncate">· {tool.summary}</span>}
				{expandable && (
					<span aria-hidden className="ml-0.5 shrink-0 text-emerald-400/70">
						{open ? "▾" : "▸"}
					</span>
				)}
			</button>
			{open && (
				<div className="whitespace-pre-wrap break-words rounded-b-xl border-t border-emerald-500/20 px-3 py-1.5 font-mono text-[11px] leading-relaxed text-emerald-100/80">
					{full}
				</div>
			)}
		</div>
	);
}

/** A row of tool pills (used above assistant bubbles and for orphan tool activity). */
export function ToolBar({ tools }: { tools: ToolCallInfo[] }) {
	if (tools.length === 0) return null;
	return (
		<div className="flex flex-col items-start gap-1">
			{tools.map((tool, index) => (
				<ToolPill key={`${tool.name}-${index}`} tool={tool} />
			))}
		</div>
	);
}

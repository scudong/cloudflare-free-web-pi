import type { ToolCallInfo } from "../types";

/** 工具活动条：🔧 名称 · 摘要（摘要已在解析/响应处理时截断 60 字）。 */
export function ToolBar({ tools }: { tools: ToolCallInfo[] }) {
	if (tools.length === 0) return null;
	return (
		<div className="flex flex-col items-start gap-1">
			{tools.map((tool, index) => (
				<div
					key={`${tool.name}-${index}`}
					className="flex max-w-full items-center gap-1.5 self-start rounded-full border border-slate-700/70 bg-slate-800/60 px-3 py-1 text-xs text-slate-400"
				>
					<span aria-hidden>🔧</span>
					<span className="shrink-0 font-medium text-slate-200">{tool.name}</span>
					{tool.summary && <span className="truncate">· {tool.summary}</span>}
				</div>
			))}
		</div>
	);
}

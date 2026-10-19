import { useEffect, useRef, useState } from "react";

interface ThinkingBlockProps {
	text: string;
	/** 仍在流式输出：自动展开并跟随。 */
	streaming?: boolean;
}

/**
 * 思考过程折叠块（v0.22.0）。
 * 流式输出时展开并跟随滚动；结束后自动收起，只留一行摘要。
 */
export function ThinkingBlock({ text, streaming }: ThinkingBlockProps) {
	const [open, setOpen] = useState(Boolean(streaming));
	const bodyRef = useRef<HTMLDivElement>(null);
	const chars = text.replace(/\s+/g, "").length;

	// 流式结束 → 自动收起；重新开始流式 → 展开
	useEffect(() => {
		setOpen(Boolean(streaming));
	}, [streaming]);

	useEffect(() => {
		if (open && streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
	}, [text, open, streaming]);

	if (!text.trim()) return null;

	return (
		<div className="w-full max-w-[92%] overflow-hidden rounded-xl border border-violet-500/25 bg-violet-950/20">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-violet-200/90 transition-colors hover:bg-violet-500/10"
			>
				<span aria-hidden className={streaming ? "animate-pulse" : ""}>
					🧠
				</span>
				<span className="font-medium">{streaming ? "思考中…" : "思考过程"}</span>
				<span className="tabular-nums text-violet-300/60">{chars} 字</span>
				<span aria-hidden className="ml-auto shrink-0 text-violet-300/70">
					{open ? "▾" : "▸"}
				</span>
			</button>
			{open && (
				<div
					ref={bodyRef}
					className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-violet-500/20 px-3 py-2 text-[12.5px] leading-relaxed text-violet-100/75"
				>
					{text}
				</div>
			)}
		</div>
	);
}

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

interface ComposerProps {
	pending: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
}

const MAX_HEIGHT = 160;

export function Composer({ pending, onSend, onStop }: ComposerProps) {
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// 输入内容变化（含发送后清空）时自适应高度；只做 DOM 操作，不 setState
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	}, [text]);

	const submit = () => {
		const trimmed = text.trim();
		if (!trimmed || pending) return;
		onSend(trimmed);
		setText("");
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter 发送，Shift+Enter 换行；输入法选字确认的 Enter 不发送
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="shrink-0 border-t border-slate-800 bg-slate-900/80 backdrop-blur">
			<div className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:border-x sm:border-slate-800/60">
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={handleKeyDown}
					rows={1}
					placeholder={pending ? "等待回复中…" : "输入消息，Enter 发送，Shift+Enter 换行"}
					aria-label="消息输入框"
					className="min-h-[44px] flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-[16px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/40"
				/>
				{pending ? (
					<button
						type="button"
						onClick={onStop}
						aria-label="停止等待本次回复"
						className="h-[44px] shrink-0 rounded-xl border border-slate-600 bg-slate-700 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-600"
					>
						停止
					</button>
				) : (
					<button
						type="button"
						onClick={submit}
						disabled={!text.trim()}
						className="h-[44px] shrink-0 rounded-xl bg-sky-600 px-4 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
					>
						发送
					</button>
				)}
			</div>
		</div>
	);
}

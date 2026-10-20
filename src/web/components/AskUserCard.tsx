import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { AskQuestion } from "../types";

interface AskUserCardProps {
	question: AskQuestion;
	busy?: boolean;
	/** 提交回答；由 App 负责发回给模型。 */
	onSubmit: (id: number, answers: { id: string; choice?: string; text?: string }[]) => void;
}

/** 交互式问答卡片（v0.37.0）：ask_user 工具提出问题时渲染，选项 + 自由输入。 */
export function AskUserCard({ question, busy, onSubmit }: AskUserCardProps) {
	// 每题一份本地答案：{ [qid]: { choice, text } }
	const [answers, setAnswers] = useState<Record<string, { choice?: string; text?: string }>>({});

	useEffect(() => {
		setAnswers({});
	}, [question.id]);

	const patch = (qid: string, next: { choice?: string; text?: string }) => {
		setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], ...next } }));
	};

	const submit = () => {
		const payload = question.questions.map((q) => {
			const a = answers[q.id] ?? {};
			return { id: q.id, ...(a.choice ? { choice: a.choice } : {}), ...(a.text?.trim() ? { text: a.text.trim() } : {}) };
		});
		onSubmit(question.id, payload);
	};

	return (
		<div className="shrink-0 border-t border-sky-500/30 bg-sky-950/30 px-4 py-2" aria-label="等待你回答的问题">
			<div className="mx-auto max-w-3xl space-y-2">
				<div className="flex items-center gap-2 text-xs">
					<Icon name="question" className="h-4 w-4 text-sky-300" />
					<span className="font-medium text-sky-200">{question.title || "需要你的回答"}</span>
					<span className="text-slate-500">
						{question.questions.length} 个问题
					</span>
				</div>
				{question.questions.map((q, index) => {
					const current = answers[q.id] ?? {};
					return (
						<div key={q.id} className="rounded-lg border border-sky-500/20 bg-slate-900/60 px-3 py-2">
							<p className="text-[13px] text-slate-200">
								<span className="mr-1 text-slate-500">{index + 1}.</span>
								{q.question}
							</p>
							{q.options && q.options.length > 0 && (
								<div className="mt-1.5 flex flex-col gap-1">
									{q.options.map((opt) => (
										<label
											key={opt.label}
											className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-xs transition-colors ${
												current.choice === opt.label
													? "bg-sky-500/20 text-sky-100"
													: "text-slate-300 hover:bg-slate-800/70"
											}`}
										>
											<input
												type="radio"
												name={`ask-${question.id}-${q.id}`}
												checked={current.choice === opt.label}
												onChange={() => patch(q.id, { choice: opt.label })}
												className="mt-0.5 accent-sky-500"
											/>
											<span className="min-w-0">
												<span>{opt.label}</span>
												{opt.recommended && (
													<span className="ml-1.5 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">推荐</span>
												)}
												{opt.description && <span className="block text-[11px] text-slate-500">{opt.description}</span>}
											</span>
										</label>
									))}
								</div>
							)}
							{q.allowText !== false && (
								<input
									value={current.text ?? ""}
									onChange={(e) => patch(q.id, { text: e.target.value })}
									placeholder={q.options?.length ? "或直接输入你的答案…" : "输入你的答案…"}
									aria-label={`问题 ${index + 1} 的回答`}
									className="mt-1.5 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-500/60"
								/>
							)}
						</div>
					);
				})}
				<div className="flex justify-end">
					<button
						type="button"
						onClick={submit}
						disabled={busy}
						className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
					>
						{busy ? "提交中…" : "提交回答"}
					</button>
				</div>
			</div>
		</div>
	);
}

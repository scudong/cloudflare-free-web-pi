import { memo, useId, useState } from "react";
import type { KbRef } from "../types";

/** 参考资料按文档聚合后的一项（NERE-41）。 */
export interface KbRefDocGroup {
	docId: number;
	title: string;
	source?: string;
	/** 该文档命中的分块数。 */
	count: number;
	/** 代表项（首个命中片段），点开文档时传给页面层。 */
	ref: KbRef;
}

/** 按 docId 聚合命中片段，保持首次出现顺序；同文档多个 chunk 只留一项。 */
export function groupByDoc(refs: KbRef[]): KbRefDocGroup[] {
	const groups: KbRefDocGroup[] = [];
	const index = new Map<number, KbRefDocGroup>();
	for (const ref of refs) {
		const found = index.get(ref.docId);
		if (found) {
			found.count += 1;
			continue;
		}
		const group: KbRefDocGroup = {
			docId: ref.docId,
			title: ref.title,
			...(ref.source ? { source: ref.source } : {}),
			count: 1,
			ref,
		};
		index.set(ref.docId, group);
		groups.push(group);
	}
	return groups;
}

/**
 * assistant 回复下方的「参考资料」条（NERE-41）：纯展示，数据只从 props 来。
 * 默认收起成一行；没有引用时什么都不渲染。
 */
export const KbRefsBar = memo(function KbRefsBar({
	refs,
	onOpen,
}: {
	refs: KbRef[];
	/** 点击某一篇：由页面层切到知识库并打开原文。缺省时只展示不可点。 */
	onOpen?: (ref: KbRef) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	if (!refs || refs.length === 0) return null;
	const docs = groupByDoc(refs);
	return (
		<div className="w-full rounded-xl border border-slate-800/70 bg-slate-900/40 px-2.5 py-1.5">
			<button
				type="button"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
				aria-controls={listId}
				className="flex w-full items-center gap-1.5 rounded text-left text-[11.5px] text-slate-400 transition-colors hover:text-slate-200"
			>
				<span className="font-medium">参考资料：{docs.length} 篇</span>
				<span aria-hidden className="text-[10px] text-slate-500">{expanded ? "▾" : "▸"}</span>
			</button>
			{expanded && (
				<ul id={listId} className="mt-1 space-y-0.5">
					{docs.map((doc) => {
						const label = `${doc.title}${doc.count > 1 ? ` · ${doc.count} 段` : ""}`;
						const body = (
							<>
								<span className="block truncate" title={doc.title}>{label}</span>
								{doc.source && (
									<span className="block truncate text-[10.5px] text-slate-500" title={doc.source}>
										{doc.source}
									</span>
								)}
							</>
						);
						return (
							<li key={doc.docId}>
								{onOpen ? (
									<button
										type="button"
										onClick={() => onOpen(doc.ref)}
										className="block w-full rounded px-1.5 py-1 text-left text-[12px] text-sky-300 transition-colors hover:bg-slate-800 hover:text-sky-200"
									>
										{body}
									</button>
								) : (
									<div className="block px-1.5 py-1 text-[12px] text-slate-300">{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
});

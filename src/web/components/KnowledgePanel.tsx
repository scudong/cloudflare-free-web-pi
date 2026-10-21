import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { api } from "../lib/api";
import { parseKbDocs, parseKbHits } from "../lib/collections";
import { formatSize, formatTime } from "../lib/format";
import { renderMarkdown } from "../lib/rich";
import type { KbDocInfo, KbHit } from "../types";
import { Icon } from "./Icon";
import { KbImport, type IncomingDrop } from "./KbImport";

/**
 * 左栏「知识库」（v0.45.0）：每个用户一个独立库（后端按用户 DO 隔离）。
 * 支持检索、导入文件 / 链接、粘贴资料入库、查看与删除；模型侧对应 kb_search / kb_add。
 */
export function KnowledgePanel({ onCollapse }: { onCollapse?: () => void }) {
	const [docs, setDocs] = useState<KbDocInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<KbHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [adding, setAdding] = useState(false);
	const [title, setTitle] = useState("");
	const [source, setSource] = useState("");
	const [tags, setTags] = useState("");
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const [viewing, setViewing] = useState<{ title: string; content: string } | null>(null);
	const [viewingBusy, setViewingBusy] = useState(false);
	/** 拖拽悬停与待导入文件：面板任意位置都能投放，导入区在「新增」里。 */
	const [dropActive, setDropActive] = useState(false);
	const [incomingDrop, setIncomingDrop] = useState<IncomingDrop | null>(null);
	const dragDepth = useRef(0);

	const load = useCallback(() => {
		setLoading(true);
		void (async () => {
			try {
				const data = await api.kbDocs();
				setDocs(parseKbDocs(data));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const search = () => {
		const q = query.trim();
		if (!q) {
			setHits(null);
			return;
		}
		setSearching(true);
		void (async () => {
			try {
				const data = await api.kbSearch(q);
				setHits(parseKbHits(data));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSearching(false);
			}
		})();
	};

	const add = () => {
		if (busy || !title.trim() || !content.trim()) return;
		setBusy(true);
		setNote("");
		void (async () => {
			try {
				const data = await api.kbAdd(title.trim(), content.trim(), source.trim(), tags.trim());
				if (!data.id) throw new Error(data.error || "保存失败");
				setNote(`已入库：${data.chunks ?? 0} 个片段`);
				setTitle("");
				setSource("");
				setTags("");
				setContent("");
				setAdding(false);
				setHits(null);
				setQuery("");
				load();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		})();
	};

	const remove = (doc: KbDocInfo) => {
		if (!window.confirm(`删除知识库文档「${doc.title}」？删除后无法检索。`)) return;
		void (async () => {
			try {
				await api.kbDelete(doc.id);
				setHits((prev) => prev?.filter((hit) => hit.docId !== doc.id) ?? null);
				load();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	};

	const view = (id: number) => {
		if (viewingBusy) return;
		setViewingBusy(true);
		void (async () => {
			try {
				const data = await api.kbDoc(id);
				setViewing({ title: data.title || "未命名文档", content: data.content || "" });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setViewingBusy(false);
			}
		})();
	};

	/** 导入成功后回到完整列表：检索结果里不会有刚入库的文档。 */
	const handleImported = useCallback(() => {
		setHits(null);
		setQuery("");
		load();
	}, [load]);

	const handleIncomingConsumed = useCallback(() => setIncomingDrop(null), []);

	const hasFileDrag = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types).includes("Files");

	const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
		if (!hasFileDrag(event)) return;
		event.preventDefault();
		dragDepth.current += 1;
		setDropActive(true);
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!hasFileDrag(event)) return;
		// 不 preventDefault 浏览器会直接打开文件，覆盖整个页面。
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		if (!adding) setAdding(true);
	};

	const handleDragLeave = () => {
		// 不按 types 过滤：部分浏览器在 dragleave 时已清空 types，过滤会让高亮卡住。
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDropActive(false);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		if (!hasFileDrag(event)) return;
		event.preventDefault();
		dragDepth.current = 0;
		setDropActive(false);
		const file = event.dataTransfer.files.item(0);
		if (!file) return;
		setAdding(true);
		setIncomingDrop({ file });
	};

	const inputClass =
		"w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500";

	if (viewing) {
		return (
			<div
				className="flex h-full w-full flex-col bg-slate-900/60"
				// 阅读文档时不接收导入，但也不能让浏览器把拖进来的文件当导航打开。
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => event.preventDefault()}
			>
				<div className="flex shrink-0 items-center gap-1.5 border-b border-slate-800/70 px-2.5 py-2">
					<button
						type="button"
						onClick={() => setViewing(null)}
						aria-label="返回知识库"
						title="返回"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="chevronsLeft" className="h-4 w-4" />
					</button>
					<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-100" title={viewing.title}>
						{viewing.title}
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					<article className="md-prose break-words text-[13px]">{renderMarkdown(viewing.content)}</article>
				</div>
			</div>
		);
	}

	return (
		<div
			className="relative flex h-full w-full flex-col bg-slate-900/60"
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
				<span className="text-[12.5px] font-medium text-slate-300">知识库 · 仅你可见</span>
				<span className="flex items-center gap-1.5">
					<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{docs.length}</span>
					<button
						type="button"
						onClick={() => setAdding((value) => !value)}
						aria-pressed={adding}
						title={adding ? "收起新增" : "新增 / 导入文档"}
						aria-label={adding ? "收起新增" : "新增 / 导入文档"}
						className="inline-flex items-center justify-center rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
					>
						<Icon name={adding ? "close" : "plus"} className="h-4 w-4" />
					</button>
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

			<form
				className="flex shrink-0 gap-1.5 border-b border-slate-800/70 p-2.5"
				onSubmit={(event) => {
					event.preventDefault();
					search();
				}}
			>
				<input
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						if (!event.target.value.trim()) setHits(null);
					}}
					placeholder="检索知识库…"
					aria-label="检索知识库"
					className={inputClass}
				/>
				<button
					type="submit"
					disabled={searching}
					className="shrink-0 rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
				>
					{searching ? "检索中" : "检索"}
				</button>
			</form>

			{adding && (
				<div className="max-h-[62vh] shrink-0 space-y-1.5 overflow-y-auto border-b border-slate-800/70 p-2.5">
					<KbImport
						incoming={incomingDrop}
						onIncomingConsumed={handleIncomingConsumed}
						onImported={handleImported}
						dropActive={dropActive}
					/>
					<p className="flex items-center gap-1.5 pt-0.5 text-[10.5px] text-slate-500">
						<span aria-hidden className="h-px flex-1 bg-slate-800" />
						或手动粘贴正文
						<span aria-hidden className="h-px flex-1 bg-slate-800" />
					</p>
					<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题（必填）" aria-label="文档标题" className={inputClass} />
					<div className="flex gap-1.5">
						<input value={source} onChange={(event) => setSource(event.target.value)} placeholder="来源（可选）" aria-label="来源" className={inputClass} />
						<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（可选）" aria-label="标签" className={inputClass} />
					</div>
					<textarea
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder="粘贴正文，支持 Markdown。也可以直接让 π 用 kb_add 从链接或对话里存入。"
						aria-label="文档正文"
						rows={6}
						className={`${inputClass} resize-y leading-relaxed`}
					/>
					<button
						type="button"
						onClick={add}
						disabled={busy || !title.trim() || !content.trim()}
						className="w-full rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
					>
						{busy ? "写入并索引中…" : "保存到知识库"}
					</button>
					<p className="text-[11px] leading-relaxed text-slate-500">自动按段切块并建立中文全文索引，保存后即可用自然语言检索。</p>
				</div>
			)}

			{note && <p className="mx-2.5 mt-2 rounded-md bg-emerald-950/40 px-2 py-1 text-[11px] text-emerald-300">{note}</p>}
			{error && <p className="mx-2.5 mt-2 rounded-md bg-rose-950/40 px-2 py-1 text-[11px] text-rose-300">{error}</p>}

			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{loading && docs.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}

				{hits !== null ? (
					<>
						<p className="px-1 py-1 text-[11px] text-slate-500">{hits.length ? `命中 ${hits.length} 个片段` : "没有匹配的内容。"}</p>
						<ul className="space-y-1">
							{hits.map((hit, index) => (
								<li key={`${hit.docId}-${hit.chunkSeq}-${index}`} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
									<button type="button" onClick={() => view(hit.docId)} className="block w-full text-left">
										<span className="block truncate text-[12.5px] text-slate-100">{hit.title}</span>
										{hit.source && <span className="block truncate text-[10.5px] text-slate-500">{hit.source}</span>}
										<span className="mt-1 block whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-slate-400">
											{hit.text.length > 220 ? `${hit.text.slice(0, 220)}…` : hit.text}
										</span>
									</button>
								</li>
							))}
						</ul>
					</>
				) : (
					<>
						{!loading && docs.length === 0 && !error && (
							<p className="px-1.5 py-6 text-center text-xs leading-relaxed text-slate-500">
								知识库还是空的。
								<br />
								拖入 PDF / MD / TXT / DOCX，或粘贴网页链接；
								<br />
								也可以让 π 用 kb_add 存进来。
							</p>
						)}
						<ul className="space-y-1">
							{docs.map((doc) => (
								<li key={doc.id} className="group flex items-start gap-1 rounded-lg bg-slate-800/50 px-2.5 py-2">
									<button type="button" onClick={() => view(doc.id)} className="min-w-0 flex-1 text-left">
										<span className="block truncate text-[13px] text-slate-100" title={doc.title}>
											{doc.title}
										</span>
										<span className="block truncate text-[11px] text-slate-500">
											{formatSize(doc.size)} · {doc.chunks} 段
											{doc.tags ? ` · ${doc.tags}` : ""}
										</span>
										<span className="block text-[10.5px] text-slate-600">{formatTime(doc.updatedAt)}</span>
									</button>
									<button
										type="button"
										onClick={() => remove(doc)}
										aria-label={`删除文档 ${doc.title}`}
										title="删除文档"
										className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition-all hover:bg-red-950/60 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
									>
										<Icon name="trash" className="h-3.5 w-3.5" />
									</button>
								</li>
							))}
						</ul>
					</>
				)}
			</div>

			{dropActive && (
				<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-sky-500/10 ring-2 ring-inset ring-sky-400">
					<span className="rounded-lg bg-slate-900/90 px-3 py-2 text-xs text-sky-300 ring-1 ring-sky-400/40">
						松手导入到知识库
					</span>
				</div>
			)}
		</div>
	);
}

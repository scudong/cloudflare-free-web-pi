import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { parseKbDocs, parseKbHits } from "../lib/collections";
import { formatSize, formatTime } from "../lib/format";
import { renderMarkdown } from "../lib/rich";
import type { KbDocInfo, KbHit } from "../types";
import { Icon } from "./Icon";

/**
 * 左栏「知识库」（v0.45.0）：每个用户一个独立库（后端按用户 DO 隔离）。
 * 支持检索、粘贴资料入库、查看与删除；v0.55.0 起支持文件与链接导入。
 * 模型侧对应 kb_search / kb_add。
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
	const [ingesting, setIngesting] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [link, setLink] = useState("");
	const [note, setNote] = useState("");
	const [viewing, setViewing] = useState<{ title: string; content: string } | null>(null);
	const [viewingBusy, setViewingBusy] = useState(false);
	const fileInput = useRef<HTMLInputElement | null>(null);

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

	/** 导入成功后统一收尾：清空检索、刷新列表、报一句结果。 */
	const finishIngest = (summary: string) => {
		setNote(summary);
		setHits(null);
		setQuery("");
		load();
	};

	/** 文件导入（v0.55.0）：服务端按扩展名转 Markdown 后入库，这里只负责把结果说清楚。 */
	const ingestFiles = (picked: File[]) => {
		if (!picked.length || ingesting) return;
		setIngesting(true);
		setNote("");
		setError(null);
		void (async () => {
			try {
				const data = await api.kbIngestFiles(picked, tags.trim());
				const docs = data.docs ?? [];
				const failed = data.failed ?? [];
				if (docs.length) {
					finishIngest(`已导入 ${docs.length} 个文件：${docs.map((doc) => `${doc.title ?? doc.name ?? "文档"}（${doc.chunks ?? 0} 段）`).join("、")}`);
				}
				if (failed.length) setError(failed.map((doc) => doc.error ?? `${doc.name ?? "文件"} 导入失败`).join("；"));
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setIngesting(false);
			}
		})();
	};

	/** 链接导入（v0.55.0）：标题由服务端取页面 title，正文由 DeepSeek Fetch 抓取。 */
	const ingestLink = () => {
		const url = link.trim();
		if (!url || ingesting) return;
		setIngesting(true);
		setNote("");
		setError(null);
		void (async () => {
			try {
				const data = await api.kbIngestUrl(url, tags.trim());
				if (!data.ok || !data.id) throw new Error(data.error || "链接导入失败");
				setLink("");
				finishIngest(`已从链接导入「${data.title ?? url}」：${data.chunks ?? 0} 个片段${data.truncated ? "（正文超长，已截断）" : ""}`);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setIngesting(false);
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

	const inputClass =
		"w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500";

	if (viewing) {
		return (
			<div className="flex h-full w-full flex-col bg-slate-900/60">
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
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
				<span className="text-[12.5px] font-medium text-slate-300">知识库 · 仅你可见</span>
				<span className="flex items-center gap-1.5">
					<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{docs.length}</span>
					<button
						type="button"
						onClick={() => setAdding((value) => !value)}
						aria-pressed={adding}
						title={adding ? "收起新增" : "新增文档"}
						aria-label={adding ? "收起新增" : "新增文档"}
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
				<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-2.5">
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

					<div className="flex items-center gap-1.5 pt-1 text-[10.5px] text-slate-600">
						<span className="h-px flex-1 bg-slate-800" />
						或导入已有资料
						<span className="h-px flex-1 bg-slate-800" />
					</div>

					<div
						role="button"
						tabIndex={0}
						onClick={() => fileInput.current?.click()}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								fileInput.current?.click();
							}
						}}
						onDragOver={(event) => {
							event.preventDefault();
							setDragOver(true);
						}}
						onDragLeave={() => setDragOver(false)}
						onDrop={(event) => {
							event.preventDefault();
							setDragOver(false);
							ingestFiles(Array.from(event.dataTransfer.files));
						}}
						aria-label="选择或拖入文件导入知识库"
						className={`cursor-pointer rounded-lg border border-dashed px-2 py-3 text-center text-[11px] leading-relaxed transition-colors ${
							dragOver
								? "border-sky-400 bg-sky-950/40 text-sky-200"
								: "border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300"
						}`}
					>
						<Icon name="upload" className="mx-auto mb-1 h-4 w-4" />
						{ingesting ? "导入中…" : "拖入或点击选择文件"}
						<br />
						PDF / MD / TXT / DOCX，单个 ≤ 20MB
					</div>
					<input
						ref={fileInput}
						type="file"
						multiple
						accept=".pdf,.md,.markdown,.txt,.docx"
						className="hidden"
						aria-label="选择要导入知识库的文件"
						onChange={(event) => {
							ingestFiles(Array.from(event.target.files ?? []));
							event.target.value = "";
						}}
					/>

					<div className="flex gap-1.5">
						<input
							value={link}
							onChange={(event) => setLink(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									ingestLink();
								}
							}}
							placeholder="粘贴网页链接导入…"
							aria-label="网页链接"
							className={inputClass}
						/>
						<button
							type="button"
							onClick={ingestLink}
							disabled={ingesting || !link.trim()}
							aria-label="从链接导入"
							title="从链接导入"
							className="inline-flex shrink-0 items-center gap-1 rounded-md bg-sky-700 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-40"
						>
							<Icon name="link" className="h-3.5 w-3.5" />
							导入
						</button>
					</div>
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
								点右上角 + 粘贴正文、拖入 PDF / MD 文件，或粘贴网页链接导入。
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
		</div>
	);
}

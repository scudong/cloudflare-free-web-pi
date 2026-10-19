import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/rich";
import { formatSize, formatTime } from "../lib/format";
import type { FileInfo } from "../types";

interface WorkbenchProps {
	sessionId: string;
	files: FileInfo[];
	filesLoading: boolean;
	filesError: string | null;
	/** 最大化阅读（v0.16.0）。 */
	wide: boolean;
	onToggleWide: () => void;
	/** 打开/关闭文件时通知外层（用于自动加宽）。 */
	onFileOpenChange: (open: boolean) => void;
	/** Bumped after each chat round / deletion so an open file re-fetches fresh content. */
	refreshTick: number;
	onDeleteFile: (name: string) => Promise<boolean>;
}

/** The file list: virtual files produced by the agent's write_file tool. */
function FileList({
	files,
	loading,
	error,
	onOpen,
	onDelete,
}: {
	files: FileInfo[];
	loading: boolean;
	error: string | null;
	onOpen: (name: string) => void;
	onDelete: (name: string) => void;
}) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-2">
			{error && (
				<p className="mx-1 mb-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300/90">
					文件列表加载失败：{error}
				</p>
			)}
			{!loading && !error && files.length === 0 && (
				<p className="px-1.5 py-6 text-center text-xs leading-relaxed text-slate-500">
					工作台还没有文件。
					<br />
					让 π 用 write_file 写报告、笔记后会出现在这里。
				</p>
			)}
			<ul className="space-y-0.5">
				{files.map((file) => (
					<li
						key={file.name}
						className="group flex items-center gap-1 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-slate-700/70 hover:bg-slate-800"
					>
						<button
							type="button"
							onClick={() => onOpen(file.name)}
							className="flex min-w-0 flex-1 items-center gap-2 text-left"
						>
							<span aria-hidden className="shrink-0 text-sm">
								📄
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] text-slate-100">{file.name}</span>
								<span className="block text-[11px] text-slate-500">
									{formatSize(file.size)}
									{file.updatedAt ? ` · ${formatTime(file.updatedAt)}` : ""}
								</span>
							</span>
						</button>
						<button
							type="button"
							onClick={() => onDelete(file.name)}
							aria-label={`删除文件 ${file.name}`}
							title={`删除 ${file.name}`}
							className="shrink-0 rounded-md px-1.5 py-1 text-xs text-slate-500 opacity-0 transition-all hover:bg-red-950/60 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
						>
							✕
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

type ContentState = "loading" | "ready" | "error";

/** Full-width file view: header + preview/source toggle. */
function FileView({
	sessionId,
	name,
	refreshTick,
	onClose,
	onDelete,
	wide,
	onToggleWide,
	dockRight,
}: {
	sessionId: string;
	name: string;
	refreshTick: number;
	onClose: () => void;
	onDelete: (name: string) => void;
	wide: boolean;
	onToggleWide: () => void;
	dockRight: boolean;
}) {
	const [mode, setMode] = useState<"preview" | "source">("preview");
	// HTML 文件用 sandbox iframe 渲染，其余走 Markdown（v0.15.0）
	const isHtml = /\.html?$/i.test(name);
	const [content, setContent] = useState("");
	const [state, setState] = useState<ContentState>("loading");
	const [error, setError] = useState("");

	// Fetch file content on open / refresh; alive guard for the async continuation
	useEffect(() => {
		let alive = true;
		setState("loading");
		setError("");
		void (async () => {
			try {
				const data = await api.fileContent(sessionId, name);
				if (!alive) return;
				setContent(typeof data.content === "string" ? data.content : "");
				setState("ready");
			} catch (err) {
				if (!alive) return;
				setState("error");
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, name, refreshTick]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-slate-800/70 px-2.5 py-2">
				<button
					type="button"
					onClick={onClose}
					aria-label="关闭文件视图"
					title="关闭"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
				>
					✕
				</button>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-100">{name}</span>
				<div className="flex shrink-0 overflow-hidden rounded-lg border border-slate-700">
					{(["preview", "source"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setMode(value)}
							aria-pressed={mode === value}
							className={`px-2.5 py-1 text-xs transition-colors ${
								mode === value ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
							}`}
						>
							{value === "preview" ? "预览" : "源码"}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={onToggleWide}
					aria-pressed={wide}
					aria-label={wide ? "退出全宽阅读" : "全宽阅读"}
					title={wide ? "退出全宽阅读" : "全宽阅读"}
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
				>
					{wide ? "⤡" : "⤢"}
				</button>
				<button
					type="button"
					onClick={() => onDelete(name)}
					aria-label={`删除文件 ${name}`}
					title="删除文件"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-950/60 hover:text-red-300"
				>
					🗑
				</button>
			</div>
			<div className={`min-h-0 flex-1 overflow-y-auto p-3 ${dockRight ? "md:px-8" : ""}`}>
				<div className={dockRight ? "mx-auto w-full max-w-4xl" : ""}>
					{state === "loading" && <p className="text-xs text-slate-500">正在加载文件内容…</p>}
					{state === "error" && <p className="text-xs text-red-300/90">加载失败：{error}</p>}
					{state === "ready" && mode === "preview" && isHtml && (
						<iframe
							title={`${name} 预览`}
							sandbox="allow-scripts"
							srcDoc={content}
							className="h-full min-h-[420px] w-full rounded-lg border border-slate-700 bg-white"
						/>
					)}
					{state === "ready" && mode === "preview" && !isHtml && (
						<article className="text-[13px] leading-relaxed text-slate-200">{renderMarkdown(content)}</article>
					)}
					{state === "ready" && mode === "source" && (
						<pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-300">{content}</pre>
					)}
				</div>
			</div>
		</div>
	);
}

/** 右栏：文件预览（v0.21.0 起 —— 连接/定时/技能移到左侧工具栏，记忆移到设置）。 */
export function Workbench({
	sessionId,
	files,
	filesLoading,
	filesError,
	wide,
	onToggleWide,
	onFileOpenChange,
	refreshTick,
	onDeleteFile,
}: WorkbenchProps) {
	const [openName, setOpenName] = useState<string | null>(null);

	// If the open file disappears from the list (deleted elsewhere / reset), fall back to the list
	useEffect(() => {
		if (openName && !files.some((file) => file.name === openName)) {
			setOpenName(null);
		}
	}, [files, openName]);

	const handleOpenFile = (name: string) => {
		setOpenName(name);
		onFileOpenChange(true);
	};

	const handleDeleteFile = (name: string) => {
		if (!window.confirm(`确认删除文件「${name}」？此操作不可撤销。`)) return;
		void (async () => {
			const ok = await onDeleteFile(name);
			if (ok && name === openName) setOpenName(null);
		})();
	};

	return (
		<aside className="flex h-full w-full flex-col bg-slate-900/60" aria-label="文件预览">
			{openName ? (
				<FileView
					sessionId={sessionId}
					name={openName}
					refreshTick={refreshTick}
					onClose={() => {
						setOpenName(null);
						onFileOpenChange(false);
					}}
					onDelete={handleDeleteFile}
					wide={wide}
					onToggleWide={onToggleWide}
					dockRight={wide}
				/>
			) : (
				<>
					<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
						<span className="text-[12.5px] font-medium text-slate-300">文件</span>
						<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{files.length}</span>
					</div>
					<FileList files={files} loading={filesLoading} error={filesError} onOpen={handleOpenFile} onDelete={handleDeleteFile} />
				</>
			)}
		</aside>
	);
}

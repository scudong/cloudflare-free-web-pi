import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/rich";
import type { FileInfo, MemoryInfo } from "../types";

export type WorkbenchTab = "files" | "memories";

interface WorkbenchProps {
	tab: WorkbenchTab;
	onTabChange: (tab: WorkbenchTab) => void;
	sessionId: string;
	files: FileInfo[];
	filesLoading: boolean;
	filesError: string | null;
	memories: MemoryInfo[];
	memoriesLoading: boolean;
	memoriesError: string | null;
	/** Bumped after each chat round / deletion so an open file re-fetches fresh content. */
	refreshTick: number;
	onDeleteFile: (name: string) => Promise<boolean>;
	onDeleteMemory: (id: number) => Promise<boolean>;
}

function formatSize(size: number): string {
	if (!Number.isFinite(size) || size <= 0) return "—";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The "文件" tab: virtual file list produced by the agent's write_file tool. */
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

/** The "记忆" tab: long-term memory entries, each deletable. */
function MemoryList({
	memories,
	loading,
	error,
	onDelete,
}: {
	memories: MemoryInfo[];
	loading: boolean;
	error: string | null;
	onDelete: (id: number) => void;
}) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-2">
			{error && (
				<p className="mx-1 mb-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300/90">
					记忆列表加载失败：{error}
				</p>
			)}
			{!loading && !error && memories.length === 0 && (
				<p className="px-1.5 py-6 text-center text-xs leading-relaxed text-slate-500">
					记忆库还是空的。
					<br />
					对 π 说「记住…」即可保存一条长期记忆。
				</p>
			)}
			<ul className="space-y-1.5">
				{memories.map((memory) => (
					<li key={memory.id} className="rounded-lg border border-slate-700/60 bg-slate-800/50 px-2.5 py-2">
						<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-200">{memory.content}</p>
						<div className="mt-1.5 flex items-center justify-between gap-2">
							<span className="min-w-0 truncate text-[11px] text-slate-500">{formatTime(memory.createdAt)}</span>
							{memory.id > 0 && (
								<button
									type="button"
									onClick={() => onDelete(memory.id)}
									className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-red-950/60 hover:text-red-300"
								>
									删除
								</button>
							)}
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}

type ContentState = "loading" | "ready" | "error";

/** Full-width file view inside the workbench: header + preview/source toggle. */
function FileView({
	sessionId,
	name,
	refreshTick,
	onClose,
	onDelete,
}: {
	sessionId: string;
	name: string;
	refreshTick: number;
	onClose: () => void;
	onDelete: (name: string) => void;
}) {
	const [mode, setMode] = useState<"preview" | "source">("preview");
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
					onClick={() => onDelete(name)}
					aria-label={`删除文件 ${name}`}
					title="删除文件"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-950/60 hover:text-red-300"
				>
					🗑
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{state === "loading" && <p className="text-xs text-slate-500">正在加载文件内容…</p>}
				{state === "error" && <p className="text-xs text-red-300/90">加载失败：{error}</p>}
				{state === "ready" &&
					(mode === "preview" ? (
						<article className="text-[13px] leading-relaxed text-slate-200">{renderMarkdown(content)}</article>
					) : (
						<pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-300">{content}</pre>
					))}
			</div>
		</div>
	);
}

/** Right column: workbench with 文件 / 记忆 tabs, switching to a file view on click. */
export function Workbench({
	tab,
	onTabChange,
	sessionId,
	files,
	filesLoading,
	filesError,
	memories,
	memoriesLoading,
	memoriesError,
	refreshTick,
	onDeleteFile,
	onDeleteMemory,
}: WorkbenchProps) {
	const [openName, setOpenName] = useState<string | null>(null);

	// If the open file disappears from the list (deleted elsewhere / reset), fall back to the list
	useEffect(() => {
		if (openName && !files.some((file) => file.name === openName)) {
			setOpenName(null);
		}
	}, [files, openName]);

	const handleDeleteFile = (name: string) => {
		if (!window.confirm(`确认删除文件「${name}」？此操作不可撤销。`)) return;
		void (async () => {
			const ok = await onDeleteFile(name);
			if (ok && name === openName) setOpenName(null);
		})();
	};

	const handleDeleteMemory = (id: number) => {
		void onDeleteMemory(id);
	};

	const tabButton = (value: WorkbenchTab, label: string, count: number) => (
		<button
			key={value}
			type="button"
			onClick={() => onTabChange(value)}
			aria-pressed={tab === value}
			className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
				tab === value
					? "border-sky-400 text-sky-300"
					: "border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-200"
			}`}
		>
			{label}
			<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{count}</span>
		</button>
	);

	return (
		<aside className="flex h-full w-full flex-col bg-slate-900/60" aria-label="工作台">
			{openName ? (
				<FileView
					sessionId={sessionId}
					name={openName}
					refreshTick={refreshTick}
					onClose={() => setOpenName(null)}
					onDelete={handleDeleteFile}
				/>
			) : (
				<>
					<div className="flex shrink-0 items-stretch border-b border-slate-800/70" role="tablist">
						{tabButton("files", "文件", files.length)}
						{tabButton("memories", "记忆", memories.length)}
					</div>
					{tab === "files" ? (
						<FileList
							files={files}
							loading={filesLoading}
							error={filesError}
							onOpen={setOpenName}
							onDelete={handleDeleteFile}
						/>
					) : (
						<MemoryList memories={memories} loading={memoriesLoading} error={memoriesError} onDelete={handleDeleteMemory} />
					)}
				</>
			)}
		</aside>
	);
}

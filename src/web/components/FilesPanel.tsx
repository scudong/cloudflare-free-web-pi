import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { parseAllFiles } from "../lib/collections";
import { formatSize, formatTime } from "../lib/format";
import type { AllFileInfo } from "../types";
import { Icon } from "./Icon";

interface FilesPanelProps {
	/** 点击文件：切到所属会话并在右栏打开（v0.45.0）。 */
	onOpen: (sessionId: string, name: string) => void;
	/** 聊天轮次 / 删除后刷新。 */
	refreshTick: number;
	/** 删除后通知外层刷新工作台与会话文件列表。 */
	onChanged?: () => void;
	onCollapse?: () => void;
}

/** 左栏「全部文件」（v0.45.0）：当前用户所有会话产出的文件，跨会话一览。 */
export function FilesPanel({ onOpen, refreshTick, onChanged, onCollapse }: FilesPanelProps) {
	const [files, setFiles] = useState<AllFileInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [localTick, setLocalTick] = useState(0);

	const load = useCallback(() => {
		setLoading(true);
		void (async () => {
			try {
				const data = await api.filesAll();
				setFiles(parseAllFiles(data));
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
	}, [load, refreshTick, localTick]);

	const remove = (file: AllFileInfo) => {
		if (!window.confirm(`删除「${file.name}」？此操作不可撤销。`)) return;
		void (async () => {
			try {
				await api.deleteFile(file.sessionId, file.name);
				setLocalTick((tick) => tick + 1);
				onChanged?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	};

	const q = query.trim().toLowerCase();
	const visible = q
		? files.filter((file) => file.name.toLowerCase().includes(q) || file.sessionTitle.toLowerCase().includes(q))
		: files;

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
				<span className="text-[12.5px] font-medium text-slate-300">全部文件 · 仅你可见</span>
				<span className="flex items-center gap-1.5">
					<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{files.length}</span>
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

			<div className="shrink-0 border-b border-slate-800/70 p-2.5">
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="按文件名或会话名筛选…"
					aria-label="筛选文件"
					className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{error && (
					<p className="mx-1 mb-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300/90">
						文件列表加载失败：{error}
					</p>
				)}
				{loading && files.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
				{!loading && files.length === 0 && !error && (
					<p className="px-1.5 py-6 text-center text-xs leading-relaxed text-slate-500">
						还没有生成过文件。
						<br />
						让 π 用 write_file 写报告、笔记后会汇总到这里。
					</p>
				)}
				{!loading && files.length > 0 && visible.length === 0 && (
					<p className="px-1.5 py-4 text-center text-xs text-slate-500">没有匹配「{query.trim()}」的文件。</p>
				)}
				<ul className="space-y-0.5">
					{visible.map((file) => (
						<li
							key={`${file.sessionId}/${file.name}`}
							className="group flex items-center gap-1 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-slate-700/70 hover:bg-slate-800"
						>
							<button
								type="button"
								onClick={() => onOpen(file.sessionId, file.name)}
								className="flex min-w-0 flex-1 items-center gap-2 text-left"
								title={`${file.sessionTitle} · ${file.name}`}
							>
								<span aria-hidden className="shrink-0 text-slate-400">
									<Icon name="file" className="h-4 w-4" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] text-slate-100">{file.name}</span>
									<span className="block truncate text-[11px] text-slate-500">{file.sessionTitle || "未命名会话"}</span>
									<span className="block text-[10.5px] text-slate-600">
										{formatSize(file.size)}
										{file.updatedAt ? ` · ${formatTime(file.updatedAt)}` : ""}
									</span>
								</span>
							</button>
							<button
								type="button"
								onClick={() => remove(file)}
								aria-label={`删除文件 ${file.name}`}
								title={`删除 ${file.name}`}
								className="shrink-0 rounded-md px-1.5 py-1 text-slate-500 opacity-0 transition-all hover:bg-red-950/60 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
							>
								<Icon name="trash" className="h-3.5 w-3.5" />
							</button>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

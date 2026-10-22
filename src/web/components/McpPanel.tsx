import { useState } from "react";
import { Icon } from "./Icon";
import type { McpServerInfo } from "../types";

/** 左栏「连接」：MCP 服务器管理（v0.21.0 从工作台移入左侧工具栏；NERE-62 起为弹窗内容）。 */
export function McpPanel({
	servers,
	loading,
	error,
	onAdd,
	onDelete,
}: {
	servers: McpServerInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, url: string, headers?: Record<string, string>) => Promise<boolean>;
	onDelete: (id: string) => Promise<boolean>;
	/** 弹窗关闭回调（外壳由 ModalShell 提供，面板本身不用）。 */
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [headerKey, setHeaderKey] = useState("");
	const [headerValue, setHeaderValue] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = () => {
		if (!name.trim() || !url.trim() || busy) return;
		setBusy(true);
		void (async () => {
			const headers = headerKey.trim() && headerValue.trim() ? { [headerKey.trim()]: headerValue.trim() } : undefined;
			const ok = await onAdd(name.trim(), url.trim(), headers);
			if (ok) {
				setName("");
				setUrl("");
				setHeaderKey("");
				setHeaderValue("");
			}
			setBusy(false);
		})();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="名称，如 deepwiki"
					aria-label="MCP 名称"
					className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<input
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://example.com/mcp"
					aria-label="MCP 服务器地址"
					className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<div className="flex gap-1.5">
					<input
						value={headerKey}
						onChange={(e) => setHeaderKey(e.target.value)}
						placeholder="请求头名（可选，如 x-api-key）"
						aria-label="请求头名称"
						className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
					/>
					<input
						value={headerValue}
						onChange={(e) => setHeaderValue(e.target.value)}
						placeholder="请求头值"
						aria-label="请求头值"
						className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
					/>
				</div>
				<button
					type="button"
					onClick={submit}
					disabled={busy || !name.trim() || !url.trim()}
					className="w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
				>
					{busy ? "连接中…" : "添加 MCP 服务器"}
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
				{loading && servers.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
				{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
				{!loading && servers.length === 0 && !error && (
					<p className="px-1 py-2 text-xs text-slate-500">还没有连接 MCP。添加后其工具会以 mcp__名称__工具 的形式提供。</p>
				)}
				<ul className="space-y-1">
					{servers.map((server) => (
						<li key={server.id} className="flex items-start gap-2 rounded-lg bg-slate-800/50 px-2.5 py-2">
							<span aria-hidden className="mt-0.5 shrink-0 text-slate-400">
								<Icon name="connection" className="h-3.5 w-3.5" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] text-slate-100">{server.name}</span>
								<span className="block truncate text-[11px] text-slate-500">{server.url}</span>
							</span>
							<button
								type="button"
								title="移除"
								aria-label={`移除 ${server.name}`}
								onClick={() => {
									if (window.confirm(`移除 MCP「${server.name}」？`)) void onDelete(server.id);
								}}
								className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
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

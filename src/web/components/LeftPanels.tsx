import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/rich";
import type { AutomationInfo, McpServerInfo, SkillInfo } from "../types";

function PanelHeader({ title, count }: { title: string; count?: number }) {
	return (
		<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
			<span className="text-[12.5px] font-medium text-slate-300">{title}</span>
			{typeof count === "number" && (
				<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{count}</span>
			)}
		</div>
	);
}

/** 左栏「连接」：MCP 服务器管理（v0.21.0 从工作台移入左侧工具栏）。 */
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
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<PanelHeader title="连接 · MCP" count={servers.length} />
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
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{loading && servers.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
				{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
				{!loading && servers.length === 0 && !error && (
					<p className="px-1 py-2 text-xs text-slate-500">还没有连接 MCP。添加后其工具会以 mcp__名称__工具 的形式提供。</p>
				)}
				<ul className="space-y-1">
					{servers.map((server) => (
						<li key={server.id} className="flex items-start gap-2 rounded-lg bg-slate-800/50 px-2.5 py-2">
							<span aria-hidden className="mt-0.5 text-xs">
								🔌
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
								🗑
							</button>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

/** 左栏「定时」：定时任务管理（v0.21.0 从工作台移入左侧工具栏）。 */
export function AutomationPanel({
	items,
	loading,
	error,
	onAdd,
	onToggle,
	onDelete,
}: {
	items: AutomationInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, prompt: string, schedule: { kind: string; time?: string; minutes?: number }) => Promise<boolean>;
	onToggle: (id: string, enabled: boolean) => Promise<boolean>;
	onDelete: (id: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [kind, setKind] = useState<"daily" | "interval">("daily");
	const [time, setTime] = useState("09:00");
	const [minutes, setMinutes] = useState("60");
	const [busy, setBusy] = useState(false);

	const submit = () => {
		if (!name.trim() || !prompt.trim() || busy) return;
		setBusy(true);
		void (async () => {
			const ok = await onAdd(
				name.trim(),
				prompt.trim(),
				kind === "daily" ? { kind, time } : { kind, minutes: Number(minutes) || 60 },
			);
			if (ok) {
				setName("");
				setPrompt("");
			}
			setBusy(false);
		})();
	};

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<PanelHeader title="定时任务" count={items.length} />
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="名称，如 每日摘要"
					aria-label="定时任务名称"
					className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="到点后发给助手的提示词"
					aria-label="定时任务提示词"
					rows={2}
					className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<div className="flex items-center gap-1.5">
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as "daily" | "interval")}
						aria-label="调度类型"
						className="rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
					>
						<option value="daily">每天</option>
						<option value="interval">每隔</option>
					</select>
					{kind === "daily" ? (
						<input
							type="time"
							value={time}
							onChange={(e) => setTime(e.target.value)}
							aria-label="执行时间"
							className="rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
						/>
					) : (
						<>
							<input
								type="number"
								min={1}
								value={minutes}
								onChange={(e) => setMinutes(e.target.value)}
								aria-label="间隔分钟"
								className="w-16 rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
							/>
							<span className="text-xs text-slate-500">分钟</span>
						</>
					)}
					<button
						type="button"
						onClick={submit}
						disabled={busy || !name.trim() || !prompt.trim()}
						className="ml-auto rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
					>
						{busy ? "创建中…" : "创建"}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{loading && items.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
				{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
				{!loading && items.length === 0 && !error && (
					<p className="px-1 py-2 text-xs text-slate-500">还没有定时任务。到点后助手会在指定会话里自动执行。</p>
				)}
				<ul className="space-y-1">
					{items.map((job) => (
						<li key={job.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
							<div className="flex items-center gap-2">
								<span aria-hidden className="text-xs">
									{job.enabled ? "⏰" : "⏸"}
								</span>
								<span className="min-w-0 flex-1 truncate text-[13px] text-slate-100">{job.name}</span>
								<button
									type="button"
									title={job.enabled ? "暂停" : "启用"}
									aria-label={`${job.enabled ? "暂停" : "启用"} ${job.name}`}
									onClick={() => void onToggle(job.id, !job.enabled)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
								>
									{job.enabled ? "暂停" : "启用"}
								</button>
								<button
									type="button"
									title="删除"
									aria-label={`删除 ${job.name}`}
									onClick={() => {
										if (window.confirm(`删除定时任务「${job.name}」？`)) void onDelete(job.id);
									}}
									className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
								>
									🗑
								</button>
							</div>
							<p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{job.prompt}</p>
							<p className="mt-0.5 text-[11px] text-slate-600">
								{job.scheduleLabel}
								{job.nextLabel ? ` · 下次 ${job.nextLabel}` : ""}
							</p>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

/** 左栏「技能」：技能管理（v0.21.0 从工作台移入左侧工具栏；修复了导入区块重复渲染的问题）。 */
export function SkillPanel({
	items,
	loading,
	error,
	onAdd,
	onDelete,
	onImport,
}: {
	items: SkillInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, description: string, content: string) => Promise<boolean>;
	onDelete: (name: string) => Promise<boolean>;
	onImport: (url: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [importUrl, setImportUrl] = useState("");
	const [community, setCommunity] = useState<{ name: string; description: string; needsLocal?: boolean; url: string }[]>([]);
	const [busyImport, setBusyImport] = useState<string | null>(null);
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [openName, setOpenName] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.communitySkills();
				if (alive) setCommunity(Array.isArray(data.skills) ? data.skills : []);
			} catch {
				// 社区目录不可用时静默降级
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	const submit = () => {
		if (!name.trim() || !content.trim() || busy) return;
		setBusy(true);
		void (async () => {
			const ok = await onAdd(name.trim(), description.trim(), content.trim());
			if (ok) {
				setName("");
				setDescription("");
				setContent("");
			}
			setBusy(false);
		})();
	};

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<PanelHeader title="技能" count={items.length} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="space-y-1.5 border-b border-slate-800/70 p-3">
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="技能名称，如 债券研报摘要"
						aria-label="技能名称"
						className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
					/>
					<input
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="一句话说明何时使用"
						aria-label="技能描述"
						className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
					/>
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						placeholder="技能正文（Markdown）：步骤、模板、约束"
						aria-label="技能内容"
						rows={3}
						className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
					/>
					<button
						type="button"
						onClick={submit}
						disabled={busy || !name.trim() || !content.trim()}
						className="w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
					>
						{busy ? "保存中…" : "添加 / 更新技能"}
					</button>
				</div>
				<div className="space-y-1.5 border-b border-slate-800/70 p-3">
					<div className="flex gap-1.5">
						<input
							value={importUrl}
							onChange={(e) => setImportUrl(e.target.value)}
							placeholder="从 URL 导入 SKILL.md / GitHub 目录"
							aria-label="技能来源链接"
							className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
						/>
						<button
							type="button"
							onClick={() => {
								if (!importUrl.trim()) return;
								setBusyImport(importUrl);
								void (async () => {
									const ok = await onImport(importUrl.trim());
									if (ok) setImportUrl("");
									setBusyImport(null);
								})();
							}}
							disabled={!importUrl.trim() || busyImport !== null}
							className="shrink-0 rounded-md border border-slate-600 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-40"
						>
							{busyImport ? "导入中…" : "导入"}
						</button>
					</div>
					{community.length > 0 && (
						<details className="rounded-md border border-slate-700/70 bg-slate-800/30 px-2 py-1.5">
							<summary className="cursor-pointer text-xs text-slate-300">从社区安装（badlogic/pi-skills）</summary>
							<ul className="mt-1.5 space-y-1">
								{community.map((item) => {
									const installed = items.some((skill) => skill.name === item.name);
									return (
										<li key={item.name} className="flex items-start gap-2">
											<span className="min-w-0 flex-1">
												<span className="block truncate text-[12px] text-slate-200">
													{item.name}
													{item.needsLocal && <span className="ml-1 text-[10px] text-amber-300">需本地命令行</span>}
												</span>
												<span className="block truncate text-[11px] text-slate-500">{item.description}</span>
											</span>
											<button
												type="button"
												onClick={() => {
													setBusyImport(item.name);
													void (async () => {
														await onImport(item.url);
														setBusyImport(null);
													})();
												}}
												disabled={busyImport !== null}
												className="shrink-0 rounded border border-slate-600 px-1.5 py-0.5 text-[11px] text-slate-200 disabled:opacity-40"
											>
												{installed ? "重新安装" : busyImport === item.name ? "安装中…" : "安装"}
											</button>
										</li>
									);
								})}
							</ul>
						</details>
					)}
				</div>
				<div className="p-2">
					{loading && items.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
					{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
					{!loading && items.length === 0 && !error && (
						<p className="px-1 py-2 text-xs text-slate-500">
							还没有技能。技能是「按需加载的说明书」：模型从索引里看到名称与用途，需要时用 load_skill 读取完整正文。
						</p>
					)}
					<ul className="space-y-1">
						{items.map((skill) => (
							<li key={skill.name} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
								<div className="flex items-center gap-2">
									<button
										type="button"
										onClick={() => setOpenName(openName === skill.name ? null : skill.name)}
										aria-expanded={openName === skill.name}
										className="min-w-0 flex-1 truncate text-left text-[13px] text-slate-100"
									>
										{openName === skill.name ? "▾" : "▸"} {skill.name}
									</button>
									<button
										type="button"
										title="删除"
										aria-label={`删除 ${skill.name}`}
										onClick={() => {
											if (window.confirm(`删除技能「${skill.name}」？`)) void onDelete(skill.name);
										}}
										className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
									>
										🗑
									</button>
								</div>
								{skill.description && <p className="mt-0.5 text-[11px] text-slate-500">{skill.description}</p>}
								{openName === skill.name && (
									<div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-700 bg-slate-950/50 p-2 text-[12px] leading-relaxed">
										{renderMarkdown(skill.content)}
									</div>
								)}
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}

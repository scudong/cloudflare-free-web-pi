import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/rich";
import type { AutomationInfo, FileInfo, McpServerInfo, MemoryInfo, SkillInfo } from "../types";

export type WorkbenchTab = "files" | "memories" | "mcp" | "automations" | "skills";

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
	mcpServers: McpServerInfo[];
	skills: SkillInfo[];
	skillsLoading: boolean;
	skillsError: string | null;
	onAddSkill: (name: string, description: string, content: string) => Promise<boolean>;
	onDeleteSkill: (name: string) => Promise<boolean>;
	automations: AutomationInfo[];
	automationsLoading: boolean;
	automationsError: string | null;
	mcpLoading: boolean;
	mcpError: string | null;
	/** Bumped after each chat round / deletion so an open file re-fetches fresh content. */
	refreshTick: number;
	onDeleteFile: (name: string) => Promise<boolean>;
	onDeleteMemory: (id: number) => Promise<boolean>;
	onAddMcp: (name: string, url: string) => Promise<boolean>;
	onDeleteMcp: (id: string) => Promise<boolean>;
	onAddAutomation: (name: string, prompt: string, schedule: { kind: string; time?: string; minutes?: number }) => Promise<boolean>;
	onToggleAutomation: (id: string, enabled: boolean) => Promise<boolean>;
	onDeleteAutomation: (id: string) => Promise<boolean>;
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
	);
}

/** The "连接" tab: MCP servers the agent can call tools from. */
function McpList({
	servers,
	loading,
	error,
	onAdd,
	onDelete,
}: {
	servers: McpServerInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, url: string) => Promise<boolean>;
	onDelete: (id: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = () => {
		if (!name.trim() || !url.trim() || busy) return;
		setBusy(true);
		void (async () => {
			const ok = await onAdd(name.trim(), url.trim());
			if (ok) {
				setName("");
				setUrl("");
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
							<span aria-hidden className="mt-0.5 text-xs">🔌</span>
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

/** The "定时" tab: scheduled prompts that run on their own. */
function AutomationList({
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
		<div className="flex min-h-0 flex-1 flex-col">
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
								<span aria-hidden className="text-xs">{job.enabled ? "⏰" : "⏸"}</span>
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

/** The "技能" tab: named instructions the agent loads on demand (v0.15.0). */
function SkillList({
	items,
	loading,
	error,
	onAdd,
	onDelete,
}: {
	items: SkillInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, description: string, content: string) => Promise<boolean>;
	onDelete: (name: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [openName, setOpenName] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
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
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
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
	mcpServers,
	mcpLoading,
	mcpError,
	skills,
	skillsLoading,
	skillsError,
	onAddSkill,
	onDeleteSkill,
	automations,
	automationsLoading,
	automationsError,
	refreshTick,
	onDeleteFile,
	onDeleteMemory,
	onAddMcp,
	onDeleteMcp,
	onAddAutomation,
	onToggleAutomation,
	onDeleteAutomation,
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
			className={`flex shrink-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 px-2.5 py-2 text-[12.5px] font-medium transition-colors ${
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
					<div className="flex shrink-0 items-stretch overflow-x-auto border-b border-slate-800/70" role="tablist">
						{tabButton("files", "文件", files.length)}
						{tabButton("memories", "记忆", memories.length)}
						{tabButton("mcp", "连接", mcpServers.length)}
						{tabButton("automations", "定时", automations.length)}
						{tabButton("skills", "技能", skills.length)}
					</div>
					{tab === "files" ? (
						<FileList
							files={files}
							loading={filesLoading}
							error={filesError}
							onOpen={setOpenName}
							onDelete={handleDeleteFile}
						/>
					) : tab === "memories" ? (
						<MemoryList memories={memories} loading={memoriesLoading} error={memoriesError} onDelete={handleDeleteMemory} />
					) : tab === "mcp" ? (
						<McpList servers={mcpServers} loading={mcpLoading} error={mcpError} onAdd={onAddMcp} onDelete={onDeleteMcp} />
					) : tab === "automations" ? (
						<AutomationList
							items={automations}
							loading={automationsLoading}
							error={automationsError}
							onAdd={onAddAutomation}
							onToggle={onToggleAutomation}
							onDelete={onDeleteAutomation}
						/>
					) : (
						<SkillList
							items={skills}
							loading={skillsLoading}
							error={skillsError}
							onAdd={onAddSkill}
							onDelete={onDeleteSkill}
						/>
					)}
				</>
			)}
		</aside>
	);
}

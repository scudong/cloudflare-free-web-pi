import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "./Icon";
import { SkillCard } from "./SkillCard";
import { SkillHubPanel } from "./SkillHubPanel";
import type { CustomToolInfo, PromptInfo, RuleInfo, SkillInfo, SkillInstallOutcome } from "../types";

/** 模块级 UI 记忆（契约 §6.3）：记住当前 tab；Hub 筛选词在 SkillHubPanel 内同样按模块级记忆保留。 */
const skillViewMemory = { view: "installed" as "installed" | "hub" };

/** 左栏「技能」：技能管理（v0.21.0 从工作台移入左侧工具栏；NERE-62 起为弹窗内容）。 */
export function SkillPanel({
	items,
	loading,
	error,
	onAdd,
	onDelete,
	onImport,
	onTry,
	prompts,
	rules,
	onAddPrompt,
	onDeletePrompt,
	onAddRule,
	onToggleRule,
	onDeleteRule,
	customTools,
	onAddCustomTool,
	onDeleteCustomTool,
}: {
	items: SkillInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, description: string, content: string) => Promise<boolean>;
	onDelete: (name: string) => Promise<boolean>;
	onImport: (url: string) => Promise<SkillInstallOutcome>;
	/** 「试用」（NERE-59）：把 `/技能名 ` 写进输入框并聚焦，不自动发送。 */
	onTry: (name: string) => void;
	/** 提示模板与规则（v0.31.0）。 */
	prompts: PromptInfo[];
	rules: RuleInfo[];
	onAddPrompt: (name: string, description: string, content: string) => Promise<boolean>;
	onDeletePrompt: (name: string) => Promise<boolean>;
	onAddRule: (name: string, content: string) => Promise<boolean>;
	onToggleRule: (name: string, enabled: boolean) => Promise<boolean>;
	onDeleteRule: (name: string) => Promise<boolean>;
	/** 自定义工具（v0.36.0）。 */
	customTools: CustomToolInfo[];
	onAddCustomTool: (name: string, description: string, parameters: string, code: string) => Promise<boolean>;
	onDeleteCustomTool: (name: string) => Promise<boolean>;
	/** 弹窗关闭回调（外壳由 ModalShell 提供，面板本身不用）。 */
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [importUrl, setImportUrl] = useState("");
	const [community, setCommunity] = useState<{ name: string; description: string; needsLocal?: boolean; url: string }[]>([]);
	const [busyImport, setBusyImport] = useState<string | null>(null);
	/** 导入 / 社区安装的失败首因（NERE-69）：弹窗里就地显示，不再写进被盖住的聊天流。 */
	const [importError, setImportError] = useState<string | null>(null);
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [openName, setOpenName] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** 「已安装 / Hub」视图切换（NERE-54）：默认停在已安装，Hub 只在切过去时取数。 */
	const [view, setViewState] = useState<"installed" | "hub">(skillViewMemory.view);
	const setView = (next: "installed" | "hub") => {
		skillViewMemory.view = next;
		setViewState(next);
	};

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
		<div className="flex min-h-0 flex-1 flex-col">
			<div role="tablist" aria-label="技能视图" className="flex shrink-0 gap-1 border-b border-slate-800/70 px-2 py-1.5">
				<button
					type="button"
					role="tab"
					aria-selected={view === "installed"}
					onClick={() => setView("installed")}
					className={skillTabClass(view === "installed")}
				>
					已安装 <span className="tabular-nums text-slate-500">{items.length}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={view === "hub"}
					onClick={() => setView("hub")}
					className={skillTabClass(view === "hub")}
				>
					Hub
				</button>
			</div>
			{view === "installed" ? (
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
								setImportError(null);
								void (async () => {
									const result = await onImport(importUrl.trim());
									if (result.ok) setImportUrl("");
									else setImportError(result.message);
									setBusyImport(null);
								})();
							}}
							disabled={!importUrl.trim() || busyImport !== null}
							className="shrink-0 rounded-md border border-slate-600 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-40"
						>
							{busyImport ? "导入中…" : "导入"}
						</button>
					</div>
					{importError && (
						<p role="alert" className="break-all text-[11px] leading-relaxed text-rose-300">
							安装失败：{importError}
						</p>
					)}
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
													setImportError(null);
													void (async () => {
														const result = await onImport(item.url);
														if (!result.ok) setImportError(result.message);
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
							<SkillCard
								key={skill.name}
								skill={skill}
								expanded={openName === skill.name}
								onToggle={(name) => setOpenName(openName === name ? null : name)}
								onDelete={onDelete}
								onTry={onTry}
							/>
						))}
					</ul>
				</div>

				{/* 自定义工具（v0.36.0） */}
				<details className="border-t border-slate-800/70 p-3">
					<summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-300">
						<Icon name="puzzle" className="h-3.5 w-3.5 text-slate-400" />
						自定义工具 <span className="tabular-nums text-slate-500">{customTools.length}</span>
					</summary>
					<p className="mt-1 text-[11px] leading-relaxed text-slate-500">
						贴一段 JavaScript：参数从 <code className="rounded bg-slate-800 px-1">args</code> 取，返回值即工具结果。在 QuickJS 沙箱里执行，默认按「执行级」参与审批。
					</p>
					<CustomToolForm onAdd={onAddCustomTool} />
					<ul className="mt-2 space-y-1">
						{customTools.map((tool) => (
							<li key={tool.name} className="flex items-start gap-2 rounded-lg bg-slate-800/50 px-2.5 py-1.5">
								<span className="min-w-0 flex-1">
									<span className="block truncate font-mono text-[12.5px] text-slate-100">{tool.name}</span>
									{tool.description && (
										<span className="block truncate text-[11px] text-slate-500">{tool.description}</span>
									)}
								</span>
								<button
									type="button"
									title="删除"
									aria-label={`删除自定义工具 ${tool.name}`}
									onClick={() => {
										if (window.confirm(`删除自定义工具「${tool.name}」？`)) void onDeleteCustomTool(tool.name);
									}}
									className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
								>
									<Icon name="trash" className="h-3.5 w-3.5" />
								</button>
							</li>
						))}
					</ul>
				</details>
				{/* 提示模板（v0.31.0） */}
				<details className="border-t border-slate-800/70 p-3">
					<summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-300">
						<Icon name="prompt" className="h-3.5 w-3.5 text-slate-400" />
						提示模板 <span className="tabular-nums text-slate-500">{prompts.length}</span>
					</summary>
					<p className="mt-1 text-[11px] leading-relaxed text-slate-500">
						输入框打 <code className="rounded bg-slate-800 px-1">/</code> 即可选中，正文会填进输入框。
					</p>
					<PromptForm onAdd={onAddPrompt} />
					<ul className="mt-2 space-y-1">
						{prompts.map((prompt) => (
							<li key={prompt.name} className="flex items-start gap-2 rounded-lg bg-slate-800/50 px-2.5 py-1.5">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] text-slate-100">{prompt.name}</span>
									{prompt.description && (
										<span className="block truncate text-[11px] text-slate-500">{prompt.description}</span>
									)}
								</span>
								<button
									type="button"
									title="删除"
									aria-label={`删除模板 ${prompt.name}`}
									onClick={() => {
										if (window.confirm(`删除模板「${prompt.name}」？`)) void onDeletePrompt(prompt.name);
									}}
									className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
								>
									<Icon name="trash" className="h-3.5 w-3.5" />
								</button>
							</li>
						))}
					</ul>
				</details>

				{/* 规则文件（v0.31.0） */}
				<details className="border-t border-slate-800/70 p-3">
					<summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-300">
						<Icon name="rule" className="h-3.5 w-3.5 text-slate-400" />
						规则 <span className="tabular-nums text-slate-500">{rules.filter((r) => r.enabled).length}/{rules.length}</span>
					</summary>
					<p className="mt-1 text-[11px] leading-relaxed text-slate-500">启用的规则会注入每一轮对话的提示词。</p>
					<RuleForm onAdd={onAddRule} />
					<ul className="mt-2 space-y-1">
						{rules.map((rule) => (
							<li key={rule.name} className="flex items-start gap-2 rounded-lg bg-slate-800/50 px-2.5 py-1.5">
								<button
									type="button"
									onClick={() => void onToggleRule(rule.name, !rule.enabled)}
									aria-pressed={rule.enabled}
									aria-label={`${rule.enabled ? "停用" : "启用"}规则 ${rule.name}`}
									className={`mt-0.5 inline-flex shrink-0 items-center justify-center rounded p-0.5 ${
										rule.enabled ? "text-emerald-400" : "text-slate-600"
									}`}
								>
									<Icon name={rule.enabled ? "checkboxOn" : "checkboxOff"} className="h-4 w-4" />
								</button>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] text-slate-100">{rule.name}</span>
									<span className="block truncate text-[11px] text-slate-500">{rule.content}</span>
								</span>
								<button
									type="button"
									title="删除"
									aria-label={`删除规则 ${rule.name}`}
									onClick={() => {
										if (window.confirm(`删除规则「${rule.name}」？`)) void onDeleteRule(rule.name);
									}}
									className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
								>
									<Icon name="trash" className="h-3.5 w-3.5" />
								</button>
							</li>
						))}
					</ul>
				</details>
			</div>
			) : (
				<SkillHubPanel installed={items.map((skill) => skill.name)} onInstall={onImport} onTry={onTry} />
			)}
		</div>
	);
}

/** 技能面板 Tab 样式（NERE-54）。 */
const skillTabClass = (active: boolean) =>
	`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
		active ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:bg-slate-800/60 hover:text-slate-300"
	}`;

/** 新增自定义工具的小表单（v0.36.0）。 */
function CustomToolForm({ onAdd }: { onAdd: (name: string, description: string, parameters: string, code: string) => Promise<boolean> }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [parameters, setParameters] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		if (!name.trim() || !code.trim() || busy) return;
		setBusy(true);
		setError(null);
		void (async () => {
			const ok = await onAdd(name.trim(), description.trim(), parameters.trim(), code.trim());
			if (ok) {
				setName("");
				setDescription("");
				setParameters("");
				setCode("");
			} else {
				setError("保存失败：检查工具名、JSON schema 或代码长度。");
			}
			setBusy(false);
		})();
	};

	return (
		<div className="mt-2 space-y-1.5">
			<input
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="工具名（字母开头，如 word_count）"
				aria-label="自定义工具名"
				className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-[12px] text-slate-100"
			/>
			<input
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				placeholder="一句话说明这个工具做什么"
				aria-label="自定义工具描述"
				className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-[12px] text-slate-100"
			/>
			<input
				value={parameters}
				onChange={(e) => setParameters(e.target.value)}
				placeholder='参数 schema（可留空）：{"type":"object","properties":{"text":{"type":"string"}}}'
				aria-label="参数 schema"
				className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 font-mono text-[11px] text-slate-100"
			/>
			<textarea
				value={code}
				onChange={(e) => setCode(e.target.value)}
				rows={4}
				placeholder={'// args 是入参对象，return 结果\nreturn { length: String(args.text ?? "").length };'}
				aria-label="自定义工具代码"
				className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 font-mono text-[11px] text-slate-100"
			/>
			{error && <p className="text-[11px] text-rose-300">{error}</p>}
			<button
				type="button"
				onClick={submit}
				disabled={!name.trim() || !code.trim() || busy}
				className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
			>
				{busy ? "保存中…" : "添加工具"}
			</button>
		</div>
	);
}

/** 新增提示模板的小表单。 */
function PromptForm({ onAdd }: { onAdd: (name: string, description: string, content: string) => Promise<boolean> }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="mt-2 space-y-1.5">
			<input
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="模板名，如 研报摘要"
				className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
			/>
			<input
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				placeholder="一句话说明"
				className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
			/>
			<textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="模板正文，可用 $1 / $ARGUMENTS 占位"
				rows={2}
				className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
			/>
			<button
				type="button"
				disabled={busy || !name.trim() || !content.trim()}
				onClick={() => {
					setBusy(true);
					void onAdd(name.trim(), description.trim(), content.trim()).then((ok) => {
						if (ok) {
							setName("");
							setDescription("");
							setContent("");
						}
						setBusy(false);
					});
				}}
				className="w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
			>
				{busy ? "保存中…" : "添加模板"}
			</button>
		</div>
	);
}

/** 新增规则的小表单。 */
function RuleForm({ onAdd }: { onAdd: (name: string, content: string) => Promise<boolean> }) {
	const [name, setName] = useState("");
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="mt-2 space-y-1.5">
			<input
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="规则名，如 输出语言"
				className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
			/>
			<textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="规则内容，如「始终用中文回答」"
				rows={2}
				className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
			/>
			<button
				type="button"
				disabled={busy || !name.trim() || !content.trim()}
				onClick={() => {
					setBusy(true);
					void onAdd(name.trim(), content.trim()).then((ok) => {
						if (ok) {
							setName("");
							setContent("");
						}
						setBusy(false);
					});
				}}
				className="w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
			>
				{busy ? "保存中…" : "添加规则"}
			</button>
		</div>
	);
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import { THEMES, type ThemeId } from "../lib/theme";
import { Icon, type IconName } from "./Icon";
import type { MemoryInfo } from "../types";

type ProviderInfo = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	keyHint?: string;
	active?: boolean;
};

type SettingsTab = "general" | "chat" | "model" | "memory" | "data";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
	/** 当前主题（v0.24.0：深色/浅色/米黄/午夜蓝）。 */
	theme: ThemeId;
	onThemeChange: (next: ThemeId) => void;
	leftOpen: boolean;
	rightOpen: boolean;
	onToggleLeft: () => void;
	onToggleRight: () => void;
	onExport: () => void;
	onShare: () => void;
	onBackup: () => void;
	onRestore: (file: File) => void;
	/** 网页搜索开关（null = 尚未读到后端设置）。 */
	webSearch: boolean | null;
	onToggleWebSearch: (next: boolean) => void;
	/** 知识库预检索开关（v0.46.0，null = 尚未读取）。 */
	kbPrefetch: boolean | null;
	onToggleKbPrefetch: (next: boolean) => void;
	/** 思考档位（v0.22.0）：off / low / high。 */
	thinkingLevel: string;
	onChangeThinkingLevel: (next: string) => void;
	/** 上下文压缩策略（v0.30.0）。 */
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number } | null;
	onChangeCompaction: (patch: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>) => void;
	/** 手动压缩的目标会话（v0.31.0）。 */
	sessionId: string;
	/** 工具审批策略（v0.33.0）。 */
	approval: { read: string; write: string; exec: string } | null;
	onChangeApproval: (patch: Partial<{ read: string; write: string; exec: string }>) => void;
	onChangeApprovalTool: (name: string, policy: string) => void;
	/** 记忆库（v0.21.0 从工作台移入设置）。 */
	memories: MemoryInfo[];
	memoriesLoading: boolean;
	memoriesError: string | null;
	onDeleteMemory: (id: number) => Promise<boolean>;
	/** 一键清空记忆库（v0.26.0）。 */
	onClearMemories: () => Promise<number | null>;
	/** 供应商变更后刷新模型列表（v0.27.0）。 */
	onModelsChanged?: () => void;
	/** 设置了访问密码才显示登出。 */
	authRequired: boolean;
	onLogout: () => void;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => onChange(!checked)}
			className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? "bg-sky-600" : "bg-slate-600"}`}
		>
			<span
				aria-hidden
				className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
			/>
		</button>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-b border-slate-700/70 py-4 first:pt-0 last:border-b-0 last:pb-0">
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
			{children}
		</section>
	);
}

const actionButton =
	"inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200 shadow-sm transition-colors hover:bg-slate-700/60 hover:text-white";

const TABS: { key: SettingsTab; label: string; icon: IconName }[] = [
	{ key: "general", label: "通用", icon: "settings" },
	{ key: "chat", label: "对话", icon: "chat" },
	{ key: "model", label: "模型", icon: "model" },
	{ key: "memory", label: "记忆", icon: "memory" },
	{ key: "data", label: "数据", icon: "data" },
];

/** 主题图标（v0.39.0：统一线性图标）。 */
const THEME_ICONS: Record<ThemeId, IconName> = {
	dark: "themeDark",
	light: "themeLight",
	sepia: "themeSepia",
	midnight: "themeMidnight",
};

/** 设置弹窗（v0.26.0：按子功能分 tab）。 */
export function SettingsDialog({
	open,
	onClose,
	theme,
	onThemeChange,
	leftOpen,
	rightOpen,
	onToggleLeft,
	onToggleRight,
	onExport,
	onShare,
	onBackup,
	onRestore,
	webSearch,
	onToggleWebSearch,
	kbPrefetch,
	onToggleKbPrefetch,
	thinkingLevel,
	onChangeThinkingLevel,
	compaction,
	onChangeCompaction,
	sessionId,
	approval,
	onChangeApproval,
	onChangeApprovalTool,
	memories,
	memoriesLoading,
	memoriesError,
	onDeleteMemory,
	onClearMemories,
	onModelsChanged,
	authRequired,
	onLogout,
}: SettingsDialogProps) {
	const restoreRef = useRef<HTMLInputElement>(null);
	const [tab, setTab] = useState<SettingsTab>("general");
	const [clearing, setClearing] = useState(false);
	/** 工具清单（v0.33.0）：打开「对话」tab 时读取，用于逐工具覆盖。 */
	const [toolList, setToolList] = useState<{ name: string; category: string; policy: string; override: string }[]>([]);
	/** pi 内核版本（v0.35.0）。 */
	const [kernel, setKernel] = useState<{
		current?: Record<string, string>;
		latest?: Record<string, string>;
		checkedAt?: string;
		updateAvailable?: boolean;
		outdated?: string[];
		upgrade?: { manual?: string; auto?: string };
	} | null>(null);
	const [kernelBusy, setKernelBusy] = useState(false);

	const loadKernel = async (refresh: boolean) => {
		setKernelBusy(true);
		try {
			const data = await api.kernel(refresh);
			setKernel(data);
		} catch {
			setKernel(null);
		} finally {
			setKernelBusy(false);
		}
	};

	/** 手动压缩（v0.31.0）。 */
	const [compactState, setCompactState] = useState<"idle" | "running" | "done" | "error">("idle");
	const [compactMessage, setCompactMessage] = useState("");

	const handleCompactNow = async () => {
		setCompactState("running");
		setCompactMessage("");
		try {
			const res = await api.compact(sessionId);
			if (res.error) {
				setCompactState("error");
				setCompactMessage(res.error);
			} else {
				setCompactState("done");
				setCompactMessage("已提交压缩任务，完成后聊天里会出现提示。");
			}
		} catch (err) {
			setCompactState("error");
			setCompactMessage(err instanceof Error ? err.message : String(err));
		}
	};

	// pi 内核版本（v0.35.0）：打开设置时读一次（走 6 小时缓存）
	useEffect(() => {
		if (!open) return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.kernel(false);
				if (alive) setKernel(data);
			} catch {
				// 接口不可用时保持空
			}
		})();
		return () => {
			alive = false;
		};
	}, [open]);

	// 工具清单（v0.33.0）
	useEffect(() => {
		if (!open || tab !== "chat") return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.tools();
				if (alive && Array.isArray(data.tools)) setToolList(data.tools);
			} catch {
				// 接口不可用时保持空列表
			}
		})();
		return () => {
			alive = false;
		};
	}, [open, tab]);

	// 供应商（v0.27.0）
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [defaultProvider, setDefaultProvider] = useState<{ id: string; name: string; models: string[] } | null>(null);
	const [activeProvider, setActiveProvider] = useState("");
	const [providersLoading, setProvidersLoading] = useState(false);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [providerBusy, setProviderBusy] = useState(false);
	const [form, setForm] = useState<{ id?: string; name: string; baseUrl: string; apiKey: string; models: string } | null>(null);

	const loadProviders = async () => {
		setProvidersLoading(true);
		try {
			const data = await api.providers();
			setProviders(Array.isArray(data.providers) ? data.providers : []);
			setDefaultProvider(data.default ?? null);
			setActiveProvider(data.active ?? "");
			setProviderError(null);
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProvidersLoading(false);
		}
	};

	useEffect(() => {
		if (open && tab === "model") void loadProviders();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, tab]);

	const activateProvider = async (id: string) => {
		if (providerBusy) return;
		setProviderBusy(true);
		try {
			await api.activateProvider(id);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	const saveProvider = async () => {
		if (!form || providerBusy) return;
		setProviderBusy(true);
		try {
			await api.saveProvider({
				id: form.id,
				name: form.name,
				baseUrl: form.baseUrl,
				apiKey: form.apiKey,
				models: form.models,
			});
			setForm(null);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	const removeProvider = async (id: string, name: string) => {
		if (!window.confirm(`删除供应商「${name}」？`)) return;
		setProviderBusy(true);
		try {
			await api.deleteProvider(id);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	// 每次打开回到第一个 tab
	useEffect(() => {
		if (open) setTab("general");
	}, [open]);

	const handleClear = () => {
		if (clearing || memories.length === 0) return;
		if (!window.confirm(`确定清空全部 ${memories.length} 条记忆？此操作不可撤销。`)) return;
		setClearing(true);
		void onClearMemories().finally(() => setClearing(false));
	};

	if (!open) return null;

	return (
		<div className="absolute inset-0 z-40">
			<button type="button" aria-label="关闭设置" onClick={onClose} className="dialog-scrim absolute inset-0" />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="设置"
				className="absolute left-1/2 top-1/2 flex max-h-[86vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl ring-1 ring-black/5"
			>
				{/* 标题 */}
				<div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
					<h1 className="text-base font-semibold text-slate-100">设置</h1>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭"
						className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>

				{/* 分类 tab */}
				<div role="tablist" aria-label="设置分类" className="flex shrink-0 gap-1 px-4">
					{TABS.map((item) => (
						<button
							key={item.key}
							type="button"
							role="tab"
							aria-selected={tab === item.key}
							onClick={() => setTab(item.key)}
							className={`flex flex-1 items-center justify-center gap-1.5 rounded-t-lg border-b-2 px-2 py-2 text-[13px] font-medium transition-colors ${
								tab === item.key
									? "border-sky-500 text-sky-300"
									: "border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-200"
							}`}
						>
						<Icon name={item.icon} className="h-3.5 w-3.5" />
							{item.label}
						</button>
					))}
				</div>

				{/* 内容区 */}
				<div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-800 px-5 py-4">
					{tab === "general" && (
						<>
							<Section title="外观">
								<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
									{THEMES.map((option) => (
										<button
											key={option.id}
											type="button"
											onClick={() => onThemeChange(option.id)}
											aria-pressed={theme === option.id}
											className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-xs transition-colors ${
												theme === option.id
													? "border-sky-500/70 bg-sky-500/10 text-slate-100"
													: "border-slate-700 text-slate-300 hover:border-slate-600 hover:text-white"
											}`}
										>
											<span
												aria-hidden
												className="h-6 w-full rounded border border-slate-600/60"
												style={{ backgroundColor: option.swatch }}
											/>
											<span className="flex items-center gap-1">
												<Icon name={THEME_ICONS[option.id]} className="h-3.5 w-3.5" />
												{option.label}
											</span>
										</button>
									))}
								</div>
							</Section>

							<Section title="布局">
								<div className="flex flex-col gap-3">
									<div className="flex items-center justify-between">
										<span className="text-sm text-slate-200">会话栏（左侧）</span>
										<Switch checked={leftOpen} onChange={onToggleLeft} label="显示/收起会话栏" />
									</div>
									<div className="flex items-center justify-between">
										<span className="text-sm text-slate-200">工作台（右侧）</span>
										<Switch checked={rightOpen} onChange={onToggleRight} label="显示/收起工作台" />
									</div>
								</div>
							</Section>

							{authRequired && (
								<Section title="账号">
									<button
										type="button"
										onClick={onLogout}
										className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/20"
									>
										退出登录
									</button>
								</Section>
							)}
						</>
					)}

					{tab === "general" && (
						<Section title="pi 内核">
							<p className="mb-2 text-xs leading-relaxed text-slate-500">
								内核是 pi-durable / pi-ai / pi-mcp / pi-codemode 四个包。升级后构建、金标与打包校验全部通过才会部署。
							</p>
							<ul className="space-y-0.5 text-xs">
								{Object.entries(kernel?.current ?? {}).map(([name, version]) => {
									const latest = kernel?.latest?.[name];
									const outdated = kernel?.outdated?.includes(name);
									return (
										<li key={name} className="flex items-center justify-between gap-2">
											<span className="truncate text-slate-300">{name.replace("@earendil-works/", "")}</span>
											<span className={outdated ? "text-amber-300" : "text-slate-500"}>
												{version}
												{outdated && latest ? ` → ${latest}` : ""}
											</span>
										</li>
									);
								})}
								{!kernel && <li className="text-slate-500">正在读取版本…</li>}
							</ul>
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<button
									type="button"
									onClick={() => void loadKernel(true)}
									disabled={kernelBusy}
									className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
								>
									{kernelBusy ? "检查中…" : "检查更新"}
								</button>
								{kernel?.checkedAt && (
									<span className="text-[11px] text-slate-500">
										上次检查：{new Date(kernel.checkedAt).toLocaleString("zh-CN", { hour12: false })}
									</span>
								)}
							</div>
							{kernel?.updateAvailable ? (
								<div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
									<p>发现新版本：{(kernel.outdated ?? []).join("、")}</p>
									<p className="mt-1 text-amber-200/80">手动：{kernel.upgrade?.manual ?? "npm run upgrade:pi"}</p>
									<p className="mt-0.5 text-amber-200/80">自动：{kernel.upgrade?.auto ?? "每周自动开 PR"}</p>
								</div>
							) : (
								kernel && !kernel.updateAvailable && <p className="mt-2 text-xs text-emerald-300">已是最新版本。</p>
							)}
						</Section>
					)}

					{tab === "chat" && (
						<>
							<Section title="思考过程">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									开启后模型先思考再回答，聊天里会出现可展开的「思考过程」块。档位越高越慢、越费 token。
								</p>
								<div className="inline-flex rounded-lg border border-slate-700 p-0.5">
									{[
										{ value: "off", label: "关闭" },
										{ value: "low", label: "低" },
										{ value: "high", label: "高" },
									].map((option) => (
										<button
											key={option.value}
											type="button"
											onClick={() => onChangeThinkingLevel(option.value)}
											aria-pressed={thinkingLevel === option.value}
											className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
												thinkingLevel === option.value ? "bg-violet-600 text-white" : "text-slate-300 hover:text-white"
											}`}
										>
											{option.label}
										</button>
									))}
								</div>
							</Section>

							<Section title="上下文压缩">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm text-slate-200">自动压缩长对话</p>
										<p className="mt-1 text-xs leading-relaxed text-slate-500">
											接近上下文上限时，把较早的内容摘要成一条记录，保留最近 {compaction?.keepRecentTokens ?? 20000} tokens 原文。
										</p>
									</div>
									<Switch
										checked={compaction?.enabled !== false}
										onChange={(next) => onChangeCompaction({ enabled: next })}
										label="启用自动压缩"
									/>
								</div>
								<div className="mt-3 grid grid-cols-2 gap-2">
									<label className="text-xs text-slate-400">
										保留原文 tokens
										<input
											type="number"
											min={0}
											step={1000}
											value={compaction?.keepRecentTokens ?? 20000}
											onChange={(e) => onChangeCompaction({ keepRecentTokens: Number(e.target.value) })}
											className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
										/>
									</label>
									<label className="text-xs text-slate-400">
										预留回答 tokens
										<input
											type="number"
											min={1024}
											step={1024}
											value={compaction?.reserveTokens ?? 16384}
											onChange={(e) => onChangeCompaction({ reserveTokens: Number(e.target.value) })}
											className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
										/>
									</label>
								</div>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<button
										type="button"
										onClick={() => void handleCompactNow()}
										disabled={compactState === "running"}
										className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
									>
										{compactState === "running" ? "压缩中…" : "立即压缩当前会话"}
									</button>
									{compactMessage && (
										<span className={`text-xs ${compactState === "error" ? "text-rose-300" : "text-emerald-300"}`}>
											{compactMessage}
										</span>
									)}
								</div>
							</Section>


							<Section title="工具审批">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									按 read / write / exec 三档控制工具：放行 = 直接执行；询问 = 聊天里出现待审批条，点允许后才执行；禁止 = 直接拒绝。
								</p>
								<div className="grid grid-cols-3 gap-2">
									{([
										["read", "读取"],
										["write", "写入"],
										["exec", "执行"],
									] as const).map(([level, label]) => (
										<label key={level} className="text-xs text-slate-400">
											{label}
											<select
												value={approval?.[level] ?? "allow"}
												onChange={(e) => onChangeApproval({ [level]: e.target.value })}
												className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
											>
												<option value="allow">放行</option>
												<option value="ask">询问</option>
												<option value="deny">禁止</option>
											</select>
										</label>
									))}
								</div>
								<details className="mt-3 rounded-md border border-slate-800 p-2">
									<summary className="cursor-pointer text-xs text-slate-400">
										逐工具覆盖（{toolList.length} 个工具）
									</summary>
									<ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
										{toolList.map((tool) => (
											<li key={tool.name} className="flex items-center justify-between gap-2 text-xs">
												<span className="min-w-0 truncate text-slate-300" title={`${tool.name} · ${tool.category}`}>
													{tool.name}
													<span className="ml-1 text-[10px] text-slate-500">{tool.category}</span>
												</span>
												<select
													value={tool.override}
													onChange={(e) => {
														const next = e.target.value;
														onChangeApprovalTool(tool.name, next);
														setToolList((prev) => prev.map((t) => (t.name === tool.name ? { ...t, override: next } : t)));
													}}
													aria-label={`${tool.name} 的审批策略`}
													className="w-24 shrink-0 rounded-md border border-slate-700 bg-slate-800/70 px-1 py-1 text-[11px] text-slate-100"
												>
													<option value="follow">跟随分级</option>
													<option value="allow">放行</option>
													<option value="ask">询问</option>
													<option value="deny">禁止</option>
												</select>
											</li>
										))}
									</ul>
								</details>
							</Section>
							<Section title="知识库预检索">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm text-slate-200">每轮自动检索知识库</p>
										<p className="mt-1 text-xs leading-relaxed text-slate-500">
											发送消息时先用它检索知识库，命中就把前 3 段（最多约 1.8k 字）放进本轮系统提示；没命中不增加内容。关闭后模型仍可主动调用 kb_search。
										</p>
									</div>
									<Switch checked={kbPrefetch !== false} onChange={onToggleKbPrefetch} label="启用知识库预检索" />
								</div>
								{kbPrefetch === null && <p className="mt-2 text-xs text-slate-500">正在读取设置…</p>}
							</Section>
							<Section title="网页搜索">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm text-slate-200">启用 DeepSeek 联网搜索</p>
										<p className="mt-1 text-xs leading-relaxed text-slate-500">
											开启后模型可用 web_search 搜索、web_fetch_page 抓取正文，按成功请求计费（约 ¥5 / 1000 次）。
										</p>
									</div>
									<Switch checked={webSearch === true} onChange={onToggleWebSearch} label="启用网页搜索" />
								</div>
								{webSearch === null && <p className="mt-2 text-xs text-slate-500">正在读取设置…</p>}
							</Section>
						</>
					)}

					{tab === "model" && (
						<>
							<Section title="LLM 供应商">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									任意 OpenAI 兼容端点都可接入。切换后对<strong>新对话</strong>生效；已开会话需要重新选模型。
								</p>
								{providerError && <p className="mb-2 text-xs text-rose-300">{providerError}</p>}
								<ul className="space-y-2">
									{/* 内置默认供应商 */}
									<li
										className={`rounded-lg border px-3 py-2 ${
											activeProvider === ""
												? "border-sky-500/60 bg-sky-500/10"
												: "border-slate-700 bg-slate-800/40"
										}`}
									>
										<div className="flex items-center gap-2">
											<Icon name="globe" className="h-4 w-4 shrink-0 text-sky-400" />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-[13px] font-medium text-slate-100">
													{defaultProvider?.name ?? "DeepSeek 官方"}
													{activeProvider === "" && <span className="ml-1.5 text-[11px] text-sky-300">使用中</span>}
												</span>
												<span className="block truncate text-[11px] text-slate-500">
													api.deepseek.com · {(defaultProvider?.models ?? []).join(" / ")}
												</span>
											</span>
											{activeProvider !== "" && (
												<button
													type="button"
													onClick={() => void activateProvider("")}
													disabled={providerBusy}
													className="shrink-0 rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:border-sky-500/60 hover:text-sky-300 disabled:opacity-40"
												>
													启用
												</button>
											)}
										</div>
									</li>

									{providers.map((item) => (
										<li
											key={item.id}
											className={`rounded-lg border px-3 py-2 ${
												item.active ? "border-sky-500/60 bg-sky-500/10" : "border-slate-700 bg-slate-800/40"
											}`}
										>
											<div className="flex items-center gap-2">
												<Icon name="puzzle" className="h-4 w-4 shrink-0 text-sky-400" />
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[13px] font-medium text-slate-100">
														{item.name}
														{item.active && <span className="ml-1.5 text-[11px] text-sky-300">使用中</span>}
													</span>
													<span className="block truncate text-[11px] text-slate-500">
														{item.baseUrl.replace(/^https?:\/\//, "")}
														{item.keyHint ? ` · ${item.keyHint}` : ""} · {item.models.join(" / ")}
													</span>
												</span>
												{!item.active && (
													<button
														type="button"
														onClick={() => void activateProvider(item.id)}
														disabled={providerBusy}
														className="shrink-0 rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:border-sky-500/60 hover:text-sky-300 disabled:opacity-40"
													>
														启用
													</button>
												)}
												<button
													type="button"
													onClick={() =>
														setForm({
															id: item.id,
															name: item.name,
															baseUrl: item.baseUrl,
															apiKey: "",
															models: item.models.join(", "),
														})
													}
													className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-slate-100"
												>
													编辑
												</button>
												<button
													type="button"
													onClick={() => void removeProvider(item.id, item.name)}
													disabled={providerBusy}
													className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-40"
												>
													删除
												</button>
											</div>
										</li>
									))}
								</ul>
								{providersLoading && <p className="mt-2 text-xs text-slate-500">正在加载…</p>}

								{form ? (
									<div className="mt-3 space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
										<p className="text-xs font-medium text-slate-300">{form.id ? "编辑供应商" : "新增供应商"}</p>
										<input
											value={form.name}
											onChange={(e) => setForm({ ...form, name: e.target.value })}
											placeholder="名称，如 月之暗面"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<input
											value={form.baseUrl}
											onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
											placeholder="https://api.example.com/v1"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<input
											value={form.apiKey}
											onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
											placeholder={form.id ? "API Key（留空则保持不变）" : "API Key"}
											type="password"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<input
											value={form.models}
											onChange={(e) => setForm({ ...form, models: e.target.value })}
											placeholder="模型 ID，逗号分隔，如 kimi-k2, kimi-k1.5"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<div className="flex gap-1.5 pt-0.5">
											<button
												type="button"
												onClick={() => void saveProvider()}
												disabled={providerBusy || !form.name.trim() || !form.baseUrl.trim() || !form.models.trim()}
												className="rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
											>
												{providerBusy ? "保存中…" : "保存"}
											</button>
											<button
												type="button"
												onClick={() => setForm(null)}
												className="rounded-md border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300"
											>
												取消
											</button>
										</div>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setForm({ name: "", baseUrl: "", apiKey: "", models: "" })}
										className="mt-3 w-full rounded-lg border border-dashed border-slate-600 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-sky-500/60 hover:text-sky-300"
									>
										＋ 新增供应商
									</button>
								)}
							</Section>
						</>
					)}

					{tab === "memory" && (
						<Section title={`记忆库${memories.length ? `（${memories.length}）` : ""}`}>
							<div className="mb-2 flex items-center justify-between gap-2">
								<p className="text-xs leading-relaxed text-slate-500">
									对 π 说「记住…」可保存；每轮对话结束也会自动抽取。
								</p>
								<button
									type="button"
									onClick={handleClear}
									disabled={clearing || memories.length === 0}
									className="shrink-0 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
								>
									{clearing ? "清空中…" : "清空全部"}
								</button>
							</div>
							<div className="max-h-[46vh] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-1.5">
								{memoriesError && <p className="px-1.5 py-1.5 text-xs text-rose-300">{memoriesError}</p>}
								{memoriesLoading && memories.length === 0 && (
									<p className="px-1.5 py-1.5 text-xs text-slate-500">正在加载…</p>
								)}
								{!memoriesLoading && !memoriesError && memories.length === 0 && (
									<p className="px-1.5 py-2 text-xs leading-relaxed text-slate-500">记忆库还是空的。</p>
								)}
								<ul className="space-y-1">
									{memories.map((memory) => (
										<li key={memory.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
											<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-200">
												{memory.content}
											</p>
											<div className="mt-1.5 flex items-center justify-between gap-2">
												<span className="min-w-0 truncate text-[11px] text-slate-500">
													{memory.source === "reflect" ? "自动抽取 · " : ""}
													{formatTime(memory.createdAt)}
												</span>
												{memory.id > 0 && (
													<button
														type="button"
														onClick={() => void onDeleteMemory(memory.id)}
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
						</Section>
					)}

					{tab === "data" && (
						<Section title="数据">
							<div className="grid grid-cols-2 gap-2">
								<button type="button" onClick={onShare} className={actionButton}>
									<Icon name="share" className="h-4 w-4" />
									分享当前会话
								</button>
								<button type="button" onClick={onExport} className={actionButton}>
									<Icon name="download" className="h-4 w-4" />
									导出 Markdown
								</button>
								<button type="button" onClick={onBackup} className={actionButton}>
									<Icon name="backup" className="h-4 w-4" />
									备份数据
								</button>
								<button type="button" onClick={() => restoreRef.current?.click()} className={actionButton}>
									<Icon name="restore" className="h-4 w-4" />
									恢复备份
								</button>
							</div>
							<input
								ref={restoreRef}
								type="file"
								accept="application/json,.json"
								hidden
								onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) onRestore(file);
									event.target.value = "";
								}}
							/>
							<p className="mt-2 text-xs leading-relaxed text-slate-500">
								备份含 MCP 密钥，请妥善保管；恢复为合并式，不删除现有数据。
							</p>
						</Section>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * 左栏「技能 · Hub」视图（NERE-54，L2）：市场列表 + 筛选 + 审计状态 + 详情/安装。
 *
 * - 取数只经 `useSkillHub`，组件不拼接口、不直接 fetch。
 * - 安装复用现有导入流（`onInstall` → App 的 handleImportSkill）；blocked 条目按钮禁用。
 * - 安装结果留在弹窗内（NERE-69）：成功 → 行内「已安装 · 试用」；失败 → 行内红字取首条审计原因。
 * - 三态：首次加载骨架 / 失败可重试 / 筛选后空态；旧数据在刷新失败时保留。
 */

import { useEffect, useMemo, useState } from "react";
import { useSkillHub } from "../hooks/useSkillHub";
import {
	EMPTY_SKILL_HUB_FILTERS,
	HUB_AUDIT_FILTERS,
	HUB_RUNTIME_FILTERS,
	canInstallHubEntry,
	hasActiveHubFilters,
	hubEntryInstallUrl,
	type SkillHubFilters,
} from "../lib/skill-hub";
import type { SkillHubEntry, SkillInstallOutcome } from "../types";
import { Icon } from "./Icon";
import { SkillHubRow } from "./SkillHubRow";

const CONTROL =
	"w-full min-w-0 rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100 placeholder:text-slate-500";

function FilterSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: readonly { value: string; label: string }[];
}) {
	return (
		<select
			aria-label={label}
			title={label}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={CONTROL}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
}

/** 模块级 UI 记忆（契约 §6.3）：Hub 筛选词在弹窗关闭后保留；不做跨刷新持久化。 */
const viewMemory = { filters: EMPTY_SKILL_HUB_FILTERS };

export function SkillHubPanel({
	installed,
	onInstall,
	onTry,
}: {
	/** 已安装的技能名：用于「已安装 / 重新安装」标记。 */
	installed: string[];
	/** 现有导入流（App.handleImportSkill），返回结构化结果供行内反馈。 */
	onInstall: (url: string) => Promise<SkillInstallOutcome>;
	/** 「试用」（NERE-69）：由页面层关弹窗并预填 `/技能名 `。 */
	onTry: (name: string) => void;
}) {
	const [filters, setFilters] = useState<SkillHubFilters>(viewMemory.filters);
	useEffect(() => {
		viewMemory.filters = filters;
	}, [filters]);
	const { items, facets, catalogStale, status, error, rawCount, reload } = useSkillHub(filters);
	const [openName, setOpenName] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	/** 本次会话刚装成功的名字：面板不重取，立即把行切到「已安装 · 试用」。 */
	const [installedHere, setInstalledHere] = useState<ReadonlySet<string>>(() => new Set());
	/** 本次会话的安装失败首因：按技能名保留，重试时清掉。 */
	const [installErrors, setInstallErrors] = useState<Readonly<Record<string, string>>>({});
	const installedSet = useMemo(
		() => new Set([...installed, ...installedHere]),
		[installed, installedHere],
	);
	const loading = status === "loading";
	const filtersActive = hasActiveHubFilters(filters);
	const firstLoad = loading && rawCount === 0;

	const patch = (key: keyof SkillHubFilters, value: string) => {
		setFilters((previous) => ({ ...previous, [key]: value }));
	};

	const install = (entry: SkillHubEntry) => {
		if (installing || !canInstallHubEntry(entry)) return;
		const url = hubEntryInstallUrl(entry);
		const name = entry.name;
		setInstalling(name);
		setInstallErrors((previous) => {
			if (!(name in previous)) return previous;
			const next = { ...previous };
			delete next[name];
			return next;
		});
		void (async () => {
			try {
				const result = await onInstall(url);
				if (result.ok) {
					setInstalledHere((previous) => new Set(previous).add(name));
				} else {
					setInstallErrors((previous) => ({ ...previous, [name]: result.message }));
				}
			} catch (err) {
				const message = err instanceof Error && err.message ? err.message : String(err);
				setInstallErrors((previous) => ({ ...previous, [name]: message }));
			} finally {
				// 失败也要恢复可点（验收 3）：不卡在「安装中…」。
				setInstalling((current) => (current === name ? null : current));
			}
		})();
	};

	const tagOptions = [{ value: "", label: "全部标签" }, ...facets.tags.map((tag) => ({ value: tag, label: tag }))];
	const sourceOptions = [{ value: "", label: "全部来源" }, ...facets.sources.map((source) => ({ value: source, label: source }))];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
				<input
					value={filters.q}
					onChange={(event) => patch("q", event.target.value)}
					placeholder="搜索技能名称、描述或标签"
					aria-label="搜索 Skill Hub"
					maxLength={100}
					className={CONTROL}
				/>
				<div className="grid grid-cols-2 gap-1.5">
					<FilterSelect
						label="按运行时筛选"
						value={filters.runtime}
						onChange={(value) => patch("runtime", value)}
						options={HUB_RUNTIME_FILTERS}
					/>
					<FilterSelect
						label="按审计状态筛选"
						value={filters.audit}
						onChange={(value) => patch("audit", value)}
						options={HUB_AUDIT_FILTERS}
					/>
					<FilterSelect label="按标签筛选" value={filters.tag} onChange={(value) => patch("tag", value)} options={tagOptions} />
					<FilterSelect label="按来源筛选" value={filters.source} onChange={(value) => patch("source", value)} options={sourceOptions} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading || undefined}>
				<p role="status" className="sr-only">
					{loading ? "正在加载技能列表" : `共 ${items.length} 条技能`}
				</p>

				{catalogStale && (
					<p
						role="status"
						className="mx-2 mt-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200"
					>
						目录可能过期：远程刷新失败，当前显示内置或上次快照；已安装技能仍可用。
					</p>
				)}

				{error && (
					<div
						role="alert"
						className="m-2 space-y-1.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200"
					>
						<p>Hub 加载失败：{error}</p>
						<button
							type="button"
							onClick={reload}
							className="rounded-md border border-rose-400/40 px-2 py-0.5 text-[11px] text-rose-100 transition-colors hover:bg-rose-900/40"
						>
							重试
						</button>
					</div>
				)}

				{firstLoad ? (
					<div className="space-y-2 p-2" aria-hidden>
						{[0, 1, 2].map((row) => (
							<div key={row} className="h-[74px] animate-pulse rounded-lg bg-slate-800/50" />
						))}
					</div>
				) : items.length > 0 ? (
					<ul className="space-y-1.5 p-2">
						{items.map((entry) => (
							<SkillHubRow
								key={entry.name}
								entry={entry}
								expanded={openName === entry.name}
								installed={installedSet.has(entry.name)}
								installedNow={installedHere.has(entry.name)}
								installing={installing === entry.name}
								installError={installErrors[entry.name] ?? null}
								onToggle={(name) => setOpenName((current) => (current === name ? null : name))}
								onInstall={install}
								onTry={onTry}
							/>
						))}
					</ul>
				) : status === "error" ? null : (
					<div className="p-3">
						<p className="text-xs leading-relaxed text-slate-500">
							{filtersActive ? "没有匹配的技能。换个关键词或清空筛选试试。" : "Hub 暂时没有可用技能，稍后刷新试试。"}
						</p>
						{filtersActive && (
							<button
								type="button"
								onClick={() => setFilters(EMPTY_SKILL_HUB_FILTERS)}
								className="mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-800"
							>
								清空筛选
							</button>
						)}
					</div>
				)}

				{loading && !firstLoad && (
					<p className="flex items-center gap-1.5 px-2 pb-2 text-[10px] text-slate-500">
						<Icon name="loader" className="h-3 w-3 animate-spin" />
						正在刷新筛选结果…
					</p>
				)}
			</div>
		</div>
	);
}

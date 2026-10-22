/**
 * 已安装技能的一张卡片（NERE-59）：标题 + 摘要 + 运行时 / 审计 / 上次使用 + 试用。
 *
 * 纯展示（L3）：不取数、不 import api，删除与试用都只回调。
 * 「上次使用」整行只在服务端有埋点字段时渲染；没有数据就什么都不显示（验收 4）。
 */

import { renderMarkdown } from "../lib/rich";
import { SKILL_AUDIT_LABELS, SKILL_AUDIT_STYLES } from "../lib/skill-hub";
import { lastUsedLabel, shouldSuggestRemoval, skillRuntimeLabel } from "../lib/skill-usage";
import type { SkillInfo } from "../types";
import { Icon } from "./Icon";

const CHIP = "rounded-full px-1.5 py-px text-[10px] leading-4";

export function SkillCard({
	skill,
	expanded,
	onToggle,
	onDelete,
	onTry,
	now = Date.now(),
}: {
	skill: SkillInfo;
	expanded: boolean;
	onToggle: (name: string) => void;
	onDelete: (name: string) => void;
	/** 「试用」：由页面层把 `/技能名 ` 写进输入框，不自动发送。 */
	onTry: (name: string) => void;
	now?: number;
}) {
	const runtime = skillRuntimeLabel(skill.runtime);
	const audit = skill.auditStatus;
	const used = lastUsedLabel(skill.lastInvokedAt, now);
	const suggestRemoval = shouldSuggestRemoval(skill, now);

	return (
		<li className="rounded-lg bg-slate-800/50 px-2.5 py-2">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => onToggle(skill.name)}
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 items-center gap-1 truncate text-left text-[13px] text-slate-100"
				>
					<Icon
						name={expanded ? "chevronDown" : "chevronRight"}
						className="h-3.5 w-3.5 shrink-0 text-slate-400"
					/>
					<span className="truncate">{skill.name}</span>
				</button>
				<button
					type="button"
					title="把 /技能名 填进输入框，不发送"
					aria-label={`试用 ${skill.name}`}
					onClick={() => onTry(skill.name)}
					className="shrink-0 rounded border border-slate-600 px-1.5 py-0.5 text-[11px] text-slate-200 hover:bg-sky-500/20 hover:text-sky-200"
				>
					试用
				</button>
				<button
					type="button"
					title="删除"
					aria-label={`删除 ${skill.name}`}
					onClick={() => {
						if (window.confirm(`删除技能「${skill.name}」？`)) onDelete(skill.name);
					}}
					className="shrink-0 rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
				>
					<Icon name="trash" className="h-3.5 w-3.5" />
				</button>
			</div>
			{skill.description && <p className="mt-0.5 text-[11px] text-slate-500">{skill.description}</p>}
			{used !== null && (
				<div className="mt-1 flex flex-wrap items-center gap-1">
					{runtime && <span className={`${CHIP} bg-slate-700/70 text-slate-300`}>{runtime}</span>}
					{audit && <span className={`${CHIP} ${SKILL_AUDIT_STYLES[audit]}`}>{SKILL_AUDIT_LABELS[audit]}</span>}
					<span className="text-[10px] text-slate-500">上次使用：{used}</span>
				</div>
			)}
			{suggestRemoval && (
				<p className="mt-1 text-[10px] leading-relaxed text-slate-500">
					还没用过。试试「试用」，或删掉它保持面板清爽。
				</p>
			)}
			{expanded && (
				<div className="md-prose mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-700 bg-slate-950/50 p-2 text-[12px]">
					{renderMarkdown(skill.content)}
				</div>
			)}
		</li>
	);
}

/**
 * Skill Hub 的一行（NERE-54）：摘要 + 展开后的审计报告 + 安装按钮。
 * 纯展示组件：数据由父级（SkillHubPanel）传入，安装动作只回调，不直接碰传输层。
 */

import {
	BLOCKED_HINT,
	SKILL_AUDIT_LABELS,
	SKILL_AUDIT_STYLES,
	canInstallHubEntry,
	hubEntryInstallUrl,
	isHubEntryUpdatable,
	runtimeLabel,
	sourceHost,
} from "../lib/skill-hub";
import type { SkillHubEntry } from "../types";
import { Icon } from "./Icon";

const CHIP = "rounded-full px-1.5 py-px text-[10px] leading-4";

function AuditBadge({ status }: { status: SkillHubEntry["audit"]["status"] }) {
	return <span className={`${CHIP} ${SKILL_AUDIT_STYLES[status]}`}>{SKILL_AUDIT_LABELS[status]}</span>;
}

/** 审计详情：reasons（message / evidence / rule）、detected（runtime / network / tools）、hash、来源。 */
function AuditDetail({ entry }: { entry: SkillHubEntry }) {
	const { audit } = entry;
	const hash = audit.hash || entry.contentHash;
	return (
		<dl className="space-y-1 rounded-md border border-slate-700/60 bg-slate-950/40 px-2 py-1.5 text-[11px] text-slate-400">
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">审计</dt>
				<dd className="flex min-w-0 flex-wrap items-center gap-1">
					<AuditBadge status={audit.status} />
					{audit.auditedAt && <span className="text-slate-500">{audit.auditedAt}</span>}
					{audit.rulesVersion !== undefined && <span className="text-slate-600">规则 v{audit.rulesVersion}</span>}
				</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">运行时</dt>
				<dd className="min-w-0 break-all">{runtimeLabel(audit.detected.runtime || entry.runtime)}</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">联网</dt>
				<dd className="min-w-0 break-all">{audit.detected.network.length > 0 ? audit.detected.network.join("、") : "未检测到联网"}</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">外部工具</dt>
				<dd className="min-w-0 break-all">{audit.detected.tools.length > 0 ? audit.detected.tools.join("、") : "无"}</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">来源</dt>
				<dd className="min-w-0 break-all">{entry.source || "未知"}</dd>
			</div>
			{entry.license && (
				<div className="flex gap-2">
					<dt className="w-16 shrink-0 text-slate-500">许可证</dt>
					<dd className="min-w-0 break-all">{entry.license}</dd>
				</div>
			)}
			{hash && (
				<div className="flex gap-2">
					<dt className="w-16 shrink-0 text-slate-500">哈希</dt>
					<dd className="min-w-0 break-all font-mono text-[10px] text-slate-500">{hash}</dd>
				</div>
			)}
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">审计原因</dt>
				<dd className="min-w-0">
					{audit.reasons.length > 0 ? (
						<ul className="list-disc space-y-0.5 pl-4">
							{audit.reasons.map((reason, index) => (
								<li key={`${index}-${reason.rule ?? ""}-${reason.message}`}>
									{reason.level && (
										<span className={`${CHIP} mr-1 align-middle ${SKILL_AUDIT_STYLES[reason.level]}`}>
											{SKILL_AUDIT_LABELS[reason.level]}
										</span>
									)}
									{reason.rule && <span className="mr-1 font-mono text-[10px] text-slate-500">[{reason.rule}]</span>}
									{reason.message}
									{reason.evidence && (
										<span className="mt-0.5 block break-all font-mono text-[10px] text-slate-600">
											依据：{reason.evidence}
										</span>
									)}
								</li>
							))}
						</ul>
					) : (
						<span className="text-emerald-300">未发现问题</span>
					)}
				</dd>
			</div>
		</dl>
	);
}

export function SkillHubRow({
	entry,
	expanded,
	installed,
	installing,
	onToggle,
	onInstall,
}: {
	entry: SkillHubEntry;
	expanded: boolean;
	installed: boolean;
	installing: boolean;
	onToggle: (name: string) => void;
	onInstall: (entry: SkillHubEntry) => void;
}) {
	const blocked = entry.audit.status === "blocked";
	const installUrl = hubEntryInstallUrl(entry);
	const installable = canInstallHubEntry(entry);
	const isInstalled = installed || entry.installed;
	const updatable = isHubEntryUpdatable(entry);
	const actionLabel = blocked ? "不可安装" : installing ? "安装中…" : updatable ? "更新" : isInstalled ? "重新安装" : "安装";

	return (
		<li className="rounded-lg bg-slate-800/50">
			<button
				type="button"
				onClick={() => onToggle(entry.name)}
				aria-expanded={expanded}
				className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-800/80"
			>
				<Icon name={expanded ? "chevronDown" : "chevronRight"} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate text-[13px] text-slate-100">{entry.name}</span>
						{entry.version && (
							<span className="shrink-0 text-[10px] tabular-nums text-slate-500">v{entry.version.replace(/^v/i, "")}</span>
						)}
						{updatable ? (
							<span className={`${CHIP} shrink-0 bg-amber-500/15 text-amber-300`}>可更新</span>
						) : (
							isInstalled && <span className={`${CHIP} shrink-0 bg-sky-500/15 text-sky-300`}>已安装</span>
						)}
					</span>
					<span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-slate-500">
						{entry.description || "（无描述）"}
					</span>
					<span className="mt-1 flex flex-wrap items-center gap-1">
						<AuditBadge status={entry.audit.status} />
						<span className={`${CHIP} bg-slate-700/70 text-slate-300`}>{runtimeLabel(entry.runtime)}</span>
						{entry.tags.slice(0, 3).map((tag) => (
							<span key={tag} className={`${CHIP} bg-slate-800 text-slate-400`}>
								{tag}
							</span>
						))}
						{entry.source && (
							<span title={entry.source} className="min-w-0 truncate text-[10px] text-slate-600">
								来源 {sourceHost(entry.source)}
							</span>
						)}
					</span>
				</span>
			</button>

			{expanded && (
				<div role="region" aria-label={`${entry.name} 的审计报告`} className="space-y-2 border-t border-slate-700/60 px-2.5 py-2">
					<AuditDetail entry={entry} />
					{blocked && (
						<p role="note" className="rounded-md border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200">
							{BLOCKED_HINT}
						</p>
					)}
					{!blocked && !installUrl && !isInstalled && (
						<p role="note" className="rounded-md border border-amber-500/30 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200">
							这条技能没有安装地址（source 不是 http(s) 链接），暂时无法从这里安装。
						</p>
					)}
					<button
						type="button"
						disabled={!installable || installing}
						onClick={() => {
							if (installable) onInstall(entry);
						}}
						aria-label={`${blocked ? "不可安装" : updatable ? "更新" : isInstalled ? "重新安装" : "安装"}技能 ${entry.name}`}
						className="w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{actionLabel}
					</button>
					{blocked && (
						<p className="text-[10px] leading-relaxed text-slate-500">
							审计结论为 blocked，安装不会发起请求；如果你认为误判，请让作者修正运行时或脚本后再上架。
						</p>
					)}
				</div>
			)}
		</li>
	);
}

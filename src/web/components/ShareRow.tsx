import { memo, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { formatExpiry, formatOpenedAt, shareUrlFor } from "../lib/format";
import { readTheme } from "../lib/theme";
import type { ShareRecord } from "../types";
import { Icon } from "./Icon";

/** 复制成功的文本反馈时长（NERE-43）。 */
const COPY_FEEDBACK_MS = 3_000;
/** 撤销二次确认的等待时长：2.5 秒无操作复原。 */
const REVOKE_CONFIRM_MS = 2_500;

const actionButton =
	"inline-flex items-center gap-1 rounded-md border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 分享清单的一行（NERE-43，L3）：纯展示 + onRevoke 回调。
 * 复制反馈与「确认撤销」是行内临时态，不持有清单数据。
 */
export const ShareRow = memo(function ShareRow({
	record,
	revoking,
	onRevoke,
}: {
	record: ShareRecord;
	revoking: boolean;
	onRevoke: (token: string) => void;
}) {
	const [copied, setCopied] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (copyTimer.current) clearTimeout(copyTimer.current);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		},
		[],
	);

	const copy = () => {
		void (async () => {
			// 链接归一化到当前 origin（不是 workers.dev），并带上当前主题。
			const url = shareUrlFor(record.url, window.location.origin, readTheme());
			if (!(await copyText(url))) return;
			setCopied(true);
			if (copyTimer.current) clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
		})();
	};

	const revoke = () => {
		if (revoking) return;
		if (!confirming) {
			setConfirming(true);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirming(false), REVOKE_CONFIRM_MS);
			return;
		}
		if (confirmTimer.current) clearTimeout(confirmTimer.current);
		setConfirming(false);
		onRevoke(record.token);
	};

	return (
		<li className="rounded-lg border border-slate-800/70 bg-slate-800/40 px-2.5 py-2">
			<div className="flex items-center gap-1.5">
				<span
					className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${
						record.kind === "file" ? "bg-sky-500/15 text-sky-300" : "bg-violet-500/15 text-violet-300"
					}`}
				>
					{record.kind === "file" ? "文件" : "会话"}
				</span>
				<span className="min-w-0 flex-1 truncate text-xs text-slate-200" title={record.name}>
					{record.name}
				</span>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-500">
				<span>{formatExpiry(record.expiresAt)}</span>
				<span aria-hidden>·</span>
				<span>打开 {record.openCount} 次</span>
				<span aria-hidden>·</span>
				<span>{formatOpenedAt(record.lastOpenedAt)}</span>
			</div>
			<div className="mt-1.5 flex items-center gap-1.5">
				<button type="button" onClick={copy} aria-label={`复制分享链接 ${record.name}`} className={actionButton}>
					<Icon name={copied ? "check" : "share"} className="h-3.5 w-3.5" />
					{copied ? "已复制" : "复制"}
				</button>
				<button
					type="button"
					onClick={revoke}
					disabled={revoking}
					aria-busy={revoking || undefined}
					aria-label={`撤销分享 ${record.name}`}
					className={`${actionButton} ${
						confirming ? "border-rose-500/50 text-rose-300 hover:bg-rose-950/40" : "hover:text-rose-300"
					}`}
				>
					<Icon name="trash" className="h-3.5 w-3.5" />
					{revoking ? "撤销中…" : confirming ? "确认撤销" : "撤销"}
				</button>
			</div>
		</li>
	);
});

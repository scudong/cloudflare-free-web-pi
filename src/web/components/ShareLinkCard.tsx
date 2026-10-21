import { useRef, useState } from "react";
import type { ShareLink } from "../types";
import { Icon } from "./Icon";

/** 分享链接卡（v0.55.0）：模型调用 share_file / share_conversation 后直接给出可复制的链接。 */
export function ShareLinkCard({ link }: { link: ShareLink }) {
	const [copied, setCopied] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const expired = link.expiresAt > 0 && link.expiresAt <= Date.now();
	const expiry = expired
		? "已过期"
		: link.expiresAt > 0
			? `有效期至 ${new Date(link.expiresAt).toLocaleString("zh-CN", { hour12: false })}`
			: "永久有效";

	const copy = () => {
		const write = async () => {
			try {
				await navigator.clipboard.writeText(link.url);
				setCopied(true);
				return;
			} catch {
				// 非安全上下文/无剪贴板权限：退回选中 + execCommand
			}
			inputRef.current?.select();
			try {
				document.execCommand("copy");
				setCopied(true);
			} catch {
				// 让用户手动复制
			}
		};
		void write();
	};

	return (
		<div className="w-full max-w-md rounded-xl border border-emerald-500/30 bg-emerald-950/30 px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Icon name="share" className="h-4 w-4 shrink-0 text-emerald-400" />
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-emerald-100" title={link.title}>
					{link.title}
				</span>
				{link.reused && (
					<span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">已有</span>
				)}
				<button
					type="button"
					onClick={copy}
					className="shrink-0 rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/15"
				>
					{copied ? "已复制" : "复制"}
				</button>
			</div>
			<div className="mt-2 flex gap-1.5">
				<input
					ref={inputRef}
					readOnly
					value={link.url}
					onFocus={(event) => event.currentTarget.select()}
					aria-label="分享链接"
					className="min-w-0 flex-1 rounded-md border border-emerald-500/20 bg-slate-950/60 px-2 py-1.5 text-[11px] text-emerald-100/90 outline-none focus:border-emerald-500/50"
				/>
				<a
					href={expired ? undefined : link.url}
					target="_blank"
					rel="noopener noreferrer"
					aria-disabled={expired}
					className={`shrink-0 rounded-md border border-emerald-500/30 px-2 py-1.5 text-[11px] text-emerald-200 transition-colors ${
						expired ? "pointer-events-none opacity-40" : "hover:bg-emerald-500/15"
					}`}
				>
					<Icon name="external" className="h-3.5 w-3.5" />
				</a>
			</div>
			<p className={`mt-1.5 text-[11px] ${expired ? "text-rose-300/90" : "text-emerald-200/60"}`}>
				{expiry}
				{!expired && <span className="text-emerald-200/40"> · 拿到链接的人无需登录即可查看</span>}
			</p>
		</div>
	);
}

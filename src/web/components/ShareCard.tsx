import { useState } from "react";
import { Icon } from "./Icon";
import type { ShareLinkInfo } from "../types";

/** 分享链接卡（v0.55.0）：标题 + 可点链接 + 复制按钮 + 有效期。 */
export function ShareCard({ share }: { share: ShareLinkInfo }) {
	const [copied, setCopied] = useState(false);

	const copy = () => {
		void (async () => {
			try {
				await navigator.clipboard.writeText(share.url);
				setCopied(true);
				return;
			} catch {
				// 非安全上下文/无剪贴板权限：退回临时输入框 + execCommand
			}
			try {
				const el = document.createElement("textarea");
				el.value = share.url;
				el.setAttribute("readonly", "");
				el.style.position = "fixed";
				el.style.opacity = "0";
				document.body.appendChild(el);
				el.select();
				document.execCommand("copy");
				el.remove();
				setCopied(true);
			} catch {
				// 让用户手动复制链接
			}
		})();
	};

	return (
		<div className="w-full rounded-xl border border-emerald-500/35 bg-emerald-950/40 px-3 py-2">
			<div className="flex items-start gap-2.5">
				<Icon name={share.kind === "file" ? "file" : "chat"} className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-medium text-slate-100" title={share.title}>
						{share.title}
					</div>
					<a
						href={share.url}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-0.5 block truncate text-[11px] text-emerald-300 underline-offset-2 hover:underline"
						title={share.url}
					>
						{share.url}
					</a>
					<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-emerald-200/70">
						<span className="rounded bg-emerald-500/15 px-1.5 py-0.5">
							{share.kind === "file" ? "文件分享" : "对话分享"}
						</span>
						<span>{share.expiresLabel}</span>
					</div>
				</div>
				<div className="flex shrink-0 flex-col gap-1">
					<button
						type="button"
						onClick={copy}
						className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500"
					>
						{copied ? "已复制" : "复制"}
					</button>
					<a
						href={share.url}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center justify-center gap-1 rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/10"
					>
						<Icon name="external" className="h-3 w-3" />
						打开
					</a>
				</div>
			</div>
		</div>
	);
}

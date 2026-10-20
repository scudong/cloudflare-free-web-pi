import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { shareUrlFor } from "../lib/format";

interface ShareDialogProps {
	sessionId: string;
	name: string;
	onClose: () => void;
}

/** 有效期选项（秒，0 = 永久）。 */
const TTL_OPTIONS = [
	{ label: "1 小时", seconds: 3600 },
	{ label: "1 天", seconds: 86400 },
	{ label: "7 天", seconds: 604800 },
	{ label: "30 天", seconds: 2592000 },
	{ label: "永久", seconds: 0 },
];

/** 文件分享弹窗（v0.38.0）：选有效期 → 生成带域名的公开只读链接 → 复制。 */
export function ShareDialog({ sessionId, name, onClose }: ShareDialogProps) {
	const [ttl, setTtl] = useState(604800);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<{ url: string; expiresAt: number } | null>(null);
	const [copied, setCopied] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const generate = () => {
		if (busy) return;
		setBusy(true);
		setError("");
		setCopied(false);
		void (async () => {
			try {
				const data = await api.shareFile(sessionId, name, ttl);
				if (!data.url) throw new Error(data.error || "生成分享链接失败");
				// 域名一律用当前页面：pages.dev 反代下服务端看到的是 workers.dev 地址
				const url = shareUrlFor(data.url, window.location.origin);
				setResult({ url, expiresAt: Number(data.expiresAt) || 0 });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		})();
	};

	const copy = () => {
		if (!result) return;
		void (async () => {
			try {
				await navigator.clipboard.writeText(result.url);
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
		})();
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button type="button" aria-label="关闭分享" onClick={onClose} className="dialog-scrim absolute inset-0" />
			<div
				role="dialog"
				aria-modal="true"
				aria-label={`分享 ${name}`}
				className="relative w-[min(92vw,26rem)] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
			>
				<div className="flex items-start justify-between gap-3 px-5 pt-4">
					<div className="min-w-0">
						<h2 className="text-sm font-semibold text-slate-100">分享文件</h2>
						<p className="mt-0.5 truncate text-xs text-slate-400" title={name}>
							{name}
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						✕
					</button>
				</div>

				<div className="px-5 pb-5 pt-3">
					<p className="text-[11px] text-slate-500">链接有效期</p>
					<div className="mt-1.5 flex flex-wrap gap-1.5">
						{TTL_OPTIONS.map((option) => (
							<button
								key={option.seconds}
								type="button"
								onClick={() => setTtl(option.seconds)}
								aria-pressed={ttl === option.seconds}
								className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
									ttl === option.seconds
										? "border-sky-500 bg-sky-500/20 text-sky-100"
										: "border-slate-700 text-slate-300 hover:bg-slate-800"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>

					<button
						type="button"
						onClick={generate}
						disabled={busy}
						className="mt-3 w-full rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
					>
						{busy ? "生成中…" : result ? "重新生成链接" : "生成分享链接"}
					</button>

					{error && <p className="mt-2 text-xs text-red-300">{error}</p>}

					{result && (
						<div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-950/30 p-2.5">
							<div className="flex gap-1.5">
								<input
									ref={inputRef}
									readOnly
									value={result.url}
									onFocus={(event) => event.currentTarget.select()}
									aria-label="分享链接"
									className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-500/50"
								/>
								<button
									type="button"
									onClick={copy}
									className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500"
								>
									{copied ? "已复制" : "复制"}
								</button>
							</div>
							<a
								href={result.url}
								target="_blank"
								rel="noopener noreferrer"
								className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-slate-600 px-2.5 py-1.5 text-[11px] text-slate-200 transition-colors hover:bg-slate-800"
							>
								在新窗口打开 ↗
							</a>
							<p className="mt-1.5 text-[11px] text-emerald-200/70">
								{result.expiresAt > 0
									? `有效期至 ${new Date(result.expiresAt).toLocaleString("zh-CN", { hour12: false })}`
									: "永久有效"}
								<span className="text-emerald-200/40"> · </span>
								拿到链接的人无需登录即可查看
							</p>
						</div>
					)}

					<p className="mt-3 text-[11px] leading-relaxed text-slate-500">
						分享页只读，内容随文件更新；链接泄露时可删除文件使其立即失效。
					</p>
				</div>
			</div>
		</div>
	);
}

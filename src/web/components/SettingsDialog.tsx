import { useEffect, useRef, type ReactNode } from "react";
import { formatTime } from "../lib/format";
import type { MemoryInfo } from "../types";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
	/** 当前是否浅色主题。 */
	light: boolean;
	onToggleTheme: () => void;
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
	/** 记忆库（v0.21.0 从工作台移入设置）。 */
	memories: MemoryInfo[];
	memoriesLoading: boolean;
	memoriesError: string | null;
	onDeleteMemory: (id: number) => Promise<boolean>;
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
			className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? "bg-sky-600" : "bg-slate-700"}`}
		>
			<span
				aria-hidden
				className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
			/>
		</button>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-b border-slate-800 py-4 first:pt-1 last:border-b-0 last:pb-0">
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
			{children}
		</section>
	);
}

const actionButton =
	"rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700/60 hover:text-white";

/** 设置弹窗（v0.20.0）：原顶栏菜单全部收纳于此，参照 Codex/Trae 的设置页。 */
export function SettingsDialog({
	open,
	onClose,
	light,
	onToggleTheme,
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
	memories,
	memoriesLoading,
	memoriesError,
	onDeleteMemory,
	authRequired,
	onLogout,
}: SettingsDialogProps) {
	const restoreRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;
	return (
		<div className="absolute inset-0 z-40">
			<button type="button" aria-label="关闭设置" onClick={onClose} className="absolute inset-0 bg-black/60" />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="设置"
				className="absolute left-1/2 top-1/2 max-h-[86vh] w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
			>
				<div className="mb-3 flex items-center justify-between">
					<h1 className="text-base font-semibold text-slate-100">设置</h1>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭"
						className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
							<path d="m5.5 5.5 9 9m0-9-9 9" strokeLinecap="round" />
						</svg>
					</button>
				</div>

				<Section title="外观">
					<div className="inline-flex rounded-lg border border-slate-700 p-0.5">
						<button
							type="button"
							onClick={() => light && onToggleTheme()}
							aria-pressed={!light}
							className={`rounded-md px-3 py-1.5 text-sm transition-colors ${!light ? "bg-sky-600 text-white" : "text-slate-300 hover:text-white"}`}
						>
							🌙 深色
						</button>
						<button
							type="button"
							onClick={() => !light && onToggleTheme()}
							aria-pressed={light}
							className={`rounded-md px-3 py-1.5 text-sm transition-colors ${light ? "bg-sky-600 text-white" : "text-slate-300 hover:text-white"}`}
						>
							☀️ 浅色
						</button>
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

				<Section title={`记忆库${memories.length ? `（${memories.length}）` : ""}`}>
					<div className="max-h-56 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-1.5">
						{memoriesError && <p className="px-1.5 py-1.5 text-xs text-rose-300">{memoriesError}</p>}
						{memoriesLoading && memories.length === 0 && <p className="px-1.5 py-1.5 text-xs text-slate-500">正在加载…</p>}
						{!memoriesLoading && !memoriesError && memories.length === 0 && (
							<p className="px-1.5 py-2 text-xs leading-relaxed text-slate-500">
								记忆库还是空的。对 π 说「记住…」即可保存一条长期记忆；每轮对话结束也会自动抽取。
							</p>
						)}
						<ul className="space-y-1">
							{memories.map((memory) => (
								<li key={memory.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
									<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-200">{memory.content}</p>
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

				<Section title="数据">
					<div className="grid grid-cols-2 gap-2">
						<button type="button" onClick={onShare} className={actionButton}>
							🔗 分享当前会话
						</button>
						<button type="button" onClick={onExport} className={actionButton}>
							📥 导出 Markdown
						</button>
						<button type="button" onClick={onBackup} className={actionButton}>
							💾 备份数据
						</button>
						<button type="button" onClick={() => restoreRef.current?.click()} className={actionButton}>
							♻️ 恢复备份
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
			</div>
		</div>
	);
}

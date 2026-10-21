import { useState } from "react";

/**
 * 未登录时的整屏登录闸门。
 *
 * demoUrl 有值时，在表单下方多给一个「看一个真实对话」入口：指向一条永久、只读的
 * 会话分享页（/s/<token>），不经过登录、不调用任何写接口。没有配置演示链接时
 * 不渲染这个入口，避免出现死链。
 */
export function LoginGate({
	onSubmit,
	error,
	demoUrl,
}: {
	onSubmit: (password: string) => Promise<void>;
	error: string | null;
	demoUrl?: string;
}) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex h-dvh items-center justify-center bg-slate-950 px-4">
			<div className="w-full max-w-sm">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!password.trim() || busy) return;
						setBusy(true);
						void onSubmit(password.trim()).finally(() => setBusy(false));
					}}
					className="rounded-2xl border border-slate-800 bg-slate-900/80 p-7 shadow-xl"
				>
					<h1 className="mb-1 text-lg font-semibold text-slate-100">π Harness</h1>
					<p className="mb-5 text-sm text-slate-400">请输入访问密码或邀请码</p>
					{error && <p className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
					<input
						type="text"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="访问密码或邀请码"
						aria-label="访问密码或邀请码"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						autoFocus
						className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500"
					/>
					<button
						type="submit"
						disabled={busy || !password.trim()}
						className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
					>
						{busy ? "验证中…" : "进入"}
					</button>
				</form>
				{demoUrl ? (
					<a
						href={demoUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 px-5 py-3.5 text-left transition-colors hover:border-sky-700 hover:bg-slate-900"
					>
						<span className="min-w-0">
							<span className="block text-sm font-medium text-slate-200">看一个真实对话</span>
							<span className="block text-xs text-slate-500">免登录 · 只读分享页</span>
						</span>
						<span aria-hidden="true" className="shrink-0 text-slate-500">
							→
						</span>
					</a>
				) : null}
			</div>
		</div>
	);
}

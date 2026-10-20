import { useCallback, useEffect, useState } from "react";
import { api, type UserInfo } from "../lib/api";
import { formatTime } from "../lib/format";
import { Icon } from "./Icon";

/** 用户管理（v0.43.0，仅主人可见）：生成邀请码，每个码对应一个独立空间。 */
export function UsersPanel({ onCollapse }: { onCollapse?: () => void }) {
	const [users, setUsers] = useState<UserInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [issued, setIssued] = useState<{ code: string; name: string } | null>(null);
	const [copied, setCopied] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await api.users();
			setUsers(Array.isArray(data.users) ? data.users : []);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载用户失败");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const create = () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setCopied(false);
		setIssued(null);
		void (async () => {
			try {
				const data = await api.addUser(name.trim());
				if (!data.user || !data.code) throw new Error(data.error || "生成邀请码失败");
				setIssued({ code: data.code, name: data.user.name || data.user.id });
				setName("");
				await load();
			} catch (err) {
				setError(err instanceof Error ? err.message : "生成邀请码失败");
			} finally {
				setBusy(false);
			}
		})();
	};

	const reset = (user: UserInfo) => {
		if (busy) return;
		if (!window.confirm(`为「${user.name || user.id}」重新生成邀请码？旧码会立即失效。`)) return;
		setBusy(true);
		setCopied(false);
		setIssued(null);
		void (async () => {
			try {
				const data = await api.resetUserCode(user.id);
				if (!data.code) throw new Error(data.error || "重置失败");
				setIssued({ code: data.code, name: user.name || user.id });
				await load();
			} catch (err) {
				setError(err instanceof Error ? err.message : "重置失败");
			} finally {
				setBusy(false);
			}
		})();
	};

	const remove = (user: UserInfo) => {
		if (!window.confirm(`删除用户「${user.name || user.id}」？对方会立即退出；空间数据保留但无法再登录。`)) return;
		void (async () => {
			try {
				await api.deleteUser(user.id);
				await load();
			} catch {
				setError("删除用户失败");
			}
		})();
	};

	const copy = () => {
		if (!issued) return;
		void (async () => {
			try {
				await navigator.clipboard.writeText(issued.code);
				setCopied(true);
			} catch {
				// 剪贴板不可用时让用户手动选中
			}
		})();
	};

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
				<span className="text-[12.5px] font-medium text-slate-300">用户</span>
				<span className="flex items-center gap-1.5">
					<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{users.length}</span>
					{onCollapse && (
						<button
							type="button"
							onClick={onCollapse}
							title="收起左栏"
							aria-label="收起左栏"
							className="inline-flex items-center justify-center rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
						>
							<Icon name="chevronsLeft" className="h-4 w-4" />
						</button>
					)}
				</span>
			</div>

			<div className="shrink-0 border-b border-slate-800/70 p-3">
				<p className="text-[11px] leading-relaxed text-slate-500">
					每个邀请码对应一个独立空间：对方只能看到自己的会话、文件与记忆，看不到你的。
				</p>
				<div className="mt-2 flex gap-1.5">
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="备注名（可选）"
						aria-label="用户备注名"
						className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
					/>
					<button
						type="button"
						onClick={create}
						disabled={busy}
						className="shrink-0 rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
					>
						{busy ? "生成中…" : "生成邀请码"}
					</button>
				</div>

				{issued && (
					<div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-950/40 p-2">
						<p className="text-[10px] text-emerald-200/70">
							{issued.name} 的邀请码（只显示这一次）
						</p>
						<div className="mt-1 flex gap-1.5">
							<code className="min-w-0 flex-1 select-all overflow-x-auto rounded bg-slate-950/60 px-2 py-1 font-mono text-[12px] tracking-wider text-emerald-100">
								{issued.code}
							</code>
							<button
								type="button"
								onClick={copy}
								className="shrink-0 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500"
							>
								{copied ? "已复制" : "复制"}
							</button>
						</div>
						<p className="mt-1 text-[10px] text-emerald-200/60">对方在登录页输入这串码即可。</p>
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{loading && users.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在加载…</p>}
				{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
				{!loading && users.length === 0 && !error && (
					<p className="px-1 py-2 text-xs text-slate-500">还没有邀请用户。生成一个码发给对方即可。</p>
				)}
				<ul className="space-y-1">
					{users.map((user) => (
						<li key={user.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
							<div className="flex items-center gap-2">
								<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700/70 text-slate-300">
									<Icon name="users" className="h-3.5 w-3.5" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] text-slate-100">{user.name || "未命名"}</span>
									<span className="block truncate font-mono text-[10px] text-slate-500">
										{user.id} · 尾号 {user.codeHint}
									</span>
								</span>
								<button
									type="button"
									onClick={() => reset(user)}
									title="重置邀请码"
									className="shrink-0 rounded px-1.5 py-1 text-[11px] text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-100"
								>
									重置
								</button>
								<button
									type="button"
									onClick={() => remove(user)}
									title="删除用户"
									aria-label={`删除用户 ${user.name || user.id}`}
									className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
								>
									<Icon name="trash" className="h-3.5 w-3.5" />
								</button>
							</div>
							<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-8 text-[10px] text-slate-500">
								<span>创建 {formatTime(user.createdAt)}</span>
								<span>最近登录 {user.lastUsedAt ? formatTime(user.lastUsedAt) : "从未"}</span>
							</div>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

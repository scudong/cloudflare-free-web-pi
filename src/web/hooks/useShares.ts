/**
 * useShares（NERE-43）：分享清单的唯一读取者。
 *
 * - 挂载时只发一次 `api.sharesAll()`；切换会话、panelTick 变化都不重取，只有 reload() 再发。
 * - 撤销是乐观更新：先移出清单，失败按原索引插回；404 视为成功，403 / 网络错误给行级文案。
 * - 不做轮询：打开次数是快照，刷新由面板头部的手动按钮触发。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { parseShareRecords } from "../lib/collections";
import type { ShareRecord } from "../types";

export interface SharesState {
	items: ShareRecord[];
	status: "idle" | "loading" | "ready" | "error";
	/** 整体加载失败文案（面板级）。 */
	error: string | null;
	/** 行级动作反馈：撤销失败时给具体原因。 */
	actionError: string | null;
	/** 正在撤销的 token，用于禁用按钮 + aria-busy。 */
	revoking: ReadonlySet<string>;
	reload: () => void;
	revoke: (token: string) => Promise<void>;
	/** 关掉行级错误提示（面板上的 ×）。 */
	clearActionError: () => void;
}

/** 撤销失败文案：403 单独给权限提示，其余带上传输层原因。 */
export function revokeErrorMessage(err: unknown): string {
	if (err instanceof ApiError && err.status === 403) return "没有权限撤销这条链接（可能不属于当前账号）";
	const detail = err instanceof Error && err.message ? err.message : "未知错误";
	return `撤销失败：${detail}`;
}

/** 404 说明链接本来就不在了，按成功处理。 */
export function isAlreadyRevoked(err: unknown): boolean {
	return err instanceof ApiError && err.status === 404;
}

/** 按原索引插回一行（撤销失败回滚）：索引越界时落在末尾。 */
export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
	return [...list.slice(0, index), item, ...list.slice(index)];
}

export function useShares(): SharesState {
	const [items, setItemsState] = useState<ShareRecord[]>([]);
	const [status, setStatus] = useState<SharesState["status"]>("idle");
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set());
	/** items 的同步副本：撤销回滚要按原索引插回，等不到下一帧 state。 */
	const itemsRef = useRef<ShareRecord[]>([]);
	/** 请求序号：只有最后一次请求能落地。 */
	const requestRef = useRef(0);
	/** StrictMode 会把 effect 跑两遍：同一挂载周期只允许首发一次请求。 */
	const startedRef = useRef(false);

	const commit = useCallback((next: ShareRecord[]) => {
		itemsRef.current = next;
		setItemsState(next);
	}, []);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		setStatus("loading");
		setError(null);
		try {
			const records = parseShareRecords(await api.sharesAll());
			if (request !== requestRef.current) return;
			commit(records);
			setStatus("ready");
		} catch (err) {
			if (request !== requestRef.current) return;
			setError(err instanceof Error && err.message ? err.message : "未知错误");
			setStatus("error");
		}
	}, [commit]);

	const reload = useCallback(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		void load();
	}, [load]);

	const revoke = useCallback(
		async (token: string) => {
			const index = itemsRef.current.findIndex((item) => item.token === token);
			if (index < 0) return;
			const removed = itemsRef.current[index]!;
			setActionError(null);
			commit([...itemsRef.current.slice(0, index), ...itemsRef.current.slice(index + 1)]);
			setRevoking((prev) => new Set(prev).add(token));
			try {
				await api.revokeShare(token);
			} catch (err) {
				if (isAlreadyRevoked(err)) return;
				if (!itemsRef.current.some((item) => item.token === token)) {
					commit(insertAt(itemsRef.current, index, removed));
				}
				setActionError(revokeErrorMessage(err));
			} finally {
				setRevoking((prev) => {
					const next = new Set(prev);
					next.delete(token);
					return next;
				});
			}
		},
		[commit],
	);

	const clearActionError = useCallback(() => setActionError(null), []);

	return { items, status, error, actionError, revoking, reload, revoke, clearActionError };
}

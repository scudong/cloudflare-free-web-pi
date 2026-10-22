/**
 * useShares（NERE-43）：分享清单的唯一读取者。
 *
 * - 挂载时只发一次 `api.sharesAll()`；切换会话、panelTick 变化都不重取，只有 reload() 再发。
 * - 撤销是乐观更新：先移出清单，失败按原索引插回；404 视为成功，403 / 网络错误给行级文案。
 * - 不做轮询：打开次数是快照，刷新由面板头部的手动按钮触发。
 * - 能力门禁（NERE-56）：useSharesAvailable 探测 `/api/shares/all`，失败即视为未上线，入口不渲染。
 * - 未读信号（NERE-74）：App 改用 useSharesSnapshot，同一次请求兼做能力探测与未读计算。
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

/**
 * 分享能力探测（NERE-56）：`/api/shares/all` 成功（含空清单）才算已上线。
 * 404 / 非 JSON / 网络错误一律返回 false —— 这类失败是「能力还没发布」，不是清单加载失败，
 * 不能走到面板的 error 态文案。
 */
export async function probeSharesAvailability(load: () => Promise<unknown> = () => api.sharesAll()): Promise<boolean> {
	try {
		await load();
		return true;
	} catch {
		return false;
	}
}

/**
 * 分享入口的能力门禁（NERE-56）：只探测一次，结果落地前保持 false（入口不渲染）。
 * enabled 用来等登录态确定后再发请求；StrictMode 重跑 effect 也复用同一次探测。
 */
export function useSharesAvailable(enabled: boolean): boolean {
	const [available, setAvailable] = useState(false);
	/** 探测 promise：同一挂载周期只发一次请求。 */
	const probeRef = useRef<Promise<boolean> | null>(null);

	useEffect(() => {
		if (!enabled) return;
		let live = true;
		probeRef.current ??= probeSharesAvailability();
		void probeRef.current.then((ok) => {
			if (live) setAvailable(ok);
		});
		return () => {
			live = false;
		};
	}, [enabled]);

	return available;
}

/** 分享清单快照（NERE-74）：Rail 未读圆点用的轻量读数，面板本身仍走 useShares。 */
export interface SharesSnapshot {
	/** NERE-56 能力门禁：`/api/shares/all` 成功过就是 true，之后失败也不收回。 */
	available: boolean;
	/** 最近一次成功拉到的清单；失败时保留上一份。 */
	items: ShareRecord[];
	/** 是否至少成功拉取过一次：未就绪时不做未读水位种子，避免把历史当成新打开。 */
	ready: boolean;
}

/**
 * 分享清单快照（NERE-74）：一次请求同时充当 NERE-56 的能力探测，省掉启动时的重复调用。
 *
 * - 登录态确定后拉一次；
 * - 切回标签页 / 窗口重新聚焦时再拉一次 —— 无痕窗口里打开自己的分享后，
 *   回到应用就能立刻看到新的未读（也是「下次切回标签时刷新」的落点）；
 * - 后续拉取失败不清空上一份，入口也不会因为一次网络错误消失。
 */
export function useSharesSnapshot(enabled: boolean): SharesSnapshot {
	const [state, setState] = useState<SharesSnapshot>({ available: false, items: [], ready: false });
	/** 请求序号：只有最后一次请求能落地。 */
	const requestRef = useRef(0);
	/** StrictMode 会把 effect 跑两遍：同一登录周期只允许首发一次。 */
	const startedRef = useRef(false);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		try {
			const records = parseShareRecords(await api.sharesAll());
			if (request !== requestRef.current) return;
			setState({ available: true, items: records, ready: true });
		} catch {
			if (request !== requestRef.current) return;
			// 第一次失败 = 接口未上线（入口不渲染）；之后的失败保留上一份数据。
			setState((prev) => (prev.available ? prev : { ...prev, ready: false }));
		}
	}, []);

	useEffect(() => {
		if (!enabled) {
			startedRef.current = false;
			return;
		}
		if (!startedRef.current) {
			startedRef.current = true;
			void load();
		}
		const onVisible = () => {
			if (document.visibilityState === "visible") void load();
		};
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onVisible);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
		};
	}, [enabled, load]);

	return state;
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

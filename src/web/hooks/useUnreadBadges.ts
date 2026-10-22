/**
 * useUnreadBadges（NERE-74）：Rail 上分享 / 定时两个入口的未读圆点。
 *
 * 水位存 localStorage（见 lib/unread.ts 的判定规则），这里只做三件事：
 * - 数据到手时种子化 / 推进水位（面板打开时 force=true，「看过即清零」）；
 * - 面板自己拉到新数据时经 `observeShares` 推进，避免水位落后于面板；
 * - 监听 `storage` 事件，另一个标签页点了面板，本标签页的圆点同步消失。
 *
 * 取数不在这里做：分享清单由 useSharesSnapshot 负责（切回标签页会重拉），
 * 定时任务沿用 bootstrap 的数据（App 在切回标签页时用 panelTick 触发刷新）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	automationWatermark,
	browserUnreadStorage,
	countUnreadAutomations,
	countUnreadShares,
	nextWatermark,
	readWatermarks,
	shareWatermark,
	unreadKey,
	writeWatermark,
	type UnreadKind,
	type UnreadWatermarks,
} from "../lib/unread";
import type { AutomationInfo, ShareRecord } from "../types";

/** 一路未读信号：`ready` = 数据至少成功落地过一次（未就绪时不做种子，避免把历史当新消息）。 */
export interface UnreadSignal<T> {
	ready: boolean;
	items: readonly T[];
	/** 对应面板当前是否打开：打开时推进水位并清零。 */
	active: boolean;
}

export interface UnreadBadgesInput {
	/** 用户作用域前缀，见 lib/unread.unreadScope。 */
	scope: string;
	shares: UnreadSignal<ShareRecord>;
	automations: UnreadSignal<AutomationInfo>;
}

export interface UnreadBadges {
	shares: number;
	automations: number;
	/** 分享面板拉到数据后回调：把水位推进到这批记录（面板打开时的刷新也用）。 */
	observeShares: (items: readonly ShareRecord[]) => void;
}

export function useUnreadBadges({ scope, shares, automations }: UnreadBadgesInput): UnreadBadges {
	const storage = useMemo(browserUnreadStorage, []);
	const keys = useMemo(
		() => ({ shares: unreadKey("shares", scope), automations: unreadKey("automations", scope) }),
		[scope],
	);
	const [watermarks, setWatermarks] = useState<UnreadWatermarks>(() => readWatermarks(storage, scope));
	/** 同一帧内可能连续推进两次（数据落地 + 面板回调），用 ref 拿最新值。 */
	const watermarksRef = useRef(watermarks);
	watermarksRef.current = watermarks;
	/** 只在水位所属用户作用域变化时重读，首次挂载不重复读。 */
	const scopeRef = useRef(scope);

	useEffect(() => {
		if (scopeRef.current === scope) return;
		scopeRef.current = scope;
		setWatermarks(readWatermarks(storage, scope));
	}, [storage, scope]);

	/**
	 * 推进水位：没有水位时用当前最大值做种子；有水位时只在 `force`（面板开着）且更大时前移。
	 */
	const advance = useCallback(
		(kind: UnreadKind, latest: number, force: boolean) => {
			const current = watermarksRef.current[kind];
			const next = nextWatermark(current, latest);
			if (next == null || (current != null && !force)) return;
			writeWatermark(storage, keys[kind], next);
			const updated = { ...watermarksRef.current, [kind]: next };
			watermarksRef.current = updated;
			setWatermarks(updated);
		},
		[storage, keys],
	);

	useEffect(() => {
		if (!shares.ready) return;
		advance("shares", shareWatermark(shares.items), shares.active);
	}, [advance, shares.ready, shares.items, shares.active]);

	useEffect(() => {
		if (!automations.ready) return;
		advance("automations", automationWatermark(automations.items), automations.active);
	}, [advance, automations.ready, automations.items, automations.active]);

	const observeShares = useCallback(
		(items: readonly ShareRecord[]) => {
			advance("shares", shareWatermark(items), true);
		},
		[advance],
	);

	// 多标签页：另一个标签页打开面板写了水位 → 本页同步清零（storage 事件只在其它标签页触发）。
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onStorage = (event: StorageEvent) => {
			if (event.key !== null && event.key !== keys.shares && event.key !== keys.automations) return;
			const synced = readWatermarks(storage, scope);
			watermarksRef.current = synced;
			setWatermarks(synced);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [storage, scope, keys]);

	return {
		// 面板正开着就不再显示圆点：水位推进是下一帧的事，这里先直接归零。
		shares: shares.active ? 0 : countUnreadShares(shares.items, watermarks.shares),
		automations: automations.active ? 0 : countUnreadAutomations(automations.items, watermarks.automations),
		observeShares,
	};
}

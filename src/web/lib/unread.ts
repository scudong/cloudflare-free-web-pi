/**
 * 未读水位（NERE-74）：分享被打开 / 定时任务跑完之后，Rail 图标上的圆点提醒。
 *
 * 判定只比较「服务端时间戳」与「上次看过的水位」：
 * - 分享看 `lastOpenedAt`，定时任务看 `lastRunAt`；
 * - 严格大于水位才算未读 —— 同一个分享再被打开一次也能提示；
 * - 没有水位（这台浏览器第一次用）时用当前数据的最大值做种子，不补报历史，
 *   避免一上线就常驻一个点不掉的假红点；
 * - 打开面板即把水位推进到当前最大值并落盘，刷新后不再出现。
 *
 * 所有读写都走注入的 storage，测试用假存储 / 假时间戳即可，不依赖真实 localStorage。
 */

import type { AutomationInfo, ShareRecord } from "../types";

export type UnreadKind = "shares" | "automations";

/** localStorage 的最小读写子集：注入 fake 即可测，私密模式下传 null。 */
export interface UnreadStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** 存储键前缀：`pi-unread:<用户作用域>:<类型>`。 */
export const UNREAD_KEY_PREFIX = "pi-unread";

/**
 * 用户作用域（NERE-74）：`/api/auth` 只回 owner 布尔、不暴露用户 id，且本单只动前端，
 * 所以先按「主人 / 邀请用户」区分。后端将来回 userId 时只改 App 里取 scope 的那一行。
 */
export function unreadScope(isOwner: boolean | undefined): string {
	return isOwner ? "owner" : "member";
}

export function unreadKey(kind: UnreadKind, scope: string): string {
	return `${UNREAD_KEY_PREFIX}:${scope || "local"}:${kind}`;
}

/** 读水位：缺失 / 空串 / 非数字 / 存储不可用 → null（= 从未看过，调用方做种子）。 */
export function readWatermark(storage: UnreadStorage | null | undefined, key: string): number | null {
	try {
		const raw = storage?.getItem(key);
		if (raw == null || raw === "") return null;
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/** 写水位：私密模式 / 存储被禁用时静默失败（本次会话内仍然按内存态生效）。 */
export function writeWatermark(storage: UnreadStorage | null | undefined, key: string, value: number): void {
	try {
		storage?.setItem(key, String(value));
	} catch {
		// storage unavailable — 未读只在本次会话内生效
	}
}

/** 一个用户作用域下的两路水位；null = 从未看过。 */
export interface UnreadWatermarks {
	shares: number | null;
	automations: number | null;
}

/** 一次读出两路水位（挂载 / 换账号 / 其它标签页写水位后同步）。 */
export function readWatermarks(storage: UnreadStorage | null | undefined, scope: string): UnreadWatermarks {
	return {
		shares: readWatermark(storage, unreadKey("shares", scope)),
		automations: readWatermark(storage, unreadKey("automations", scope)),
	};
}

/** 浏览器 localStorage；访问被拒（隐私模式 / 无 window）时返回 null。 */
export function browserUnreadStorage(): UnreadStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** 分享侧的最新时间戳 = 所有记录里最大的 `lastOpenedAt`（从未打开为 0）。 */
export function shareWatermark(items: readonly ShareRecord[]): number {
	let latest = 0;
	for (const item of items) {
		if (Number.isFinite(item.lastOpenedAt) && item.lastOpenedAt > latest) latest = item.lastOpenedAt;
	}
	return latest;
}

/** 定时任务侧的最新时间戳 = 所有任务里最大的 `lastRunAt`（从未运行为 0）。 */
export function automationWatermark(items: readonly AutomationInfo[]): number {
	let latest = 0;
	for (const item of items) {
		if (typeof item.lastRunAt === "number" && Number.isFinite(item.lastRunAt) && item.lastRunAt > latest) latest = item.lastRunAt;
	}
	return latest;
}

/**
 * 推进水位：没有水位时先用当前最大值做种子；有水位时只增不减。
 * 返回 null 表示「这次不需要写」。
 */
export function nextWatermark(current: number | null, latest: number): number | null {
	if (current == null) return latest;
	return latest > current ? latest : null;
}

/** 未读分享条数：`lastOpenedAt` 严格大于水位。水位未知时返回 0（先种子，不补报历史）。 */
export function countUnreadShares(items: readonly ShareRecord[], watermark: number | null): number {
	if (watermark == null) return 0;
	return items.filter((item) => Number.isFinite(item.lastOpenedAt) && item.lastOpenedAt > watermark).length;
}

/** 未读定时任务条数：`lastRunAt` 严格大于水位。 */
export function countUnreadAutomations(items: readonly AutomationInfo[], watermark: number | null): number {
	if (watermark == null) return 0;
	return items.filter((item) => typeof item.lastRunAt === "number" && Number.isFinite(item.lastRunAt) && item.lastRunAt > watermark)
		.length;
}

/**
 * 已安装技能的「上次使用」口径（NERE-59）。
 *
 * 数据来自 NERE-55 的 `skill_events`：`GET /skills` 每条带 `lastInvokedAt`（epoch ms）。
 * 三态必须区分：
 * - `undefined`：服务端没有这个字段 = 没有埋点数据 → 整行不渲染（不显示 0、不显示「从未」）；
 * - `null`：字段存在但没记录 = 装了但从没调用过 → 显示「从未」；
 * - 数字：显示相对时间。
 *
 * 纯函数，时间由调用方传入，便于单测。
 */

import type { SkillInfo } from "../types";

/** 「从未使用」超过这个天数就提示可以删掉。 */
export const NEVER_TRIED_DAYS = 7;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 运行时徽标的短标签：卡片窄，沿用 issue 里的「提示词 / JS / TS」写法。 */
export function skillRuntimeLabel(runtime: string | undefined): string | null {
	const key = (runtime ?? "").trim().toLowerCase();
	if (!key) return null;
	if (key === "prompt") return "提示词";
	if (key === "javascript" || key === "js") return "JS";
	if (key === "typescript" || key === "ts") return "TS";
	return runtime!.trim();
}

/**
 * 上次使用文案：`刚刚 / N 分钟前 / N 小时前 / N 天前 / 从未`。
 * 返回 `null` 表示「没有埋点数据」，调用方据此整行不渲染。
 */
export function lastUsedLabel(lastInvokedAt: number | null | undefined, now = Date.now()): string | null {
	if (lastInvokedAt === undefined) return null;
	if (lastInvokedAt === null) return "从未";
	if (!Number.isFinite(lastInvokedAt)) return null;
	const delta = now - lastInvokedAt;
	if (delta < MINUTE) return "刚刚";
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
	return `${Math.floor(delta / DAY)} 天前`;
}

/** 从未使用且已安装满 7 天：底部灰字提示「试试试用，或删掉」。 */
export function shouldSuggestRemoval(
	skill: Pick<SkillInfo, "lastInvokedAt" | "createdAt">,
	now = Date.now(),
): boolean {
	if (skill.lastInvokedAt !== null) return false;
	const installedAt = Date.parse(skill.createdAt ?? "");
	if (!Number.isFinite(installedAt)) return false;
	return now - installedAt >= NEVER_TRIED_DAYS * DAY;
}

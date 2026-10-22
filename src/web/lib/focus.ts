/**
 * 焦点工具（NERE-62）：可聚焦元素选择器与索引推进。
 *
 * 纯函数放这里是为了单测（`tests/unit/modal.test.tsx`），DOM 焦点行为本身靠手动走查。
 */

/** 与契约 §4.3 一致：排除 disabled 与 tabindex="-1"。 */
export const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type FocusDirection = 1 | -1;

/**
 * Tab（+1）/ Shift+Tab（-1）在一个循环圈里的下一个索引。
 * - count = 0：没有可聚焦元素，返回 -1（调用方不要调 focus）。
 * - index 不在圈内（-1）：+1 落到第一个，-1 落到最后一个。
 * - 只有一个元素时两个方向都停在 0。
 */
export function nextFocusIndex(direction: FocusDirection, index: number, count: number): number {
	if (count <= 0) return -1;
	if (index < 0 || index >= count) return direction > 0 ? 0 : count - 1;
	return (index + direction + count) % count;
}

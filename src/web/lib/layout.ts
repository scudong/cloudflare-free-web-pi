/** 左栏展开偏好（桌面端）。值用 saveBool 的 "1" / "0" 编码。 */
export const LEFT_OPEN_KEY = "pi-harness.left-open";

/**
 * 点 Rail 的左栏内容入口（NERE-75 P1-3）。
 *
 * 桌面端：收起状态下点「定时 / 文件 / 分享」这些内容入口，说明用户想看左栏，
 * 必须同时把 leftOpen 置 true 并写回偏好，否则点了没有任何反馈。
 * 移动端：Rail 不渲染，直接忽略。
 */
export function selectRailView(
	isDesktop: boolean,
	openLeft: (open: boolean) => void,
	save: (key: string, value: boolean) => void,
): void {
	if (!isDesktop) return;
	openLeft(true);
	save(LEFT_OPEN_KEY, true);
}

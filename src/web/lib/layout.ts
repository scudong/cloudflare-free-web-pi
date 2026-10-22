import type { RailView } from "../components/Rail";

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

/**
 * 生效的左栏视图（NERE-81）：邀请用户看不到「用户」面板，分享接口未上线时「分享」也不成立，
 * 两种情况都回落到会话列表。Rail、未读圆点与左栏宽度都必须读这个值，而不是 `railView`。
 */
export function effectiveRailView(
	view: RailView,
	options: { owner: boolean; sharesAvailable: boolean },
): RailView {
	if (view === "users" && !options.owner) return "sessions";
	if (view === "shares" && !options.sharesAvailable) return "sessions";
	return view;
}

/** 左栏宽度（NERE-81）：会话列表按用户拖拽值；其它面板内容更宽，至少 300px。 */
export function leftPaneWidth(view: RailView, width: number): number {
	return view === "sessions" ? width : Math.max(width, 300);
}

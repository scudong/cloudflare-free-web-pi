import type { RailPanel } from "../components/Rail";
import type { KbFocus } from "../types";

/**
 * 互斥弹窗状态（NERE-62）+ 知识库定位请求（NERE-41）。
 *
 * 定位请求的生命周期必须严格绑定在「这一次打开」上：ModalShell 在关闭时直接返回 null，
 * 知识库面板会卸载，但 App 里的 kbFocus 不会自己消失；重开时组件重新挂载、effect 拿到
 * 同一个旧 nonce，就会把上一次的文档再打开一遍（NERE-75 P1-1）。
 */
export interface PanelState {
	active: RailPanel | null;
	/** 待消费的定位请求；null = 没有。 */
	kbFocus: KbFocus | null;
}

export const PANEL_IDLE: PanelState = { active: null, kbFocus: null };

export type PanelEvent =
	/** 点 Rail 弹窗入口：同一个入口再点一次 = 关闭。 */
	| { type: "toggle"; panel: RailPanel }
	/** Esc / 关闭按钮 / 打开别的弹窗。 */
	| { type: "close" }
	/** 打开设置弹窗（与面板弹窗互斥）。 */
	| { type: "settings" }
	/** 从消息里的参考资料跳进知识库。 */
	| { type: "kb-ref"; focus: KbFocus }
	/** 知识库面板已经按定位请求打开过文档：消费掉，避免重放。 */
	| { type: "kb-focus-consumed" };

/**
 * 弹窗状态机：任何打开 / 关闭都会丢弃未消费的定位；只有 `kb-ref` 会写入定位。
 * 因此「点参考资料 A → Esc → 点 Rail 知识库」只会停在列表，而不是又打开文档 A。
 */
export function reducePanel(state: PanelState, event: PanelEvent): PanelState {
	switch (event.type) {
		case "toggle":
			return { active: state.active === event.panel ? null : event.panel, kbFocus: null };
		case "close":
		case "settings":
			return PANEL_IDLE;
		case "kb-ref":
			return { active: "kb", kbFocus: event.focus };
		case "kb-focus-consumed":
			return state.kbFocus === null ? state : { ...state, kbFocus: null };
	}
}

/**
 * useBootstrap（NERE-26）：首屏聚合的唯一读取者。
 *
 * 按 ADR-0002 的目标分层，hooks 层拥有一个服务端资源的「读 / 写 / 刷新」：
 * - 只在这里调用 `api.bootstrap()`，页面层拿到的是领域模型 + 面板错误；
 * - `sessionId` 变化自动重取；`refreshKey`（面板刷新 / 重试 / 模型变更）变化也重取；
 * - 同一时刻只有最后一次请求能落地，会话切换时旧响应不会覆盖新会话；
 * - 整体请求失败时保留同一会话的上一份数据，只有跨会话才清空。
 */

import { useEffect, useRef, useState } from "react";
import { api, type BootstrapKey } from "../lib/api";
import { parseBootstrap, type BootstrapPanels } from "../lib/bootstrap";

export interface BootstrapState {
	/** `data` 所属的会话；请求失败或切换会话后、新数据到达前保持旧值。 */
	dataSessionId: string | null;
	data: BootstrapPanels | null;
	/** 后端返回的逐面板失败摘要（键为面板名）。 */
	errors: Partial<Record<BootstrapKey, string>>;
	loading: boolean;
	/** 整体请求失败（网络 / 401 / 5xx）；与逐面板错误分开处理。 */
	error: string | null;
}

const INITIAL_STATE: BootstrapState = {
	dataSessionId: null,
	data: null,
	errors: {},
	loading: true,
	error: null,
};

export function useBootstrap(sessionId: string, refreshKey: string | number = ""): BootstrapState {
	const [state, setState] = useState<BootstrapState>(INITIAL_STATE);
	/** 请求序号：只有最后一次发出的请求可以落地。 */
	const requestRef = useRef(0);

	useEffect(() => {
		const request = ++requestRef.current;
		let alive = true;
		setState((prev) => (prev.loading ? prev : { ...prev, loading: true }));
		void (async () => {
			try {
				const raw = await api.bootstrap(sessionId);
				if (!alive || request !== requestRef.current) return;
				const data = parseBootstrap(raw);
				setState({ dataSessionId: sessionId, data, errors: data.errors, loading: false, error: null });
			} catch (err) {
				if (!alive || request !== requestRef.current) return;
				const detail = err instanceof Error ? err.message : String(err);
				setState((prev) => ({
					...prev,
					// 同一会话的刷新失败保留上一份数据；跨会话失败则清空，避免展示别的会话。
					data: prev.dataSessionId === sessionId ? prev.data : null,
					errors: {},
					loading: false,
					error: detail,
				}));
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, refreshKey]);

	return state;
}

/**
 * Route ↔ DO 组合根之间的端口（ADR-0001 §9.2「端口增长规则」）。
 * http 层只依赖这里的形状；Service 向下依赖端口，避免 http → services → http 的环。
 */

/** `app_settings` 读取端口（阶段 2 的 KbSettings 同形，阶段 6 统一收口）。 */
export type SettingsPort = { get(key: string, fallback: string): string };

/** 邀请用户 id 形如 u_ab12cd34；新分享 token 以 `<userId>.` 前缀路由到该用户的 DO。 */
export const USER_ID_RE = /^u_[a-z0-9]{6,16}$/;

/** 用户分享 token 前缀；主人（owner）不加前缀，保持旧链接形态。 */
export function shareTokenPrefix(userKey: string): string {
	return USER_ID_RE.test(userKey) ? `${userKey}.` : "";
}

/**
 * 分享域的 Harness 端口（阶段 3）：由 DO 组合根实现。
 * 只有确实要读会话条目时才会 open()；文件分享、失效/过期 token 不碰它。
 */
export type ShareRuntime = {
	/** 会话 id 解析（缺省回落根会话）；POST /share 与 GET /shares 用它取真实会话 id。 */
	conversationId(sessionId?: string): Promise<string>;
	/** 会话条目；会话不存在时返回空数组（与旧 renderShare 一致）。 */
	entries(sessionId: string): Promise<readonly unknown[]>;
};

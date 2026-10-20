import type { SessionListItem } from "../types";

export interface SessionTreeNode {
	session: SessionListItem;
	/** 0 = 顶层会话；>0 = 分支层级 */
	depth: number;
}

/**
 * 把扁平会话列表按分支关系排成树（v0.32.0）。
 * - 父会话不存在（已删除 / 被过滤）的分支按顶层处理
 * - 父链成环时也不会死循环：每个会话只输出一次
 * - 同层保持输入顺序（后端按 updated_at 倒序）
 */
export function flattenSessions(sessions: SessionListItem[]): SessionTreeNode[] {
	const ids = new Set(sessions.map((s) => s.id));
	const children = new Map<string, SessionListItem[]>();
	const roots: SessionListItem[] = [];

	for (const session of sessions) {
		const parent = session.parentId && ids.has(session.parentId) && session.parentId !== session.id ? session.parentId : null;
		if (!parent) {
			roots.push(session);
			continue;
		}
		const list = children.get(parent) ?? [];
		list.push(session);
		children.set(parent, list);
	}

	const out: SessionTreeNode[] = [];
	const seen = new Set<string>();
	const walk = (session: SessionListItem, depth: number) => {
		if (seen.has(session.id)) return;
		seen.add(session.id);
		out.push({ session, depth });
		for (const child of children.get(session.id) ?? []) walk(child, depth + 1);
	};

	for (const root of roots) walk(root, 0);
	// 防御：父链成环导致没人被当作根时，剩余项按顶层补上
	for (const session of sessions) if (!seen.has(session.id)) walk(session, 0);
	return out;
}

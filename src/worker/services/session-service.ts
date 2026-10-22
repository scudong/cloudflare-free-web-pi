import type { SqlHandle } from "../db/migrations";
import type { KbRef } from "../lib/kb";
import {
	getMany as getEntryKbRefs,
	removeConversation as removeEntryKbRefs,
	upsert as upsertEntryKbRefs,
} from "../repo/entry-kb-refs-repo";
import { get, insertFork, insertIfAbsent, listKnownIds, listVisible, markDeleted, rename } from "../repo/sessions-repo";
import type { SessionMetaRow } from "../repo/sessions-repo";
import { removeSession as removeSessionFiles } from "../repo/files-repo";

/**
 * 会话域用例（ADR-0001 §2）：`sessions_meta` 与 Harness 的唯一协调点。
 *
 * Harness 的 open/重试/模型与扩展配置留在 DO 组合根，通过 `runtime` 端口注入；
 * Service 只负责元数据读写、标题策略与删除编排，逻辑与旧 `worker.ts` 方法逐字一致。
 */
export type SessionRuntime = {
	/** 会话 id 与实际条目；Service 用它合并 entry 旁路元数据（NERE-40）。 */
	entries(sessionId?: string): Promise<{ conversationId: string; items: readonly unknown[] }>;
	createConversation(): Promise<string>;
	/** 在 `entryId` 之前分叉，返回新会话 id、父会话 id 与实际分叉点。 */
	forkBefore(sessionId: string, entryId: number): Promise<{ id: string; parentId: string; at: number }>;
	rootId(): Promise<string>;
	scanConversationIds(): Promise<readonly string[]>;
	modelFor(sessionId?: string): string;
	/** 目标随会话停止（goals 域由 DO 的既有 helper 实现）。 */
	pauseGoal(sessionId: string): void;
};

export type SessionServiceDeps = {
	sql: SqlHandle;
	runtime: SessionRuntime;
};

export type SessionList = {
	sessions: {
		id: string;
		title: string;
		created_at: string;
		updated_at: string;
		model?: string;
		parent_id?: string | null;
		fork_at?: number | null;
	}[];
};

export interface SessionService {
	/** 元数据表为准，存储里存在但元数据缺失的会话补齐（已删除/隐藏的不复活）。 */
	list(): Promise<SessionList>;
	create(): Promise<{ id: string; title: string }>;
	fork(sessionId: string, entryId: number, title?: string): Promise<{ id: string; title: string }>;
	rename(id: string, title: string): void;
	/** 删除仍是非级联：标记 deleted、删该会话文件、暂停目标；shares/plans 等不动（R10）。 */
	remove(id: string): void;
	entries(sessionId?: string): Promise<readonly unknown[]>;
	/** 记下一条 assistant entry 本轮注入的知识库命中（NERE-40）；空命中不写。 */
	saveEntryKbRefs(conversationId: string, entryId: number, refs: readonly KbRef[]): void;
}

const ASSISTANT_KIND = "pi.assistant";

/**
 * 把旁路表里的命中合并到 assistant entry（NERE-40）。
 * 只新增 `kbRefs` 字段，其它 entry 原样返回；老会话没有行时结果与迁移前完全一致。
 */
function withKbRefs(sql: SqlHandle, conversationId: string, items: readonly unknown[]): readonly unknown[] {
	const assistantIds: number[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const row = item as { id?: unknown; kind?: unknown };
		if (row.kind !== ASSISTANT_KIND) continue;
		const id = Number(row.id);
		if (Number.isFinite(id) && id > 0) assistantIds.push(id);
	}
	if (!assistantIds.length) return items;
	const found = getEntryKbRefs(sql, conversationId, assistantIds);
	if (!found.size) return items;
	return items.map((item) => {
		if (!item || typeof item !== "object") return item;
		const row = item as { id?: unknown; kind?: unknown };
		if (row.kind !== ASSISTANT_KIND) return item;
		const refs = found.get(Number(row.id));
		return refs ? { ...(item as Record<string, unknown>), kbRefs: refs } : item;
	});
}

export function createSessionService({ sql, runtime }: SessionServiceDeps): SessionService {
	return {
		async list() {
			const rootId = await runtime.rootId();
			const rows: SessionMetaRow[] = listVisible(sql);
			const visible = new Set(rows.map((row) => row.id));
			const known = new Set(listKnownIds(sql));
			const now = new Date().toISOString();
			for (const id of await runtime.scanConversationIds()) {
				if (visible.has(id) || known.has(id)) continue;
				const title = id === rootId ? "默认会话" : `会话 ${id}`;
				insertIfAbsent(sql, id, title, now);
				rows.push({ id, title, created_at: now, updated_at: now });
			}
			return { sessions: rows };
		},

		async create() {
			const id = await runtime.createConversation();
			insertIfAbsent(sql, id, "新会话", new Date().toISOString());
			return { id, title: "新会话" };
		},

		async fork(sessionId, entryId, title) {
			const forked = await runtime.forkBefore(sessionId, entryId);
			const parent = get(sql, forked.parentId);
			const now = new Date().toISOString();
			const fallback = `⑂ ${parent?.title || `会话 ${forked.parentId}`}`;
			const finalTitle = (title ?? "").trim().slice(0, 60) || fallback;
			insertFork(sql, {
				id: forked.id,
				title: finalTitle,
				now,
				model: runtime.modelFor(sessionId),
				parentId: forked.parentId,
				forkAt: forked.at,
			});
			return { id: forked.id, title: finalTitle };
		},

		rename(id, title) {
			rename(sql, id, title.trim().slice(0, 60), new Date().toISOString());
		},

		remove(id) {
			markDeleted(sql, id, new Date().toISOString());
			removeSessionFiles(sql, id);
			// 旁路元数据不随 Harness 条目级联，删除会话时一并清掉，避免长期留存（NERE-40 review）。
			removeEntryKbRefs(sql, id);
			runtime.pauseGoal(id);
		},

		async entries(sessionId) {
			const { conversationId, items } = await runtime.entries(sessionId);
			return withKbRefs(sql, conversationId, items);
		},

		saveEntryKbRefs(conversationId, entryId, refs) {
			if (!refs.length) return;
			const id = Number(entryId);
			if (!Number.isFinite(id) || id <= 0) return;
			upsertEntryKbRefs(sql, conversationId, id, refs, new Date().toISOString());
		},
	};
}

import type { SqlHandle } from "../db/migrations";
import type { KbRef } from "../lib/kb";

/** `entry_kb_refs` 的类型化记录（NERE-40）：assistant entry 的知识库命中旁路存储。 */
export type EntryKbRefsRow = { conversation_id: string; entry_id: number; refs: string; created_at: string };

/** 宽容解析落库的 JSON：坏行按「无命中」处理，不让一条脏数据拖垮整个 /entries。 */
export function parseKbRefs(raw: string | null | undefined): KbRef[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const refs: KbRef[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const docId = Number(row.docId);
		const chunkId = Number(row.chunkId);
		const chunkSeq = Number(row.chunkSeq);
		if (!Number.isFinite(docId) || !Number.isFinite(chunkId) || !Number.isFinite(chunkSeq)) continue;
		if (typeof row.title !== "string") continue;
		const ref: KbRef = { docId, chunkId, chunkSeq, title: row.title };
		if (typeof row.source === "string" && row.source) ref.source = row.source;
		refs.push(ref);
	}
	return refs;
}

/** 覆盖写一条 entry 的命中；调用方保证 refs 非空。 */
export function upsert(sql: SqlHandle, conversationId: string, entryId: number, refs: readonly KbRef[], now: string): void {
	sql.exec(
		`INSERT INTO entry_kb_refs (conversation_id, entry_id, refs, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(conversation_id, entry_id) DO UPDATE SET refs = excluded.refs, created_at = excluded.created_at`,
		conversationId,
		entryId,
		JSON.stringify(refs),
		now,
	);
}

/** 批量读一个会话里若干 entry 的命中，返回 entryId → refs（空命中不建键）。 */
export function getMany(sql: SqlHandle, conversationId: string, entryIds: readonly number[]): Map<number, KbRef[]> {
	const found = new Map<number, KbRef[]>();
	if (!entryIds.length) return found;
	const rows = sql
		.exec(
			`SELECT entry_id, refs FROM entry_kb_refs WHERE conversation_id = ? AND entry_id IN (${entryIds.map(() => "?").join(",")})`,
			conversationId,
			...entryIds,
		)
		.toArray() as { entry_id: number; refs: string }[];
	for (const row of rows) {
		const refs = parseKbRefs(row.refs);
		if (refs.length) found.set(Number(row.entry_id), refs);
	}
	return found;
}

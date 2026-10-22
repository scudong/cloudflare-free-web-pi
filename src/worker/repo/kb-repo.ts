import type { SqlHandle } from "../db/migrations";
import { chunkIds } from "../db/sql-batch";
import type { KbHit } from "../lib/kb";

/** 知识库仓储（ADR-0001 §3）：只做 `kb_docs` / `kb_chunks` / `kb_fts` 的 SQL，返回类型化记录。 */
export type KbDocRow = {
	id: number;
	title: string;
	source: string;
	tags: string;
	size: number;
	chunks: number;
	createdAt: string;
	updatedAt: string;
};

export type KbDocDetail = {
	id: number;
	title: string;
	source: string;
	tags: string;
	content: string;
	createdAt: string;
	updatedAt: string;
};

export type KbChunkRow = { id: number; doc_id: number; seq: number; text: string };

export type KbBackupDoc = {
	id: number;
	title: string;
	source: string;
	tags: string;
	content: string;
	created_at: string;
	updated_at: string;
};

/** 向量命中回读的片段列（score 由 Service 按向量得分回填）。 */
export type KbChunkText = Omit<KbHit, "score">;

function lastInsertRowid(sql: SqlHandle): number {
	return Number((sql.exec("SELECT last_insert_rowid() AS id").toArray() as { id: number }[])[0]?.id ?? 0);
}

export function listDocs(sql: SqlHandle): KbDocRow[] {
	return sql
		.exec(
			"SELECT id, title, source, tags, length(content) AS size, created_at AS createdAt, updated_at AS updatedAt, " +
				"(SELECT COUNT(*) FROM kb_chunks WHERE kb_chunks.doc_id = kb_docs.id) AS chunks FROM kb_docs ORDER BY updated_at DESC",
		)
		.toArray() as KbDocRow[];
}

export function getDoc(sql: SqlHandle, id: number): KbDocDetail | undefined {
	const rows = sql
		.exec(
			"SELECT id, title, source, tags, content, created_at AS createdAt, updated_at AS updatedAt FROM kb_docs WHERE id = ?",
			id,
		)
		.toArray() as KbDocDetail[];
	return rows[0];
}

export function docExists(sql: SqlHandle, id: number): boolean {
	return sql.exec("SELECT id FROM kb_docs WHERE id = ?", id).toArray().length > 0;
}

/** 恢复备份时的去重：同标题同正文视为同一篇。 */
export function docExistsByContent(sql: SqlHandle, title: string, content: string): boolean {
	return sql.exec("SELECT id FROM kb_docs WHERE title = ? AND content = ?", title, content).toArray().length > 0;
}

/** 导入去重的身份键：非空 source 对应唯一一篇文档（历史重复时取最近更新的一篇）。 */
export type KbDocIdentity = { id: number; content: string };

export function findDocBySource(sql: SqlHandle, source: string): KbDocIdentity | undefined {
	const rows = sql
		.exec("SELECT id, content FROM kb_docs WHERE source = ? ORDER BY updated_at DESC, id DESC LIMIT 1", source)
		.toArray() as KbDocIdentity[];
	return rows[0];
}

export function countChunksForDoc(sql: SqlHandle, docId: number): number {
	return Number(
		(sql.exec("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?", docId).toArray() as { n: number }[])[0]?.n ?? 0,
	);
}

/** 版本替换：保留 id 与 created_at，刷新标题、来源、标签、正文与更新时间。 */
export function updateDoc(
	sql: SqlHandle,
	id: number,
	doc: { title: string; source: string; tags: string; content: string; now: string },
): void {
	sql.exec(
		"UPDATE kb_docs SET title = ?, source = ?, tags = ?, content = ?, updated_at = ? WHERE id = ?",
		doc.title,
		doc.source,
		doc.tags,
		doc.content,
		doc.now,
		id,
	);
}

export function insertDoc(
	sql: SqlHandle,
	doc: { title: string; source: string; tags: string; content: string; now: string },
): number {
	sql.exec(
		"INSERT INTO kb_docs (title, source, tags, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		doc.title,
		doc.source,
		doc.tags,
		doc.content,
		doc.now,
		doc.now,
	);
	return lastInsertRowid(sql);
}

/** 写入一个分块，返回其 id（同时就是 kb_fts 的 rowid）。 */
export function insertChunk(sql: SqlHandle, docId: number, seq: number, text: string): number {
	sql.exec("INSERT INTO kb_chunks (doc_id, seq, text) VALUES (?, ?, ?)", docId, seq, text);
	return lastInsertRowid(sql);
}

export function insertFts(sql: SqlHandle, chunkId: number, titleTokens: string, bodyTokens: string): void {
	sql.exec("INSERT INTO kb_fts (rowid, title_tokens, body_tokens) VALUES (?, ?, ?)", chunkId, titleTokens, bodyTokens);
}

export function deleteFts(sql: SqlHandle, chunkId: number): void {
	sql.exec("DELETE FROM kb_fts WHERE rowid = ?", chunkId);
}

export function listChunkIds(sql: SqlHandle, docId: number): number[] {
	return (sql.exec("SELECT id FROM kb_chunks WHERE doc_id = ?", docId).toArray() as { id: number }[]).map((row) => row.id);
}

export function deleteChunks(sql: SqlHandle, docId: number): void {
	sql.exec("DELETE FROM kb_chunks WHERE doc_id = ?", docId);
}

export function deleteDoc(sql: SqlHandle, id: number): void {
	sql.exec("DELETE FROM kb_docs WHERE id = ?", id);
}

/** 备份导出：列名沿用备份 JSON 的 snake_case，按 id 升序。 */
export function listBackupDocs(sql: SqlHandle): KbBackupDoc[] {
	return sql
		.exec("SELECT id, title, source, tags, content, created_at, updated_at FROM kb_docs ORDER BY id")
		.toArray() as KbBackupDoc[];
}

export function searchFts(sql: SqlHandle, expression: string, limit: number): KbHit[] {
	return sql
		.exec(
			"SELECT kb_fts.rowid AS chunkId, kb_chunks.doc_id AS docId, kb_chunks.seq AS chunkSeq, kb_chunks.text AS text, " +
				"kb_docs.title AS title, kb_docs.source AS source, bm25(kb_fts, 6.0, 1.0) AS score " +
				"FROM kb_fts JOIN kb_chunks ON kb_chunks.id = kb_fts.rowid JOIN kb_docs ON kb_docs.id = kb_chunks.doc_id " +
				"WHERE kb_fts MATCH ? ORDER BY score LIMIT ?",
			expression,
			limit,
		)
		.toArray() as KbHit[];
}

/** FTS 不可用或没有二元组时的整篇 LIKE 回退；`like` 由调用方拼好。 */
export function searchLike(sql: SqlHandle, like: string, limit: number): KbHit[] {
	return sql
		.exec(
			"SELECT 0 AS chunkId, id AS docId, 0 AS chunkSeq, content AS text, title, source, 0 AS score " +
				"FROM kb_docs WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?",
			like,
			like,
			limit,
		)
		.toArray() as KbHit[];
}

/** 向量命中回读；id 集合按绑定参数上限分批，避免大 topK 时单个查询超限。 */
export function chunksByIds(sql: SqlHandle, ids: number[]): KbChunkText[] {
	const rows: KbChunkText[] = [];
	for (const batch of chunkIds(ids)) {
		rows.push(
			...(sql
				.exec(
					`SELECT c.id AS chunkId, c.doc_id AS docId, c.seq AS chunkSeq, c.text AS text, d.title AS title, d.source AS source
			 FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.id IN (${batch.map(() => "?").join(",")})`,
					...batch,
				)
				.toArray() as KbChunkText[]),
		);
	}
	return rows;
}

/** 未建向量的分块；`docId` 为空时跨文档取。 */
export function listUnvectorized(sql: SqlHandle, limit: number, docId?: number): KbChunkRow[] {
	if (docId === undefined) {
		return sql
			.exec("SELECT id, doc_id, seq, text FROM kb_chunks WHERE vectorized = 0 ORDER BY id LIMIT ?", limit)
			.toArray() as KbChunkRow[];
	}
	return sql
		.exec("SELECT id, doc_id, seq, text FROM kb_chunks WHERE doc_id = ? AND vectorized = 0 ORDER BY seq LIMIT ?", docId, limit)
		.toArray() as KbChunkRow[];
}

/** 一次重建最多 500 个分块，必须分批：单个 `IN (?…)` 会超过 DO SQLite 的 100 个绑定参数。 */
export function markVectorized(sql: SqlHandle, ids: number[]): void {
	for (const batch of chunkIds(ids)) {
		sql.exec(`UPDATE kb_chunks SET vectorized = 1 WHERE id IN (${batch.map(() => "?").join(",")})`, ...batch);
	}
}

export function countChunks(sql: SqlHandle): number {
	return Number((sql.exec("SELECT COUNT(*) AS n FROM kb_chunks").toArray() as { n: number }[])[0]?.n ?? 0);
}

export function countVectorized(sql: SqlHandle): number {
	return Number(
		(sql.exec("SELECT COUNT(*) AS n FROM kb_chunks WHERE vectorized = 1").toArray() as { n: number }[])[0]?.n ?? 0,
	);
}

export function countUnvectorized(sql: SqlHandle): number {
	return Number(
		(sql.exec("SELECT COUNT(*) AS n FROM kb_chunks WHERE vectorized = 0").toArray() as { n: number }[])[0]?.n ?? 0,
	);
}

/** 单篇文档尚未建向量的分块数（入库/补建后用于回报 pending）。 */
export function countUnvectorizedForDoc(sql: SqlHandle, docId: number): number {
	return Number(
		(
			sql
				.exec("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ? AND vectorized = 0", docId)
				.toArray() as { n: number }[]
		)[0]?.n ?? 0,
	);
}

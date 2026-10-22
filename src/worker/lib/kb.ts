/**
 * 知识库纯函数（ADR-0001 §1.6）：分块、中文二元组分词、FTS 表达式、RRF 融合。
 * 只依赖入参与常量，不 import routes/services/repo，可直接单测。
 */

export const KB_MAX_CONTENT = 200_000;
export const KB_CHUNK_CHARS = 800;
export const KB_CHUNK_OVERLAP = 80;
export const KB_MAX_CHUNKS = 2_000;
export const KB_PREFETCH_TOP = 3;
export const KB_PREFETCH_CHARS = 600;

/** 知识库命中的片段；`chunkId=0` 表示 LIKE 回退的整篇文档。 */
export type KbHit = {
	chunkId: number;
	docId: number;
	title: string;
	source: string;
	chunkSeq: number;
	text: string;
	score: number;
};

/** 中文二元组 + 英文/数字词，供 FTS5 使用。 */
export function kbTokens(text: string): string[] {
	const tokens: string[] = [];
	const normalized = text.normalize("NFKC").toLowerCase();
	for (const run of normalized.match(/[㐀-鿿豈-﫿]+|[a-z0-9_]+/g) ?? []) {
		if (/^[㐀-鿿豈-﫿]/.test(run)) {
			if (run.length === 1) tokens.push(run);
			else for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
		} else {
			tokens.push(run);
		}
	}
	return tokens;
}

/** 口语疑问词不作为检索词：几乎每个问题里都有，会淹没真正的主题词。 */
const KB_STOP_BIGRAMS = new Set([
	"怎么", "么办", "什么", "如何", "可以", "请问", "是否", "多少", "哪些", "这个", "那个",
	"我们", "你们", "他们", "一下", "现在", "然后", "就是", "因为", "所以", "如果", "但是",
	"不是", "没有", "需要", "一个", "这些", "那些", "以及", "还是", "或者", "而且", "关于",
]);

export function kbQueryTokens(query: string): string[] {
	return [...new Set(kbTokens(query))].filter((token) => !KB_STOP_BIGRAMS.has(token)).slice(0, 32);
}

/** 查询串 → FTS5 MATCH 表达式；单字返回 null（索引只有二元组）。 */
export function kbFtsQuery(query: string, mode: "and" | "or" = "and"): string | null {
	const tokens = kbQueryTokens(query);
	if (!tokens.length || (tokens.length === 1 && tokens[0]!.length < 2)) return null;
	return tokens.map((token) => `"${token}"`).join(mode === "and" ? " AND " : " OR ");
}

/** 按段落聚合成约 800 字的片段，超长段落按 720 字步长切分并留 80 字重叠。 */
export function kbChunkText(text: string): string[] {
	if (!text) return [];
	const out: string[] = [];
	let buf = "";
	const flush = () => {
		const trimmed = buf.trim();
		if (trimmed) out.push(trimmed);
		buf = "";
	};
	for (const raw of text.split(/\n{2,}/)) {
		const para = raw.trim();
		if (!para) continue;
		if (para.length > KB_CHUNK_CHARS) {
			flush();
			const step = KB_CHUNK_CHARS - KB_CHUNK_OVERLAP;
			for (let i = 0; i < para.length; i += step) {
				const piece = para.slice(i, i + KB_CHUNK_CHARS).trim();
				if (piece) out.push(piece);
				if (out.length >= KB_MAX_CHUNKS) return out;
			}
			continue;
		}
		if (buf.length + para.length + 2 > KB_CHUNK_CHARS) flush();
		buf += (buf ? "\n\n" : "") + para;
	}
	flush();
	return out;
}

/** Reciprocal Rank Fusion：关键词与向量两路各按名次计分，去重后取前 N。 */
export function kbRrfMerge(keyword: KbHit[], vector: KbHit[], limit: number): KbHit[] {
	const merged = new Map<string, { hit: KbHit; score: number }>();
	const add = (hits: KbHit[]) => {
		hits.forEach((hit, index) => {
			const key = hit.chunkId ? String(hit.chunkId) : `${hit.docId}:${hit.chunkSeq}`;
			const value = 1 / (60 + index + 1);
			const entry = merged.get(key);
			if (entry) entry.score += value;
			else merged.set(key, { hit, score: value });
		});
	};
	add(keyword);
	add(vector);
	return [...merged.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => ({ ...entry.hit, score: entry.score }));
}

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import {
	createKbService,
	KbIngestError,
	type KbEnv,
	type KbSettings,
	type WebFetchResult,
} from "../../src/worker/services/kb-service";

/** 与 migrations.test.ts 相同的 SqlHandle 包装：DDL 走 exec，查询走 prepare().all()。
 *  绑定参数上限 100 与 SQLite-backed DO 对齐（NERE-66）：超出即抛错，批量路径必须自己分批。 */
function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (bindings.length > 100) throw new Error(`too many SQL variables (max 100, got ${bindings.length})`);
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

function withDb(run: (sql: SqlHandle) => Promise<void>): () => Promise<void> {
	return async () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			await run(sql);
		} finally {
			db.close();
		}
	};
}

type FakeAi = { calls: { model: string; texts: string[] }[]; run(model: string, input: unknown): Promise<{ data?: number[][] }> };

function fakeAi(options: { failOnCall?: number } = {}): FakeAi {
	return {
		calls: [],
		async run(model, input) {
			// 计数以「这一批是第几次 AI 调用」为准，用来模拟大批量索引中途失败。
			if (this.calls.length + 1 === options.failOnCall) throw new Error("AI unavailable");
			const raw = input && typeof input === "object" && "text" in input ? input.text : [];
			const texts = Array.isArray(raw) ? raw.map(String) : [];
			this.calls.push({ model, texts });
			return { data: texts.map((_, index) => [1, index] as number[]) };
		},
	};
}

type VectorRow = { id: string; values: number[]; metadata?: Record<string, string | number> };
type FakeVector = {
	upserts: VectorRow[];
	deleted: string[];
	upsert(vectors: VectorRow[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(vector: number[], options: Record<string, unknown>): Promise<{ matches?: { id: string; score: number }[] }>;
};

function fakeVector(): FakeVector {
	return {
		upserts: [],
		deleted: [],
		async upsert(vectors) {
			this.upserts.push(...vectors);
		},
		async deleteByIds(ids) {
			this.deleted.push(...ids);
		},
		async query() {
			return { matches: [] };
		},
	};
}

const noFetch = async (): Promise<WebFetchResult> => ({ ok: false, kind: "error", message: "stub" });

function service(
	sql: SqlHandle,
	overrides: {
		env?: KbEnv;
		settings?: KbSettings;
		scopeId?: string;
		webFetch?: (url: string) => Promise<WebFetchResult>;
		now?: () => string;
	} = {},
) {
	return createKbService({
		sql,
		env: overrides.env ?? {},
		scopeId: overrides.scopeId ?? "scope-a",
		settings: overrides.settings ?? { get: (_key, fallback) => fallback },
		webFetch: overrides.webFetch ?? noFetch,
		now: overrides.now ?? (() => "2026-01-01T00:00:00.000Z"),
	});
}

const DOC = {
	title: "债券研究笔记",
	content: "信用债研究笔记\n\n久期是衡量利率风险的核心指标。组合久期 3.2 年，AA+ 城投占比 40%。",
	source: "金标用例",
	tags: "固收",
};

/** 直接造未向量化分块：reindex 只读 kb_chunks，不需要文档行。 */
function seedChunks(sql: SqlHandle, count: number): void {
	for (let i = 0; i < count; i++) sql.exec("INSERT INTO kb_chunks (doc_id, seq, text) VALUES (?, ?, ?)", 1, i, `未向量化片段 ${i}`);
}

const hybridSettings: KbSettings = { get: (key, fallback) => (key === "kb_retrieval" ? "hybrid" : fallback) };

describe("kb-service：入库与全文检索", () => {
	it(
		"入库后自动分块，FTS 命中，删除后不再命中",
		withDb(async (sql) => {
			const kb = service(sql);
			const added = await kb.add(DOC);
			expect(added.chunks).toBeGreaterThanOrEqual(1);

			const [doc] = kb.listDocs();
			expect(doc).toMatchObject({ id: added.id, title: DOC.title, source: DOC.source, tags: DOC.tags, chunks: added.chunks });
			expect(doc!.size).toBeGreaterThan(0);
			expect(kb.getDoc(added.id)?.content).toContain("久期");

			const hits = kb.search("久期");
			expect(hits[0]).toMatchObject({ docId: added.id, title: DOC.title });
			expect(hits[0]!.text).toContain("久期");

			expect(await kb.remove(added.id)).toBe(true);
			expect(kb.search("久期")).toEqual([]);
			expect(kb.listDocs()).toEqual([]);
			expect(await kb.remove(added.id)).toBe(false);
		}),
	);

	it(
		"预检索块受 kb_prefetch 开关控制",
		withDb(async (sql) => {
			await service(sql).add(DOC);
			const on = service(sql);
			expect(await on.prefetchBlock("组合久期怎么看")).toContain("债券研究笔记");

			const off = service(sql, { settings: { get: (key, fallback) => (key === "kb_prefetch" ? "0" : fallback) } });
			expect(await off.prefetchBlock("组合久期怎么看")).toBe("");
			expect((await off.prefetchPreview("久期")).block).toBe("");
		}),
	);
});

describe("kb-service：向量端口", () => {
	it(
		"未配置 AI / KB_VEC 时不可用，hybrid 回退 FTS",
		withDb(async (sql) => {
			const kb = service(sql, { settings: hybridSettings });
			expect(kb.vectorAvailable()).toBe(false);
			expect(kb.status()).toMatchObject({ available: false, mode: "hybrid", index: "pi-kb", model: "@cf/baai/bge-m3" });

			const added = await kb.addIndexed(DOC);
			expect(added.vectorized).toBe(0);

			const hits = await kb.searchAsync("久期");
			expect(hits.length).toBeGreaterThan(0);
			expect(hits[0]!.title).toBe("债券研究笔记");
		}),
	);

	it(
		"CF_DISABLE_VECTOR=1 时即使有标定也不建向量，hybrid 走 FTS",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec, CF_DISABLE_VECTOR: "1" }, settings: hybridSettings });

			expect(kb.vectorAvailable()).toBe(false);
			const added = await kb.addIndexed(DOC);
			expect(added.vectorized).toBe(0);
			expect(ai.calls).toEqual([]);
			expect(vec.upserts).toEqual([]);

			const hits = await kb.searchAsync("久期");
			expect(hits[0]!.title).toBe("债券研究笔记");
			expect(ai.calls).toEqual([]);
		}),
	);

	it(
		"scopeId 进入向量 id 前缀与 metadata，删除按同一前缀清理",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, scopeId: "agent-42", settings: hybridSettings });

			expect(kb.vectorAvailable()).toBe(true);
			const added = await kb.addIndexed(DOC);
			expect(added.vectorized).toBeGreaterThan(0);
			expect(vec.upserts).toHaveLength(added.vectorized);
			for (const row of vec.upserts) {
				expect(row.id.startsWith("agent-42:")).toBe(true);
				expect(row.metadata?.scope).toBe("agent-42");
			}
			expect(kb.status()).toMatchObject({ available: true, total: added.chunks, indexed: added.vectorized });

			await kb.remove(added.id);
			expect(vec.deleted.sort()).toEqual(vec.upserts.map((row) => row.id).sort());
		}),
	);
});

describe("kb-service：向量索引重建分批（NERE-66）", () => {
	it(
		"reindex 500 条与默认 200 条批量都不超绑定参数上限，计数同步",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			seedChunks(sql, 500);
			expect(await kb.reindex(500)).toEqual({ indexed: 500, remaining: 0 });
			expect(vec.upserts).toHaveLength(500);
			expect(kb.status()).toMatchObject({ total: 500, indexed: 500 });

			seedChunks(sql, 200);
			expect(await kb.reindex()).toEqual({ indexed: 200, remaining: 0 });
			expect(vec.upserts).toHaveLength(700);
			expect(kb.status()).toMatchObject({ total: 700, indexed: 700 });
		}),
	);
});

describe("kb-service：入库向量索引补齐（NERE-78）", () => {
	/** 150 段 851 字正文：每段按 720 步长切成 2 块，共 300 块（低于 20 万字符上限）。 */
	const LONG_CONTENT = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(3, "0")}${"甲".repeat(847)}`).join("\n\n");

	it(
		"300 段文档 addIndexed 循环建完向量，status 不再有 pending",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			const added = await kb.addIndexed({ title: "长文档", content: LONG_CONTENT, source: "long.txt" });
			expect(added.chunks).toBe(300);
			expect(added.vectorized).toBe(300);
			expect(added.pending).toBe(0);
			expect(vec.upserts).toHaveLength(300);
			expect(kb.status()).toMatchObject({ total: 300, indexed: 300, pending: 0 });
			// 单次 embed 仍按既有批大小切分，逐批循环而不是把 300 段塞进一次调用。
			expect(Math.max(...ai.calls.map((call) => call.texts.length))).toBeLessThanOrEqual(16);
		}),
	);

	it(
		"中途 AI 失败：已完成批次保留，响应与 status 的 pending 可轮询",
		withDb(async (sql) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				// 第一批 200 段用 13 次调用；第 15 次（第二批 100 段内）失败。
				const ai = fakeAi({ failOnCall: 15 });
				const vec = fakeVector();
				const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

				const added = await kb.addIndexed({ title: "长文档", content: LONG_CONTENT, source: "long.txt" });
				expect(added.vectorized).toBe(200);
				expect(added.pending).toBe(100);
				expect(vec.upserts).toHaveLength(200);
				expect(kb.status()).toMatchObject({ total: 300, indexed: 200, pending: 100 });
			} finally {
				warn.mockRestore();
			}
		}),
	);
});

describe("kb-service：链接导入", () => {
	it(
		"抓取成功写入知识库，空页面与非法链接抛领域错误",
		withDb(async (sql) => {
			const kb = service(sql, {
				webFetch: async (url) =>
					url.includes("empty")
						? { ok: false, kind: "empty", message: "页面没有可提取的正文。" }
						: { ok: true, title: "金标测试页面", content: DOC.content },
			});

			const result = await kb.ingestUrl("https://example.com/golden");
			expect(result).toMatchObject({ ok: true, title: "金标测试页面" });
			expect(result.chunks).toBeGreaterThan(0);
			expect(kb.listDocs()).toHaveLength(1);

			await expect(kb.ingestUrl("file:///etc/passwd")).rejects.toMatchObject({ status: 400, code: "invalid_url" });
			await expect(kb.ingestUrl(undefined)).rejects.toMatchObject({ status: 400, code: "invalid_url" });
			await expect(kb.ingestUrl("https://example.com/empty")).rejects.toMatchObject({ status: 422, code: "empty_content" });
		}),
	);

	it(
		"未知异常收敛为 internal_error",
		withDb(async (sql) => {
			const kb = service(sql, {
				webFetch: async () => {
					throw new Error("boom");
				},
			});
			const err = await kb.ingestUrl("https://example.com/boom").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(KbIngestError);
			expect(err).toMatchObject({ status: 500, code: "internal_error", message: "导入失败，请稍后重试。" });
		}),
	);
});

describe("kb-service：预检索引用（NERE-40）", () => {
	it(
		"命中时 refs 与注入块逐条对应，带文档定位信息",
		withDb(async (sql) => {
			const added = await service(sql).add({ ...DOC, content: "久期是衡量利率风险的核心指标。久期越长，价格对利率越敏感。" });
			const result = await service(sql).prefetch("久期怎么看");

			expect(result.block).toContain("债券研究笔记");
			expect(result.refs.length).toBeGreaterThan(0);
			// 块里每条参考资料一条 ref：分隔符数量 + 1
			expect(result.refs).toHaveLength(result.block.split("\n\n---\n\n").length);
			expect(result.refs[0]).toMatchObject({ docId: added.id, title: DOC.title, source: DOC.source });
			expect(result.refs[0]!.chunkSeq).toBeGreaterThanOrEqual(0);
			expect(result.refs[0]!.chunkId).toBeGreaterThan(0);
			for (const ref of result.refs) expect(result.block).toContain(ref.title);
		}),
	);

	it(
		"未命中 / 开关关闭 / 查询过短都不产生引用",
		withDb(async (sql) => {
			await service(sql).add(DOC);
			expect(await service(sql).prefetch("今天天气怎么样")).toEqual({ block: "", refs: [] });
			expect(await service(sql).prefetch("久")).toEqual({ block: "", refs: [] });

			const off = service(sql, { settings: { get: (key, fallback) => (key === "kb_prefetch" ? "0" : fallback) } });
			expect(await off.prefetch("久期怎么看")).toEqual({ block: "", refs: [] });
		}),
	);

	it(
		"多文档命中时按 docId:chunkId 去重，refs 不重复",
		withDb(async (sql) => {
			const kb = service(sql);
			await kb.add({ title: "债券研究笔记", content: "久期是衡量利率风险的核心指标。", source: "a.md" });
			await kb.add({ title: "组合管理手册", content: "组合久期与利率敏感度成正比。", source: "b.md" });
			const result = await kb.prefetch("久期");

			const keys = result.refs.map((ref) => `${ref.docId}:${ref.chunkId}`);
			expect(new Set(keys).size).toBe(keys.length);
			expect(result.refs.map((ref) => ref.title).sort()).toEqual(["债券研究笔记", "组合管理手册"]);
		}),
	);
});

describe("kb-service：来源去重与版本替换（NERE-47）", () => {
	const OLD = { title: "导入验收", source: "report.pdf", tags: "验收", content: "第一版正文。旧版本专用词甲。\n\n结尾说明。" };
	const NEW = { ...OLD, content: "第二版正文。新版本专用词乙。\n\n结尾说明。" };

	it(
		"同来源同正文重复入库：复用 docId、chunk 不变、updated:false",
		withDb(async (sql) => {
			const kb = service(sql);
			const first = await kb.add(OLD);
			expect(first.updated).toBe(true);

			const second = await kb.add({ ...OLD, title: "改个标题也不该重复" });
			expect(second).toMatchObject({ id: first.id, chunks: first.chunks, updated: false });
			expect(kb.listDocs()).toHaveLength(1);
			expect(kb.listDocs()[0]!.chunks).toBe(first.chunks);
			// 命中已存在的文档时不改写标题 / 时间
			expect(kb.getDoc(first.id)?.title).toBe(OLD.title);
		}),
	);

	it(
		"同来源不同正文：保留 docId、重建分块，旧句子不再命中",
		withDb(async (sql) => {
			let tick = 0;
			const kb = service(sql, { now: () => `2026-01-0${++tick}T00:00:00.000Z` });
			const first = await kb.add(OLD);
			expect(kb.search("旧版本专用词")).not.toEqual([]);

			const second = await kb.add(NEW);
			expect(second).toMatchObject({ id: first.id, updated: true });
			expect(kb.listDocs()).toHaveLength(1);
			expect(kb.getDoc(first.id)?.content).not.toContain("旧版本专用词");
			expect(kb.search("旧版")).toEqual([]);
			expect(kb.search("旧版本专用词").every((hit) => !hit.text.includes("旧版本专用词"))).toBe(true);
			expect(kb.search("新版本专用词").length).toBeGreaterThan(0);
			expect(kb.listDocs()[0]!.updatedAt > "2026-01-01T00:00:00.000Z").toBe(true);
		}),
	);

	it(
		"不同来源同正文各存一篇；无来源的粘贴不去重",
		withDb(async (sql) => {
			const kb = service(sql);
			const a = await kb.add({ ...OLD, source: "a.pdf" });
			const b = await kb.add({ ...OLD, source: "b.pdf" });
			expect(b.id).not.toBe(a.id);

			const paste1 = await kb.add({ title: "粘贴", content: "同一段粘贴正文" });
			const paste2 = await kb.add({ title: "粘贴", content: "同一段粘贴正文" });
			expect(paste2.id).not.toBe(paste1.id);
			expect(kb.listDocs()).toHaveLength(4);
		}),
	);

	it(
		"版本替换删除旧向量并按新分块重建",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			const first = await kb.addIndexed(OLD);
			const oldVectorIds = vec.upserts.map((row) => row.id);
			expect(oldVectorIds.length).toBeGreaterThan(0);

			const second = await kb.addIndexed(NEW);
			expect(second).toMatchObject({ id: first.id, updated: true });
			expect(vec.deleted.sort()).toEqual([...oldVectorIds].sort());

			const newVectors = vec.upserts.slice(oldVectorIds.length);
			expect(newVectors).toHaveLength(second.chunks);
			expect(newVectors.every((row) => !oldVectorIds.includes(row.id))).toBe(true);
		}),
	);
});

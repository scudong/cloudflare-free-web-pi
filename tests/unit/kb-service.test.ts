import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import {
	createKbService,
	KbIngestError,
	type KbEnv,
	type KbSettings,
	type WebFetchResult,
} from "../../src/worker/services/kb-service";

/** 与 migrations.test.ts 相同的 SqlHandle 包装：DDL 走 exec，查询走 prepare().all()。 */
function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
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

function fakeAi(): FakeAi {
	return {
		calls: [],
		async run(model, input) {
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
	overrides: { env?: KbEnv; settings?: KbSettings; scopeId?: string; webFetch?: (url: string) => Promise<WebFetchResult> } = {},
) {
	return createKbService({
		sql,
		env: overrides.env ?? {},
		scopeId: overrides.scopeId ?? "scope-a",
		settings: overrides.settings ?? { get: (_key, fallback) => fallback },
		webFetch: overrides.webFetch ?? noFetch,
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

const DOC = {
	title: "债券研究笔记",
	content: "信用债研究笔记\n\n久期是衡量利率风险的核心指标。组合久期 3.2 年，AA+ 城投占比 40%。",
	source: "金标用例",
	tags: "固收",
};

const hybridSettings: KbSettings = { get: (key, fallback) => (key === "kb_retrieval" ? "hybrid" : fallback) };

describe("kb-service：入库与全文检索", () => {
	it(
		"入库后自动分块，FTS 命中，删除后不再命中",
		withDb(async (sql) => {
			const kb = service(sql);
			const added = kb.add(DOC);
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
			service(sql).add(DOC);
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
			const added = service(sql).add({ ...DOC, content: "久期是衡量利率风险的核心指标。久期越长，价格对利率越敏感。" });
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
			service(sql).add(DOC);
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
			kb.add({ title: "债券研究笔记", content: "久期是衡量利率风险的核心指标。", source: "a.md" });
			kb.add({ title: "组合管理手册", content: "组合久期与利率敏感度成正比。", source: "b.md" });
			const result = await kb.prefetch("久期");

			const keys = result.refs.map((ref) => `${ref.docId}:${ref.chunkId}`);
			expect(new Set(keys).size).toBe(keys.length);
			expect(result.refs.map((ref) => ref.title).sort()).toEqual(["债券研究笔记", "组合管理手册"]);
		}),
	);
});

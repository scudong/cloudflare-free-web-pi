import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * 知识库导入通道（v0.56.0）金标。
 * AI 绑定用 tests/fixtures 里的 ai-mock（RPC service binding）；
 * 链接抓取把 DEEPSEEK_BASE_URL 指到本文件的本地 HTTP 桩，避免真实外网与凭证依赖。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.INGEST_TEST_PORT ?? 18881);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-ingest");

const UNIQUE_TERM = "尼瑞德量子锚";
const LINK_TERM = "链接导入验收词";

let proc: ChildProcess | null = null;
let stub: Server | null = null;

/** 链接抓取桩：标题固定，正文 > 1000 字；url 里带 empty / boom 时走失败分支。 */
const LINK_CONTENT = Array.from(
	{ length: 30 },
	(_, i) => `第 ${i + 1} 段：知识库导入验收正文，用于确认链接抓取与入库链路。${LINK_TERM} 出现在正文里。`,
).join("\n\n");

type IngestOk = { ok: true; docId: string; title: string; chunks: number; chars: number; updated: boolean };
type IngestFail = { ok: false; code: string; message: string };
type IngestResult = IngestOk | IngestFail;
type KbDoc = { id: number; title: string; source: string; chunks: number };
type KbHit = { docId: number; title: string; text: string };

function okBody(json: IngestResult): IngestOk {
	expect(json.ok).toBe(true);
	if (!json.ok) throw new Error("预期成功响应");
	return json;
}
function failBody(json: IngestResult): IngestFail {
	expect(json.ok).toBe(false);
	if (json.ok) throw new Error("预期失败响应");
	return json;
}

async function api<T>(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: T | null = null;
	try {
		json = JSON.parse(text) as T;
	} catch {
		// 非 JSON 响应
	}
	return { status: res.status, json: json as T, text };
}

const postIngest = (body: unknown) =>
	api<IngestResult>("/api/kb/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const upload = (file: File) => {
	const form = new FormData();
	form.append("file", file);
	return api<IngestResult>("/api/kb/ingest", { method: "POST", body: form });
};

async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 还没起来
		}
		await delay(800);
	}
	throw new Error("wrangler dev 未在超时内就绪");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });

	stub = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			let target = "";
			try {
				target = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown }).url ?? "");
			} catch {
				// 非法 JSON 走默认成功分支
			}
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (target.includes("boom")) return send(500, { error: { message: "上游抓取服务不可用" } });
			if (target.includes("empty")) return send(200, { title: "空页面", content: "   " });
			send(200, { title: "金标测试页面", content: LINK_CONTENT });
		});
	});
	const listening = Promise.withResolvers<void>();
	stub.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = stub.address();
	if (!address || typeof address === "string") throw new Error("抓取桩未监听");
	const stubUrl = `http://127.0.0.1:${address.port}`;

	proc = spawn(
		"npx",
		[
			"wrangler", "dev",
			"-c", "tests/fixtures/wrangler.ingest.jsonc",
			"-c", "tests/fixtures/wrangler.ai-mock.jsonc",
			"--port", String(PORT),
			"--var", "ACCESS_PASSWORD:",
			"--var", "CF_DISABLE_VECTOR:1",
			"--var", "DEEPSEEK_API_KEY:golden-key",
			"--var", `DEEPSEEK_BASE_URL:${stubUrl}`,
			"--persist-to", STATE,
		],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
}, 240_000);

afterAll(async () => {
	await stopServer(proc, STATE);
	if (stub) {
		const closed = Promise.withResolvers<void>();
		stub.close(closed.resolve);
		await closed.promise;
	}
});

describe("知识库导入：文件", () => {
	it("PDF 走 toMarkdown 后入库，列表与检索都能命中", async () => {
		const res = await upload(new File(["%PDF-1.4 mock"], "向量检索实战笔记.pdf", { type: "application/pdf" }));
		expect(res.status).toBe(200);
		const body = okBody(res.json);
		expect(body.title).toBe("向量检索实战笔记");
		expect(body.docId).toBeTypeOf("string");
		expect(body.chunks).toBeGreaterThan(0);
		expect(body.chars).toBeGreaterThan(0);

		const list = await api<{ docs: KbDoc[] }>("/api/kb");
		const doc = list.json.docs.find((d) => String(d.id) === body.docId);
		expect(doc).toMatchObject({ title: "向量检索实战笔记", source: "向量检索实战笔记.pdf" });
		expect(doc!.chunks).toBeGreaterThan(0);

		const search = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent(UNIQUE_TERM)}`);
		expect(search.json.hits.length).toBeGreaterThan(0);
		expect(search.json.hits[0]!.title).toBe("向量检索实战笔记");
		expect(search.json.hits[0]!.text).toContain(UNIQUE_TERM);
	});

	it("Markdown / TXT 不依赖 AI，直接入库", async () => {
		const res = await upload(new File(["# 本地笔记\n\n纯文本导入路径，不调用 toMarkdown。"], "local-note.md", { type: "text/markdown" }));
		expect(res.status).toBe(200);
		const body = okBody(res.json);
		expect(body).toMatchObject({ title: "local-note", chunks: 1 });
		expect(body.chars).toBeGreaterThan(0);
	});

	it("解析结果为空 → 422 empty_content", async () => {
		const empty = await upload(new File(["MOCK_EMPTY"], "blank.pdf", { type: "application/pdf" }));
		expect(empty.status).toBe(422);
		const emptyBody = failBody(empty.json);
		expect(emptyBody.code).toBe("empty_content");
		expect(emptyBody.message).toBeTruthy();

		const blankText = await upload(new File(["   \n"], "blank.txt", { type: "text/plain" }));
		expect(blankText.status).toBe(422);
		const blankBody = failBody(blankText.json);
		expect(blankBody.code).toBe("empty_content");
	});

	it("解析器报错 → 422 且带原因", async () => {
		const res = await upload(new File(["MOCK_ERROR"], "broken.pdf", { type: "application/pdf" }));
		expect(res.status).toBe(422);
		const body = failBody(res.json);
		expect(body.code).toBe("empty_content");
		expect(body.message).toContain("这个文件打不开");
	});

	it("超过 25MB → 413 too_large", async () => {
		const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.pdf", { type: "application/pdf" });
		const res = await upload(big);
		expect(res.status).toBe(413);
		const body = failBody(res.json);
		expect(body.code).toBe("too_large");
		expect(body.message).toContain("25MB");
	});

	it("不支持的格式 → 415 unsupported_type", async () => {
		const res = await upload(new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));
		expect(res.status).toBe(415);
		const body = failBody(res.json);
		expect(body.code).toBe("unsupported_type");
		expect(body.message).toContain("PDF");
	});
});

describe("知识库导入：链接", () => {
	it("抓取成功，标题取页面 title，正文完整入库", async () => {
		const res = await postIngest({ url: "https://example.com/golden-article" });
		expect(res.status).toBe(200);
		const body = okBody(res.json);
		expect(body.title).toBe("金标测试页面");
		expect(body.chars).toBeGreaterThan(1000);

		const search = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent(LINK_TERM)}`);
		expect(search.json.hits.length).toBeGreaterThan(0);
		expect(search.json.hits[0]!.title).toBe("金标测试页面");
	});

	it("页面无正文 → 422 empty_content", async () => {
		const res = await postIngest({ url: "https://example.com/empty-page" });
		expect(res.status).toBe(422);
		const body = failBody(res.json);
		expect(body.code).toBe("empty_content");
	});

	it("抓取服务失败 → 502 fetch_failed，不静默", async () => {
		const res = await postIngest({ url: "https://example.com/boom" });
		expect(res.status).toBe(502);
		const body = failBody(res.json);
		expect(body.code).toBe("fetch_failed");
		expect(body.message).toContain("上游抓取服务不可用");
	});

	it("非 http(s) 链接 → 400 invalid_url", async () => {
		const res = await postIngest({ url: "file:///etc/passwd" });
		expect(res.status).toBe(400);
		const body = failBody(res.json);
		expect(body.code).toBe("invalid_url");
	});
});

describe("知识库导入：去重与版本替换（NERE-47）", () => {
	const FILE = "去重验收.pdf";
	const listBySource = async (source: string) =>
		(await api<{ docs: KbDoc[] }>("/api/kb")).json.docs.filter((doc) => doc.source === source);

	it("同一份 PDF 连导两次：仍 1 篇、chunk 数不变、updated:false", async () => {
		const first = okBody((await upload(new File(["%PDF-1.4 dedupe"], FILE, { type: "application/pdf" }))).json);
		expect(first.updated).toBe(true);
		const before = await listBySource(FILE);
		expect(before).toHaveLength(1);

		const second = okBody((await upload(new File(["%PDF-1.4 dedupe"], FILE, { type: "application/pdf" }))).json);
		expect(second).toMatchObject({ docId: first.docId, chunks: first.chunks, updated: false });

		const after = await listBySource(FILE);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ id: Number(first.docId), chunks: before[0]!.chunks });
	});

	it("改一句话再导：仍 1 篇、updated:true、旧句子不再命中", async () => {
		const [before] = await listBySource(FILE);
		expect(before).toBeTruthy();

		const revised = okBody(
			(await upload(new File(["%PDF-1.4 MOCK_REVISION"], FILE, { type: "application/pdf" }))).json,
		);
		expect(revised).toMatchObject({ docId: String(before!.id), updated: true });

		const after = await listBySource(FILE);
		expect(after).toHaveLength(1);
		expect(after[0]!.id).toBe(before!.id);

		// 其他文档也可能含相近词，只验证被替换的这一篇
		const oldHits = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent("旧版本专用词")}`);
		expect(oldHits.json.hits.filter((hit) => hit.docId === before!.id && hit.text.includes("旧版专用词甲"))).toEqual([]);
		const oldPhrase = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent("旧版")}`);
		expect(oldPhrase.json.hits.filter((hit) => hit.docId === before!.id)).toEqual([]);

		const newHits = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent("新版专用词")}`);
		expect(newHits.json.hits.length).toBeGreaterThan(0);
		expect(newHits.json.hits[0]!.title).toBe("去重验收");
	});
});

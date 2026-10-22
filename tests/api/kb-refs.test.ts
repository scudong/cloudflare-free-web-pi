import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI } from "../helpers/fakeOpenAI";
import { stopServer } from "./teardown";

/**
 * NERE-40 验收（端到端，假模型）：
 * 命中知识库的一轮把 `${docId, chunkId, chunkSeq, title, source?}` 挂到 assistant entry，
 * 随 GET /api/entries 返回，并在 SSE done 事件里透传；未命中的一轮不写该字段。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.KB_REFS_TEST_PORT ?? 18797);
const FAKE_PORT = Number(process.env.KB_REFS_FAKE_PORT ?? 18896);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-kb-refs");

let proc: ChildProcess | null = null;
const fake = startFakeOpenAI(FAKE_PORT);

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 响应
	}
	return { status: res.status, json, text };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 还没起来
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 800);
		await promise;
	}
	throw new Error("wrangler dev 未在超时内就绪");
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
	const events: { event: string; data: Record<string, unknown> }[] = [];
	for (const frame of text.split("\n\n")) {
		const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
		const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
		if (!event || !data) continue;
		try {
			events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
		} catch {
			// 忽略损坏帧
		}
	}
	return events;
}

/** 宽容读取 JSON 对象字段：接口返回可能是错误体或非 JSON。 */
function obj(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function newSession(): Promise<string> {
	const created = await post("/api/sessions", {});
	const id = String(obj(created.json)?.id ?? "");
	expect(id).toBeTruthy();
	expect((await post("/api/model", { sessionId: id, modelId: "fake" })).status).toBe(200);
	return id;
}

async function chat(sessionId: string, message: string) {
	const res = await fetch(`${BASE}/api/chat/stream`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, sessionId }),
	});
	expect(res.status).toBe(200);
	return parseSse(await res.text());
}

function doneOf(events: { event: string; data: Record<string, unknown> }[]): Record<string, unknown> {
	const done = events.find((item) => item.event === "done");
	expect(done, "SSE 应包含 done 事件").toBeTruthy();
	return done!.data;
}

type Ref = { docId: number; chunkId: number; chunkSeq: number; title: string; source?: string };
type Entry = { id: number; kind: string; kbRefs?: Ref[] };

async function assistantEntries(sessionId: string): Promise<Entry[]> {
	const entries = await api(`/api/entries?sessionId=${sessionId}`);
	expect(entries.status).toBe(200);
	if (!Array.isArray(entries.json)) return [];
	return (entries.json as Entry[]).filter((entry) => entry.kind === "pi.assistant");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	await fake.listen();
	proc = spawn(
		"npx",
		["wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT), "--var", "CF_DISABLE_VECTOR:1", "--persist-to", STATE],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();

	expect(
		(
			await post("/api/providers", {
				id: "fake",
				name: "Fake OpenAI",
				baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`,
				apiKey: "sk-fake",
				models: "fake",
			})
		).status,
	).toBe(200);
	expect((await post("/api/providers/activate", { id: "fake" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
	await fake.close();
});

describe("assistant entry.kbRefs（端到端）", () => {
	it("命中「久期」：entry 与 done 都带结构化引用，docId 能取回同标题文档", async () => {
		const added = await post("/api/kb", {
			title: "债券研究笔记",
			content: "久期是衡量利率风险的核心指标。组合久期 3.2 年，久期越长，价格对利率越敏感。",
			source: "固定收益讲义.md",
		});
		expect(added.status).toBe(200);
		const docId = Number(obj(added.json)?.id);
		expect(docId).toBeGreaterThan(0);

		fake.setSteps([{ text: "久期衡量债券价格对利率变化的敏感度。" }]);
		const sid = await newSession();
		const events = await chat(sid, "久期是什么");

		const done = doneOf(events);
		const doneRefs = done.kbRefs as Ref[] | undefined;
		expect(Array.isArray(doneRefs)).toBe(true);
		expect(doneRefs![0]).toMatchObject({ docId, title: "债券研究笔记", source: "固定收益讲义.md" });
		expect(Number.isFinite(doneRefs![0]!.chunkId)).toBe(true);
		expect(Number.isFinite(doneRefs![0]!.chunkSeq)).toBe(true);

		const assistants = await assistantEntries(sid);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]!.kbRefs).toEqual(doneRefs);

		const doc = await api(`/api/kb/doc?id=${assistants[0]!.kbRefs![0]!.docId}`);
		expect(doc.status).toBe(200);
		expect(obj(doc.json)?.title).toBe(assistants[0]!.kbRefs![0]!.title);
	});

	it("未命中「今天天气」：entry 与 done 都不出现 kbRefs", async () => {
		fake.setSteps([{ text: "我查不到今天的天气。" }]);
		const sid = await newSession();
		const events = await chat(sid, "今天天气");

		expect(doneOf(events)).not.toHaveProperty("kbRefs");
		const assistants = await assistantEntries(sid);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).not.toHaveProperty("kbRefs");
	});
});

describe("长会话回归：>100 assistant entries（绑定参数上限）", () => {
	it("101 轮对话后 /api/entries 仍 200，页内每条 assistant entry 都带 kbRefs", async () => {
		await post("/api/kb", {
			title: "利率风险笔记",
			content: "久期衡量债券价格对利率变化的敏感度，久期越长波动越大。",
		});
		const sid = await newSession();
		for (let i = 0; i < 101; i++) await chat(sid, `第 ${i} 轮：久期是什么`);

		// 一页 200 条 = 100 组 user/assistant；旧实现用 IN(?,…) 时这里是 101 个绑定参数 → DO 报错 500。
		const entries = await api(`/api/entries?sessionId=${sid}`);
		expect(entries.status).toBe(200);
		const assistants = (entries.json as Entry[]).filter((entry) => entry.kind === "pi.assistant");
		expect(assistants).toHaveLength(100);
		for (const assistant of assistants) {
			expect(Array.isArray(assistant.kbRefs), `entry ${assistant.id} 缺 kbRefs`).toBe(true);
			expect(assistant.kbRefs!.length).toBeGreaterThan(0);
		}
	});
});

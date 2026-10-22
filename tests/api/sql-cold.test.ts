import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * NERE-78 P1-1 验收：只读写 SQL 的端点不应触发 Harness `open()`。
 * 观测点仍是 DO 的 `/debug/harness`（TEST_HARNESS_STATS=1，自身不 open）。
 * 冷启动时首个 DO 请求就是纯 SQL 端点，open 计数必须保持 0。
 */

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.SQL_COLD_TEST_PORT ?? 18802);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-sql-cold");

let proc: ChildProcess | null = null;

async function api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; json: T | null; text: string }> {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: T | null = null;
	try {
		json = JSON.parse(text) as T;
	} catch {
		// 非 JSON 响应
	}
	return { status: res.status, json, text };
}

const post = <T = unknown>(path: string, body: unknown) =>
	api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function harnessOpens(): Promise<number> {
	const res = await api<{ opens?: unknown }>("/api/debug/harness");
	expect(res.status).toBe(200);
	const opens = res.json?.opens;
	if (typeof opens !== "number") throw new Error("GET /api/debug/harness 未返回 opens 计数");
	return opens;
}

/** wrangler dev 就绪没有事件钩子，只能有界轮询；集成测试共用这份探针。 */
async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 还没起来
		}
		await new Promise((r) => setTimeout(r, 800));
	}
	throw new Error("wrangler dev 未在超时内就绪");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	proc = spawn(
		"npx",
		[
			"wrangler",
			"dev",
			"--config",
			"wrangler.test.jsonc",
			"--port",
			String(PORT),
			"--var",
			"ACCESS_PASSWORD:",
			"--var",
			"CF_DISABLE_VECTOR:1",
			"--var",
			"TEST_HARNESS_STATS:1",
			"--persist-to",
			STATE,
		],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
});

describe("纯 SQL 端点不启动 Harness（NERE-78）", () => {
	it("空 persist 上 GET /api/automations、/api/files、/api/kb 均为 200，opens 保持 0", async () => {
		// 本文件第一个 DO 请求就是纯 SQL 列表端点；之前只有 worker 层的 /api/auth 探针。
		for (const path of ["/api/automations", "/api/files", "/api/kb"]) {
			const res = await api(path);
			expect(res.status, path).toBe(200);
		}
		expect(await harnessOpens()).toBe(0);
	});

	it("其余只读写 SQL 的读端点同样不增加 opens", async () => {
		const before = await harnessOpens();
		const paths = [
			"/api/plan",
			"/api/goal",
			"/api/files/all",
			"/api/memories",
			"/api/capabilities",
			"/api/mcp",
			"/api/kb/status",
			"/api/kb/search?q=%E4%B9%85%E6%9C%9F",
			"/api/kb/prefetch?q=%E4%B9%85%E6%9C%9F",
		];
		for (const path of paths) {
			const res = await api(path);
			expect(res.status, path).toBe(200);
		}
		// 带查询参数 / 缺参数的 404 也不应拉起 Harness。
		expect((await api("/api/files/content?name=missing.md")).status).toBe(404);
		expect((await api("/api/kb/doc?id=999")).status).toBe(404);
		expect(await harnessOpens()).toBe(before);
	});

	it("写端点（自动化 / 目标 / 知识库 / 记忆）不启动 Harness", async () => {
		const before = await harnessOpens();

		const created = await post<{ id?: string }>("/api/automations", { name: "冷启动任务", prompt: "只写 SQL" });
		expect(created.status).toBe(200);
		expect((await api(`/api/automations?id=${created.json?.id ?? ""}`, { method: "DELETE" })).status).toBe(200);

		expect((await api("/api/goal?sessionId=1", { method: "DELETE" })).status).toBe(200);

		const doc = await post<{ ok?: boolean; id?: number; vectorized?: number; pending?: number }>("/api/kb", {
			title: "冷启动文档",
			content: "冷启动入库正文",
		});
		expect(doc.status).toBe(200);
		expect(doc.json).toMatchObject({ ok: true, vectorized: 0, pending: 0 });
		expect((await api(`/api/kb?id=${doc.json?.id ?? 0}`, { method: "DELETE" })).status).toBe(200);

		expect((await api("/api/memories?all=1", { method: "DELETE" })).status).toBe(200);

		expect(await harnessOpens()).toBe(before);
	});

	it("观测点自证：需要 Harness 的路由会抬高 opens", async () => {
		const before = await harnessOpens();
		const res = await api("/api/bootstrap?sessionId=1");
		expect(res.status).toBe(200);
		expect(await harnessOpens()).toBeGreaterThan(before);
	});
});

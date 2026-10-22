import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * 阶段 3 / NERE-22 验收：清空 persist 后，`/s/*` 不触发 Harness `open()`。
 * 观测点是 DO 的 `/debug/harness`（只在 TEST_HARNESS_STATS=1 时存在，自身不 open）。
 */

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.SHARE_COLD_TEST_PORT ?? 18801);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-share-cold");

let proc: ChildProcess | null = null;

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 响应（分享页 HTML / 404 纯文本）
	}
	return { status: res.status, json, text };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function harnessOpens(): Promise<number> {
	const res = await api("/api/debug/harness");
	expect(res.status).toBe(200);
	return (res.json as { opens: number }).opens;
}

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
			"--var",
			"DEMO_SHARE_URL:/s/demo-demo-demo",
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

describe("清空 persist 后的首个分享页请求", () => {
	it("未知 token 直接 404，且不启动 Harness（NERE-22）", async () => {
		// 本文件第一个 DO 请求就是 /s/：之前只有 worker 层 /api/auth 探针（不进 DO）。
		const page = await api("/s/doesnotexist");
		expect(page.status).toBe(404);
		expect(page.text).toBe("分享链接不存在或已失效");
		expect(await harnessOpens()).toBe(0);
	});

	it("文件分享在冷启动下可读，读页不增加 Harness 计数", async () => {
		const content = "# 冷启动分享\n\n正文";
		await post("/api/restore", {
			version: 1,
			data: { files: [{ conversation_id: "1", name: "cold.md", content, updated_at: new Date().toISOString() }] },
		});
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "cold.md", ttlSeconds: 0 });
		expect(created.status).toBe(200);

		const before = await harnessOpens();
		// 观测点自证：上面的 /api/restore 与 /api/share 都走 legacy/dispatch 的 open()。
		expect(before).toBeGreaterThan(0);
		const page = await api(`/s/${(created.json as { token: string }).token}`);
		expect(page.status).toBe(200);
		expect(page.text).toContain('<h1 id="冷启动分享">冷启动分享</h1>');
		expect(page.text).toContain("正文");
		expect(await harnessOpens()).toBe(before);
	});

	it("会话分享仍正常渲染（只有它的渲染路径读 Harness 条目）", async () => {
		const createdSession = await post("/api/sessions", {});
		const sessionId = (createdSession.json as { id: string }).id;
		const created = await post("/api/share", { sessionId, kind: "conversation", ttlSeconds: 0 });
		expect(created.status).toBe(200);

		const page = await api(`/s/${(created.json as { token: string }).token}`);
		expect(page.status).toBe(200);
		expect(page.text).toContain('class="thread"');
		expect(page.text).toContain("（暂无内容）");
		await api(`/api/sessions?id=${sessionId}`, { method: "DELETE" });
	});
});

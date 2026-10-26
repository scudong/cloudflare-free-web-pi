import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI } from "../helpers/fakeOpenAI";
import { stopServer } from "./teardown";

/**
 * NERE-84 验收（端到端，假模型）：
 * `fresh_session=1` 的定时任务每次运行都新建会话，历史不再跨轮累积；
 * `fresh_session=0` 保持旧行为（固定会话）。alarm 的三态由
 * `tests/unit/automation-last-status.test.ts` 覆盖，这里走真实的 `/automations/run` +
 * session 创建路径，确认组合根与迁移接得上。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.AUTOMATION_FRESH_TEST_PORT ?? 18803);
const FAKE_PORT = Number(process.env.AUTOMATION_FRESH_FAKE_PORT ?? 18899);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-automation-fresh");

let proc: ChildProcess | null = null;
const fake = startFakeOpenAI(FAKE_PORT);

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// 非 JSON 响应
	}
	return { status: res.status, json, text };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const patch = (path: string, body: unknown) =>
	api(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

async function automationRow(id: string): Promise<Record<string, unknown>> {
	const { json } = await api("/api/automations");
	const rows = (json?.automations ?? []) as Record<string, unknown>[];
	const row = rows.find((item) => item.id === id);
	expect(row, `automation ${id} 应出现在列表里`).toBeTruthy();
	return row!;
}

async function assistantCount(sessionId: string): Promise<number> {
	const { json } = await api(`/api/entries?sessionId=${sessionId}`);
	if (!Array.isArray(json)) return 0;
	return (json as { kind?: string }[]).filter((entry) => entry.kind === "pi.assistant").length;
}

async function runNow(id: string): Promise<string> {
	const res = await post("/api/automations/run", { id });
	expect(res.status, res.text).toBe(200);
	const sessionId = String(res.json?.sessionId ?? "");
	expect(sessionId).not.toBe("");
	return sessionId;
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	await fake.listen();
	proc = spawn(
		"npx",
		["wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT), "--var", "ACCESS_PASSWORD:", "--var", "CF_DISABLE_VECTOR:1", "--persist-to", STATE],
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

describe("定时任务会话隔离（NERE-84）", () => {
	it("连续两次运行各建一个会话，last_session_id 指向第二次，历史不跨轮累积", async () => {
		fake.setSteps([{ text: "第一份日报" }, { text: "第二份日报" }]);
		const created = await post("/api/automations", {
			name: "科技日报",
			prompt: "整理今天的科技新闻",
			schedule: { kind: "interval", minutes: 60 },
		});
		expect(created.status).toBe(200);
		const id = String(created.json?.id ?? "");
		expect(await automationRow(id)).toMatchObject({ fresh_session: 1, last_session_id: null });

		const first = await runNow(id);
		expect(await automationRow(id)).toMatchObject({
			session_id: first,
			last_session_id: first,
			last_status: "ok",
			last_error: null,
		});

		const second = await runNow(id);
		expect(second).not.toBe(first);
		expect(await automationRow(id)).toMatchObject({ session_id: second, last_session_id: second, last_status: "ok" });

		// 每轮一个独立会话：第二次的会话里只有本轮的一条 assistant entry。
		expect(await assistantCount(first)).toBe(1);
		expect(await assistantCount(second)).toBe(1);
	});

	it("fresh_session=0 保持旧行为：每轮都写同一个会话", async () => {
		fake.setSteps([{ text: "固定会话第一轮" }, { text: "固定会话第二轮" }]);
		const session = await post("/api/sessions", {});
		const sessionId = String(session.json?.id ?? "");
		expect(sessionId).not.toBe("");

		const created = await post("/api/automations", {
			name: "固定会话任务",
			prompt: "说一句话",
			sessionId,
			schedule: { kind: "interval", minutes: 60 },
		});
		const id = String(created.json?.id ?? "");
		const off = await patch("/api/automations", { id, fresh_session: false });
		expect(off.status, off.text).toBe(200);
		expect(off.json?.automation).toMatchObject({ fresh_session: false, last_session_id: null });

		expect(await runNow(id)).toBe(sessionId);
		expect(await runNow(id)).toBe(sessionId);
		expect(await automationRow(id)).toMatchObject({
			session_id: sessionId,
			last_session_id: sessionId,
			fresh_session: 0,
			last_status: "ok",
		});
		expect(await assistantCount(sessionId)).toBe(2);
	});
});

/**
 * NERE-85 验收（端到端，假 provider）：
 * 上游一次断流不再报废整轮；3 次尝试都失败时错误摘要进 `last_error`，
 * 且重试只发生在 fetch 包装层（不会叠加 pi-durable 的整轮重试）。
 */
describe("provider 断流重试（NERE-85）", () => {
	async function createAutomation(name: string): Promise<string> {
		const created = await post("/api/automations", {
			name,
			prompt: "跑一轮日报",
			schedule: { kind: "interval", minutes: 60 },
		});
		expect(created.status).toBe(200);
		return String(created.json?.id ?? "");
	}

	it("第一次连接失败、第二次成功：一轮完成，任务状态 ok 且只有一条回答", async () => {
		const id = await createAutomation("断流重试任务");
		fake.setSteps([{ text: "重试之后的日报" }]);
		const before = fake.droppedCount();
		fake.dropNext(1);

		const sessionId = await runNow(id);
		expect(fake.droppedCount() - before).toBe(1);
		expect(await assistantCount(sessionId)).toBe(1);
		expect(await automationRow(id)).toMatchObject({ last_status: "ok", last_error: null, last_session_id: sessionId });
	});

	it("一直连不上：3 次尝试后失败，原因写进 last_error", async () => {
		const id = await createAutomation("持续断流任务");
		const before = fake.droppedCount();
		fake.dropNext(3);

		const startedAt = Date.now();
		const res = await post("/api/automations/run", { id });
		const elapsed = Date.now() - startedAt;

		expect(res.status, res.text).toBe(500);
		expect(res.text).toContain("model_error");
		// 恰好 3 次连接：再多的重试会浪费按量计费的配额。
		expect(fake.droppedCount() - before).toBe(3);
		// 500ms + 2s 的退避确实发生了。
		expect(elapsed).toBeGreaterThanOrEqual(2400);
		const row = await automationRow(id);
		expect(row).toMatchObject({ last_status: "failed" });
		expect(String(row.last_error)).toContain("Connection error");
		expect(String(row.last_error)).toContain("model_error");
	});
});

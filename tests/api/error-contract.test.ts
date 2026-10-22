import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * 统一错误契约（NERE-79）：四条历史 ApiError 路径都必须返回
 * `{ error, code }`，状态码与 code 一致，且不回传内部异常文本。
 * 兼容字段（kb 的 ok/message、skills 的 ok/installed）同时保留。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.ERROR_CONTRACT_TEST_PORT ?? 8807);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-error-contract");

let proc: ChildProcess | null = null;

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text) as unknown;
	} catch {
		// 非 JSON 响应
	}
	return { status: res.status, json, text };
}

function body(json: unknown): Record<string, unknown> {
	if (json === null || typeof json !== "object") throw new Error("响应不是 JSON 对象");
	return json as Record<string, unknown>;
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const patch = (path: string, body: unknown) =>
	api(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** 统一字段 + 不泄漏内部异常：精确文案断言，排除堆栈 / TypeError 等。 */
function expectContract(json: Record<string, unknown>, code: string, message: string) {
	expect(json.code).toBe(code);
	expect(json.error).toBe(message);
	expect(json.error).not.toMatch(/TypeError|ReferenceError|SyntaxError|Error:|[[:space:]]at[[:space:]]/i);
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
		await new Promise((resolve) => setTimeout(resolve, 800));
	}
	throw new Error("wrangler dev 未在超时内就绪");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	proc = spawn(
		"npx",
		[
			"wrangler", "dev",
			"--config", "wrangler.test.jsonc",
			"--port", String(PORT),
			"--var", "ACCESS_PASSWORD:",
			"--var", "CF_DISABLE_VECTOR:1",
			"--persist-to", STATE,
		],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
});

describe("统一错误契约（NERE-79）", () => {
	it("KbIngestError：415 + unsupported_type，保留 ok/message", async () => {
		const { status, json } = await api("/api/kb/ingest", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "not a file",
		});
		expect(status).toBe(415);
		const payload = body(json);
		expectContract(payload, "unsupported_type", "请用 multipart/form-data 上传文件，或用 application/json 传 {url}。");
		expect(payload.ok).toBe(false);
		expect(payload.message).toBe("请用 multipart/form-data 上传文件，或用 application/json 传 {url}。");
	});

	it("SkillApiError：400 + bad_request，保留 ok/installed", async () => {
		const { status, json } = await post("/api/skills/import", {});
		expect(status).toBe(400);
		const payload = body(json);
		expectContract(payload, "bad_request", "需要 url，或 manifest + content");
		expect(payload.ok).toBe(false);
		expect(payload.installed).toBe(false);
	});

	it("AutomationApiError：400 + bad_request", async () => {
		const { status, json } = await patch("/api/automations", { id: "missing", schedule: { kind: "weekly" } });
		expect(status).toBe(400);
		expectContract(body(json), "bad_request", "调度类型需为 daily 或 interval");
	});

	it("SettingsApiError：400 + bad_request", async () => {
		const { status, json } = await post("/api/providers", { name: "x" });
		expect(status).toBe(400);
		expectContract(body(json), "bad_request", "需要名称与 http(s) 地址");
	});

	it("未知路径 404 也走统一错误体", async () => {
		const { status, json } = await api("/api/does-not-exist");
		expect(status).toBe(404);
		expectContract(body(json), "not_found", "not found");
	});
});

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 多用户隔离（v0.45.0）：知识库与文件都落在各自 DO，
 * 这个文件专门跑「有密码」模式，验证邀请码用户看不到主人的数据。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.MULTIUSER_TEST_PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-multi");
const PASSWORD = "golden-owner-pass";

let proc: ChildProcess | null = null;
let ownerCookie = "";
let userCookie = "";
let userId = "";

async function call(path: string, init: RequestInit = {}, cookie = ownerCookie) {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	const res = await fetch(`${BASE}${path}`, { ...init, headers });
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 响应
	}
	const setCookie = res.headers.get("set-cookie") ?? "";
	return { status: res.status, json, text, cookie: setCookie.split(";")[0] ?? "" };
}

const post = (path: string, body: unknown, cookie?: string) =>
	call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, cookie);

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
		["wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT), "--var", `ACCESS_PASSWORD:${PASSWORD}`, "--var", "CF_DISABLE_VECTOR:1", "--persist-to", STATE],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();

	const login = await post("/api/login", { password: PASSWORD }, "");
	ownerCookie = login.cookie;
	expect(ownerCookie).toMatch(/^pi_access=/);

	const created = await post("/api/users", { name: "隔离用户" });
	userId = created.json.user.id as string;
	const invite = created.json.code as string;
	const userLogin = await post("/api/login", { password: invite }, "");
	userCookie = userLogin.cookie;
	expect(userCookie).toMatch(/^pi_access=u_/);
});

afterAll(() => {
	if (proc?.pid) {
		try {
			process.kill(-proc.pid, "SIGTERM");
		} catch {
			proc.kill("SIGTERM");
		}
	}
	rmSync(STATE, { recursive: true, force: true });
});

describe("多用户隔离", () => {
	it("未登录访问知识库被拒绝", async () => {
		const res = await call("/api/kb", {}, "");
		expect(res.status).toBe(401);
	});

	it("知识库各自独立", async () => {
		const ownerAdd = await post("/api/kb", { title: "主人资料", content: "只有主人能看到的久期笔记" });
		expect(ownerAdd.json.id).toBeGreaterThan(0);

		const userBefore = await call("/api/kb", {}, userCookie);
		expect(userBefore.json.docs).toEqual([]);

		const userAdd = await post("/api/kb", { title: "用户资料", content: "用户自己的城投笔记" }, userCookie);
		expect(userAdd.json.id).toBeGreaterThan(0);

		const ownerSearch = await call(`/api/kb/search?q=${encodeURIComponent("用户")}`, {}, ownerCookie);
		expect(ownerSearch.json.hits).toEqual([]);

		const userSearch = await call(`/api/kb/search?q=${encodeURIComponent("主人")}`, {}, userCookie);
		expect(userSearch.json.hits).toEqual([]);

		const userDocs = await call("/api/kb", {}, userCookie);
		expect(userDocs.json.docs.map((d: { title: string }) => d.title)).toEqual(["用户资料"]);
	});

	it("文件总览只包含自己的文件", async () => {
		await post("/api/restore", {
			version: 1,
			data: { files: [{ conversation_id: "1", name: "owner-only.md", content: "# owner", updated_at: new Date().toISOString() }] },
		});
		const userSession = await post("/api/sessions", {}, userCookie);
		await post(
			"/api/restore",
			{ version: 1, data: { files: [{ conversation_id: userSession.json.id, name: "user-only.md", content: "# user", updated_at: new Date().toISOString() }] } },
			userCookie,
		);

		const ownerFiles = await call("/api/files/all", {});
		expect(ownerFiles.json.files.map((f: { name: string }) => f.name)).toEqual(["owner-only.md"]);

		const userFiles = await call("/api/files/all", {}, userCookie);
		expect(userFiles.json.files.map((f: { name: string }) => f.name)).toEqual(["user-only.md"]);
	});

	it("普通用户不能管理用户", async () => {
		const res = await call("/api/users", {}, userCookie);
		expect(res.status).toBe(403);
	});

	it("删除用户后其会话失效", async () => {
		const removed = await call(`/api/users?id=${userId}`, { method: "DELETE" }, ownerCookie);
		expect(removed.json.ok).toBe(true);
		const after = await call("/api/kb", {}, userCookie);
		expect(after.status).toBe(401);
	});
});

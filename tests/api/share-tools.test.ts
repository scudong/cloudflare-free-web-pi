import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI, type FakeStep } from "../helpers/fakeOpenAI";
import { stopServer } from "./teardown";

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.SHARE_TEST_PORT ?? 18799);
const FAKE_PORT = Number(process.env.SHARE_FAKE_PORT ?? 18898);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-share");
const PASSWORD = "share-test-pass";

let proc: ChildProcess | null = null;
const fake = startFakeOpenAI(FAKE_PORT);
let cookie = "";

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 响应
	}
	return { status: res.status, json, text };
}

/** JSON 对象字段读取：只在确实是对象时取字段。 */
function obj(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
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
		await new Promise((r) => setTimeout(r, 800));
	}
	throw new Error("wrangler dev 未在超时内就绪");
}

/** 把 SSE 文本拆成 { event, data }。 */
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

async function newSession(): Promise<string> {
	const created = await post("/api/sessions", {});
	const id = str(obj(created.json)?.id);
	expect(id).toBeTruthy();
	const model = await post("/api/model", { sessionId: id, modelId: "fake" });
	expect(model.status).toBe(200);
	return id;
}

async function chat(sessionId: string, message: string) {
	const res = await fetch(`${BASE}/api/chat/stream`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ message, sessionId }),
	});
	expect(res.status).toBe(200);
	return parseSse(await res.text());
}

/** 非流式：`POST /api/chat` 返回 { answer, tools }。 */
async function chatOnce(sessionId: string, message: string): Promise<string> {
	const res = await post("/api/chat", { message, sessionId });
	expect(res.status).toBe(200);
	return str(obj(res.json)?.answer);
}

/** 会话标题（sessions_meta 经 `GET /api/sessions` 暴露）。 */
async function titleOf(sessionId: string): Promise<string> {
	const list = await api("/api/sessions");
	const rows = arr(obj(list.json)?.sessions).map(obj);
	const row = rows.find((item) => item && item.id === sessionId);
	return str(row?.title);
}

type ShareInfo = { url: string; expiresAt: number; reused: boolean; name: string; kind: string };

function shareEnds(events: { event: string; data: Record<string, unknown> }[]): { share: ShareInfo }[] {
	const found: { share: ShareInfo }[] = [];
	for (const item of events) {
		if (item.event !== "tool_end" || item.data.name !== "share_file") continue;
		const details = item.data.details;
		if (!details || typeof details !== "object" || !("share" in details)) continue;
		const share = details.share;
		if (!share || typeof share !== "object" || !("url" in share) || typeof share.url !== "string") continue;
		found.push({
			share: {
				url: share.url,
				expiresAt: "expiresAt" in share && typeof share.expiresAt === "number" ? share.expiresAt : 0,
				reused: "reused" in share && share.reused === true,
				name: "name" in share && typeof share.name === "string" ? share.name : "",
				kind: "kind" in share && typeof share.kind === "string" ? share.kind : "",
			},
		});
	}
	return found;
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	await fake.listen();
	proc = spawn(
		"npx",
		[
			"wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT),
			"--var", `ACCESS_PASSWORD:${PASSWORD}`, "--var", "CF_DISABLE_VECTOR:1", "--persist-to", STATE,
		],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();

	const login = await fetch(`${BASE}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	expect(login.status).toBe(200);
	cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	expect(cookie).toContain("=");

	const provider = await post("/api/providers", {
		id: "fake",
		name: "Fake OpenAI",
		baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`,
		apiKey: "sk-fake",
		models: "fake",
	});
	expect(provider.status).toBe(200);
	const activated = await post("/api/providers/activate", { id: "fake" });
	expect(activated.status).toBe(200);
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
	await fake.close();
});

describe("分享工具（端到端，假模型）", () => {
	const STARTER_PROMPT = "请根据我接下来提供的内容写一份本周周报，并生成一个可分享的链接。";

	it("只说写周报时，instructions 要求收尾询问是否分享且不自动分享", async () => {
		const dbg = await api(`/api/debug/agent?sessionId=1&message=${encodeURIComponent("写一份这周的周报")}`);
		const instructions = str(obj(dbg.json)?.instructions);
		expect(instructions).toContain("可交付文档");
		expect(instructions).toContain("是否需要分享链接");
		expect(instructions).toContain("不要自动分享");
	});

	it("未说分享：write_file 结果提示可用 share_file，追问后才生成链接", async () => {
		fake.setSteps([
			{ tool: { name: "write_file", args: { name: "weekly-ask.md", content: "# 本周周报\n\n- 完成分享提示" } } },
			{ text: "周报写好了，要我生成分享链接吗？" },
		]);
		const sid = await newSession();
		const events = await chat(sid, "写一份这周的周报");

		const writeEnd = events.find((item) => item.event === "tool_end" && item.data.name === "write_file");
		expect(str(writeEnd?.data.summary)).toContain("share_file");
		expect(str(events.find((item) => item.event === "done")?.data.answer)).toContain("要我生成分享链接吗");
		expect(shareEnds(events)).toHaveLength(0);

		fake.setSteps([
			{ tool: { name: "share_file", args: { name: "weekly-ask.md" } } },
			{ text: "链接好了。" },
		]);
		const shares = shareEnds(await chat(sid, "要"));
		expect(shares).toHaveLength(1);
		expect(shares[0]!.share).toMatchObject({ name: "weekly-ask.md", kind: "file" });
	});

	it("起步卡第 1 张：一条消息内产出文件 + 链接卡，重复分享复用 token", async () => {
		fake.setSteps([
			{ tool: { name: "write_file", args: { name: "weekly.md", content: "# 本周周报\n\n- 完成分享工具" } } },
			{ tool: { name: "share_file", args: { name: "weekly.md" } } },
			{ tool: { name: "share_file", args: { name: "weekly.md" } } },
			{ text: "周报和分享链接都好了。" },
		]);
		const sid = await newSession();
		const events = await chat(sid, STARTER_PROMPT);

		const shares = shareEnds(events);
		expect(shares).toHaveLength(2);
		const first = shares[0]!.share;
		expect(first).toMatchObject({ kind: "file", name: "weekly.md", reused: false });
		expect(shares[1]!.share).toMatchObject({ url: first.url, reused: true });

		const files = await api(`/api/files?sessionId=${sid}`);
		const names = arr(obj(files.json)?.files).map((file) => str(obj(file)?.name));
		expect(names).toContain("weekly.md");

		const page = await fetch(first.url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("本周周报");

		const list = await api(`/api/shares?sessionId=${sid}&kind=file&name=weekly.md`);
		expect(arr(obj(list.json)?.shares)).toHaveLength(1);
	});

	it("ttlSeconds 很短时链接到期返回 410", async () => {
		fake.setSteps([
			{ tool: { name: "write_file", args: { name: "expire.md", content: "# 会过期" } } },
			{ tool: { name: "share_file", args: { name: "expire.md", ttlSeconds: 0.05 } } },
			{ text: "链接有效期很短。" },
		]);
		const sid = await newSession();
		const shares = shareEnds(await chat(sid, "生成一个很快过期的分享链接"));
		expect(shares).toHaveLength(1);
		const share = shares[0]!.share;
		expect(share.expiresAt).toBeGreaterThan(0);

		// 集成测试必须等真实时钟越过服务端 expires_at，不能用假定时器替代。
		await new Promise((resolve) => setTimeout(resolve, 200));
		const page = await fetch(share.url);
		expect(page.status).toBe(410);
		expect(await page.text()).toContain("分享链接已过期");
	});

	it("分享工具设为 ask：出现待审批，拒绝后提示已取消且不生成链接", async () => {
		await post("/api/settings", { approvalTools: { share_file: "ask" } });
		try {
			fake.setSteps([
				{ tool: { name: "write_file", args: { name: "denied.md", content: "# 不分享" } } },
				{ tool: { name: "share_file", args: { name: "denied.md" } } },
				{ text: "等你确认。" },
			]);
			const sid = await newSession();
			const events = await chat(sid, "生成周报并分享");
			expect(shareEnds(events)).toHaveLength(0);
			const pending = await api(`/api/approvals?sessionId=${sid}`);
			const approval = arr(obj(pending.json)?.approvals)[0];
			expect(obj(approval)).toMatchObject({ tool: "share_file" });

			const denied = await post("/api/approvals", { id: obj(approval)?.id, action: "deny" });
			expect(denied.status).toBe(200);
			expect(str(obj(denied.json)?.resume)).toContain("已取消分享");

			const list = await api(`/api/shares?sessionId=${sid}&kind=file&name=denied.md`);
			expect(arr(obj(list.json)?.shares)).toEqual([]);
		} finally {
			await post("/api/settings", { approvalTools: { share_file: "follow" } });
		}
	});

	it("不传 ttlSeconds 用设置的默认有效期，页脚带署名与生成时间", async () => {
		await post("/api/settings", { displayName: "董长阳", shareTtlSeconds: 3600 });
		try {
			fake.setSteps([
				{ tool: { name: "write_file", args: { name: "default.md", content: "# 默认有效期" } } },
				{ tool: { name: "share_file", args: { name: "default.md" } } },
				{ text: "已按默认有效期分享。" },
			]);
			const sid = await newSession();
			const shares = shareEnds(await chat(sid, "分享这份文件"));
			const share = shares[0]!.share;
			const remaining = share.expiresAt - Date.now();
			expect(remaining).toBeGreaterThan(3_500_000);
			expect(remaining).toBeLessThanOrEqual(3_600_000);

			const html = await (await fetch(share.url)).text();
			expect(html).toContain("由 董长阳 分享");
			expect(html).toContain("生成于");
			expect(html).toContain("链接有效期至");
		} finally {
			await post("/api/settings", { displayName: "", shareTtlSeconds: 604800 });
		}
	});
});

describe("对话提交路径（NERE-33：/chat 与 /chat/stream 共用 chat-service）", () => {
	it("同一输入下流式与非流式返回相同助手文本，并写入相同的 sessions_meta.title", async () => {
		const prompt = "同一个问题";
		const reply = "这是同一条回答。";

		fake.setSteps([{ text: reply }]);
		const plain = await newSession();
		const plainAnswer = await chatOnce(plain, prompt);
		expect(plainAnswer).toBe(reply);

		fake.setSteps([{ text: reply }]);
		const streamed = await newSession();
		const events = await chat(streamed, prompt);
		const done = events.find((event) => event.event === "done");
		expect(str(done?.data.answer)).toBe(plainAnswer);

		expect(await titleOf(plain)).toBe(prompt);
		expect(await titleOf(streamed)).toBe(await titleOf(plain));
	});
});

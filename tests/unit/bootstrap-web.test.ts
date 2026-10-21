import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_KEYS, api, type BootstrapResponse } from "../../src/web/lib/api";
import { parseBootstrap } from "../../src/web/lib/bootstrap";
import { BOOTSTRAP_KEYS as BACKEND_BOOTSTRAP_KEYS } from "../../src/worker/bootstrap";

/** 与后端 tests/unit/bootstrap.test.ts 相同的字段集合，另加真实场景里的嵌套结构。 */
const FULL = {
	session: { ok: true, name: "pi-harness-spike" },
	entries: [{ kind: "pi.user", content: "你好" }],
	sessions: [{ id: "1", title: "默认会话", created_at: "2026-10-21T00:00:00.000Z" }],
	files: [{ name: "report.md", size: 12, updated_at: "2026-10-21T00:00:00.000Z" }],
	memories: [{ id: 3, content: "记住：中文优先", created_at: "2026-10-21T00:00:00.000Z", source: "manual" }],
	approvals: [{ id: 7, tool: "write_file", category: "write", args: "{}", created_at: "2026-10-21T00:00:00.000Z" }],
	settings: {
		webSearch: true,
		kbPrefetch: false,
		kbRetrieval: "hybrid",
		thinkingLevel: "high",
		displayName: "fan",
		shareTtlSeconds: 0,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 2, backgroundTokens: 3 },
		approval: { read: "allow", write: "ask", exec: "deny" },
	},
	plan: [
		{ title: "先读代码", status: "in_progress" },
		{ title: "再改代码", status: "weird-status" },
	],
	goal: { objective: "把首屏切到 bootstrap", status: "active", tokenBudget: 1000, tokensUsed: 10, turns: 1, maxTurns: 5 },
	questions: [{ id: 9, title: "选一个", questions: [{ id: "q1", question: "A 还是 B？" }] }],
	prompts: [{ name: "总结", description: "", content: "总结 $1" }],
	rules: [{ name: "中文", content: "用中文回答", enabled: true }],
	customTools: [{ name: "echo", description: "", parameters: "{}", code: "return 1" }],
	skills: [{ name: "review", description: "评审", content: "按清单评审" }],
	automations: [{ id: "a1", name: "早报", prompt: "总结昨天", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1 }],
	mcpServers: [{ id: "m1", name: "deepwiki", url: "https://example.com/mcp", created_at: "2026-10-21T00:00:00.000Z" }],
	models: { models: ["deepseek-flash", "other-model"], default: "deepseek-flash" },
	errors: {},
} satisfies BootstrapResponse;

const PARTIAL = {
	session: null,
	entries: [],
	sessions: [],
	files: [],
	memories: [],
	approvals: [],
	settings: null,
	plan: [],
	goal: null,
	questions: [],
	prompts: [],
	rules: [],
	customTools: [],
	skills: [],
	automations: [],
	mcpServers: [],
	models: null,
	errors: { files: "vfs_v2: no such table", skills: "skill table locked" },
} satisfies BootstrapResponse;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseBootstrap · 完整响应", () => {
	it("17 个面板都转成领域模型，errors 为空", () => {
		const panels = parseBootstrap(FULL);
		expect(panels.session).toEqual({ ok: true, name: "pi-harness-spike" });
		expect(panels.entries).toHaveLength(1);
		expect(panels.sessions[0]?.title).toBe("默认会话");
		expect(panels.files[0]?.name).toBe("report.md");
		expect(panels.memories[0]?.content).toContain("中文优先");
		expect(panels.approvals[0]?.tool).toBe("write_file");
		expect(panels.settings?.kbRetrieval).toBe("hybrid");
		expect(panels.plan).toEqual([
			{ title: "先读代码", status: "in_progress" },
			{ title: "再改代码", status: "pending" },
		]);
		expect(panels.goal?.objective).toBe("把首屏切到 bootstrap");
		expect(panels.questions[0]?.questions).toHaveLength(1);
		expect(panels.prompts[0]?.name).toBe("总结");
		expect(panels.rules[0]?.enabled).toBe(true);
		expect(panels.customTools[0]?.name).toBe("echo");
		expect(panels.skills[0]?.name).toBe("review");
		expect(panels.automations[0]?.scheduleLabel).toBe("每天 09:00");
		expect(panels.mcpServers[0]?.url).toBe("https://example.com/mcp");
		expect(panels.models).toEqual({ models: ["deepseek-flash", "other-model"], default: "deepseek-flash" });
		expect(panels.errors).toEqual({});
	});
});

describe("parseBootstrap · 逐面板容错", () => {
	it("失败面板回退空态，错误摘要原样保留", () => {
		const panels = parseBootstrap(PARTIAL);
		expect(panels.session).toEqual({ ok: false, name: "" });
		expect(panels.files).toEqual([]);
		expect(panels.memories).toEqual([]);
		expect(panels.skills).toEqual([]);
		expect(panels.settings).toBeNull();
		expect(panels.goal).toBeNull();
		expect(panels.models).toEqual({ models: [], default: "" });
		expect(panels.errors).toEqual({ files: "vfs_v2: no such table", skills: "skill table locked" });
	});

	it("字段缺失 / 类型不符时给空态，不抛错", () => {
		const panels = parseBootstrap({
			settings: null,
			entries: { entries: [{ kind: "pi.user", content: "旧格式包装" }] },
			models: { models: ["only-one"] },
			errors: { files: 42 },
		} as unknown as BootstrapResponse);
		expect(panels.entries).toHaveLength(1);
		expect(panels.models).toEqual({ models: ["only-one"], default: "only-one" });
		expect(panels.sessions).toEqual([]);
		expect(panels.plan).toEqual([]);
		expect(panels.errors).toEqual({});
	});

	it("全是空对象也能解析出可渲染的空态", () => {
		const panels = parseBootstrap({} as BootstrapResponse);
		expect(panels.session).toEqual({ ok: false, name: "" });
		expect(panels.entries).toEqual([]);
		expect(panels.approvals).toEqual([]);
		expect(panels.questions).toEqual([]);
		expect(panels.mcpServers).toEqual([]);
		expect(panels.models).toEqual({ models: [], default: "" });
	});
});

describe("api.bootstrap", () => {
	it("请求带 sessionId，响应走统一 JSON 客户端", async () => {
		const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(PARTIAL), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const raw = await api.bootstrap("42");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/bootstrap?sessionId=42");
		expect(raw.errors).toEqual({ files: "vfs_v2: no such table", skills: "skill table locked" });
	});

	it("整体失败仍然抛 ApiError，由 hook 转成页面错误态", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "未登录" }), { status: 401 })));
		await expect(api.bootstrap("1")).rejects.toMatchObject({ status: 401 });
	});
});

describe("端到端约束", () => {
	it("前端字段清单与后端 BOOTSTRAP_KEYS 一致", () => {
		expect([...BOOTSTRAP_KEYS]).toEqual([...BACKEND_BOOTSTRAP_KEYS]);
	});

	it("App.tsx 不再调用被 bootstrap 取代的单端点", () => {
		const app = readFileSync(new URL("../../src/web/App.tsx", import.meta.url), "utf8");
		const retired = [
			"session",
			"sessions",
			"entries",
			"files",
			"memories",
			"plan",
			"goal",
			"prompts",
			"rules",
			"customTools",
			"skills",
			"automations",
			"mcpServers",
		];
		for (const method of retired) {
			expect(app, `App.tsx 仍在调用 api.${method}()`).not.toMatch(new RegExp(`api\\.${method}\\(`));
		}
		expect(app).toMatch(/api\.bootstrap|useBootstrap/);
	});
});

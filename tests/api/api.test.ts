import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.TEST_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state");

let proc: ChildProcess | null = null;

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 响应（如导出 Markdown）
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
		await new Promise((r) => setTimeout(r, 800));
	}
	throw new Error("wrangler dev 未在超时内就绪");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	proc = spawn(
		"npx",
		["wrangler", "dev", "--port", String(PORT), "--var", "ACCESS_PASSWORD:", "--persist-to", STATE],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
}, 180_000);

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

describe("访问控制", () => {
	it("未配置密码时 auth 返回无需登录", async () => {
		const { json } = await api("/api/auth");
		expect(json).toEqual({ required: false, authenticated: true });
	});
});

describe("会话", () => {
	it("新建 → 列表 → 改名 → 删除", async () => {
		const created = await post("/api/sessions", {});
		const id = created.json.id as string;
		expect(id).toBeTruthy();

		const list1 = await api("/api/sessions");
		expect(list1.json.sessions.some((s: { id: string }) => s.id === id)).toBe(true);

		await api("/api/sessions", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, title: "改名后" }),
		});
		const list2 = await api("/api/sessions");
		expect(list2.json.sessions.find((s: { id: string }) => s.id === id)?.title).toBe("改名后");

		await api(`/api/sessions?id=${id}`, { method: "DELETE" });
		const list3 = await api("/api/sessions");
		expect(list3.json.sessions.some((s: { id: string }) => s.id === id)).toBe(false);
	});
});

describe("设置", () => {
	it("思考档位读写", async () => {
		const before = await api("/api/settings");
		expect(["off", "low", "high"]).toContain(before.json.thinkingLevel);

		const set = await post("/api/settings", { thinkingLevel: "high" });
		expect(set.json.thinkingLevel).toBe("high");

		const after = await api("/api/settings");
		expect(after.json.thinkingLevel).toBe("high");

		await post("/api/settings", { thinkingLevel: "low" });
	});

	it("非法档位被忽略", async () => {
		await post("/api/settings", { thinkingLevel: "ultra" });
		const after = await api("/api/settings");
		expect(["off", "low", "high"]).toContain(after.json.thinkingLevel);
	});
});

describe("模型供应商", () => {
	it("新增 → 启用 → 模型列表跟随 → 切回默认 → 删除", async () => {
		const empty = await api("/api/providers");
		expect(empty.json.active).toBe("");
		expect(Array.isArray(empty.json.providers)).toBe(true);

		const created = await post("/api/providers", {
			name: "测试供应商",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-golden-0001",
			models: "model-a, model-b",
		});
		expect(created.json.ok).toBe(true);
		const id = created.json.id as string;

		const list = await api("/api/providers");
		const item = list.json.providers.find((p: { id: string }) => p.id === id);
		expect(item).toMatchObject({ name: "测试供应商", models: ["model-a", "model-b"] });
		// 密钥只回传掩码
		expect(item.keyHint).toBe("••••0001");
		expect(JSON.stringify(list.json)).not.toContain("sk-golden-0001");

		await post("/api/providers/activate", { id });
		const models = await api("/api/models");
		expect(models.json.models).toEqual(["model-a", "model-b"]);
		expect(models.json.provider).toBe(id);

		await post("/api/providers/activate", { id: "" });
		const back = await api("/api/models");
		expect(back.json.provider).toBe("deepseek");

		await api(`/api/providers?id=${id}`, { method: "DELETE" });
		const after = await api("/api/providers");
		expect(after.json.providers.some((p: { id: string }) => p.id === id)).toBe(false);
	});

	it("缺少 API Key 的新增被拒绝", async () => {
		const res = await post("/api/providers", { name: "无密钥", baseUrl: "https://x.example.com", models: "m" });
		expect(res.status).toBe(400);
	});

	it("激活不存在的供应商返回 404", async () => {
		const res = await post("/api/providers/activate", { id: "not-exist" });
		expect(res.status).toBe(404);
	});
});

describe("技能", () => {
	it("新增 → 列表 → 删除", async () => {
		await post("/api/skills", { name: "golden-skill", description: "回归用", content: "# 指令\n1. 做点什么" });
		const list = await api("/api/skills");
		expect(list.json.skills.some((s: { name: string }) => s.name === "golden-skill")).toBe(true);

		await api("/api/skills?name=golden-skill", { method: "DELETE" });
		const after = await api("/api/skills");
		expect(after.json.skills.some((s: { name: string }) => s.name === "golden-skill")).toBe(false);
	});
});

describe("提示模板", () => {
	it("新增 → 列表 → 删除", async () => {
		const created = await post("/api/prompts", { name: "golden-prompt", description: "回归用", content: "总结 $1" });
		expect(created.json.ok).toBe(true);

		const list = await api("/api/prompts");
		const item = list.json.prompts.find((p: { name: string }) => p.name === "golden-prompt");
		expect(item).toMatchObject({ description: "回归用", content: "总结 $1" });

		await api("/api/prompts?name=golden-prompt", { method: "DELETE" });
		const after = await api("/api/prompts");
		expect(after.json.prompts.some((p: { name: string }) => p.name === "golden-prompt")).toBe(false);
	});

	it("缺内容被拒绝", async () => {
		const res = await post("/api/prompts", { name: "bad" });
		expect(res.status).toBe(400);
	});
});

describe("规则文件", () => {
	it("新增 → 启用/停用 → 删除", async () => {
		await post("/api/rules", { name: "golden-rule", content: "始终用中文回答" });
		const list1 = await api("/api/rules");
		const rule = list1.json.rules.find((r: { name: string }) => r.name === "golden-rule");
		expect(rule).toMatchObject({ enabled: true, content: "始终用中文回答" });

		await api("/api/rules", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "golden-rule", enabled: false }),
		});
		const list2 = await api("/api/rules");
		expect(list2.json.rules.find((r: { name: string }) => r.name === "golden-rule")?.enabled).toBe(false);

		await api("/api/rules?name=golden-rule", { method: "DELETE" });
		const list3 = await api("/api/rules");
		expect(list3.json.rules.some((r: { name: string }) => r.name === "golden-rule")).toBe(false);
	});
});

describe("能力注册表", () => {
	it("返回内置 / 数据 / 协议三组", async () => {
		const { json } = await api("/api/capabilities");
		const keys = (json.groups ?? []).map((g: { key: string }) => g.key);
		expect(keys).toEqual(["builtin", "data", "protocol"]);

		const builtinIds = json.groups[0].items.map((i: { id: string }) => i.id);
		expect(builtinIds).toEqual(expect.arrayContaining(["codemode", "compaction", "plan", "subagents", "web_search"]));

		const dataIds = json.groups[1].items.map((i: { id: string }) => i.id);
		expect(dataIds).toEqual(["skills", "prompts", "rules"]);
	});

	it("计数随数据变化", async () => {
		await post("/api/prompts", { name: "count-prompt", content: "x" });
		const { json } = await api("/api/capabilities");
		const promptsItem = json.groups[1].items.find((i: { id: string }) => i.id === "prompts");
		expect(promptsItem.count).toBeGreaterThanOrEqual(1);
		await api("/api/prompts?name=count-prompt", { method: "DELETE" });
	});
});

describe("记忆库", () => {
	it("恢复写入 → 一键清空", async () => {
		await post("/api/restore", {
			version: 1,
			data: { memories: [{ content: "金标用例写入的记忆", created_at: new Date().toISOString(), source: "manual" }] },
		});
		const withMemory = await api("/api/memories");
		expect(withMemory.json.memories.length).toBeGreaterThan(0);

		const cleared = await api("/api/memories?all=1", { method: "DELETE" });
		expect(cleared.json.ok).toBe(true);
		expect(cleared.json.deleted).toBeGreaterThan(0);

		const after = await api("/api/memories");
		expect(after.json.memories).toEqual([]);
	});
});

describe("备份与恢复", () => {
	it("备份包含各类数据键", async () => {
		const { json } = await api("/api/backup");
		expect(json.version).toBe(1);
		for (const key of ["memories", "files", "automations", "mcpServers", "sessions", "skills", "settings", "plans", "providers", "prompts", "rules"]) {
			expect(json.data).toHaveProperty(key);
		}
	});

	it("恢复后能读回供应商", async () => {
		const res = await post("/api/restore", {
			version: 1,
			data: {
				providers: [
					{ id: "golden-provider", name: "恢复的供应商", base_url: "https://api.restore.test/v1", api_key: "sk-restore", models: "r1" },
				],
			},
		});
		expect(res.json.counts.providers).toBe(1);

		const list = await api("/api/providers");
		expect(list.json.providers.some((p: { id: string }) => p.id === "golden-provider")).toBe(true);

		await api("/api/providers?id=golden-provider", { method: "DELETE" });
	});
});

describe("文件分享", () => {
	const MD = "# 分享测试\n\n**重点** 与 `code`\n\n- 第一条\n- 第二条\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |";
	const HTML = '<!doctype html><html><body><h1 id="shared">HTML 分享</h1><script>document.title="ok"</script></body></html>';

	beforeAll(async () => {
		await post("/api/restore", {
			version: 1,
			data: {
				files: [
					{ conversation_id: "1", name: "share-test.md", content: MD, updated_at: new Date().toISOString() },
					{ conversation_id: "1", name: "share-test.html", content: HTML, updated_at: new Date().toISOString() },
				],
			},
		});
	});

	it("Markdown 生成带域名的链接并渲染", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 3600 });
		expect(created.status).toBe(200);
		expect(created.json.ok).toBe(true);
		const url = new URL(created.json.url as string);
		expect(url.protocol).toBe("http:");
		expect(url.host).toBeTruthy();
		expect(url.pathname).toMatch(/^\/s\/[a-z0-9]+$/);
		expect(created.json.expiresAt).toBeGreaterThan(Date.now());

		const page = await fetch(created.json.url);
		const html = await page.text();
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<h1>分享测试</h1>");
		expect(html).toContain("<strong>重点</strong>");
		expect(html).toContain("<li>第一条</li>");
		expect(html).toContain("<table>");
		expect(html).toContain("链接有效期至");
		// 未指定主题时回落深色（Arco 深色底）
		expect(html).toContain("--bg:#17171a");
	});

	it("分享页记录主题，?theme= 可覆盖", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-test.md",
			ttlSeconds: 3600,
			theme: "light",
		});
		const light = await (await fetch(created.json.url)).text();
		expect(light).toContain("--bg:#f7f8fa");
		expect(light).toContain("color-scheme:light");

		const sepia = await (await fetch(`${created.json.url}?theme=sepia`)).text();
		expect(sepia).toContain("--bg:#fcf8ec");

		// 未知主题参数不生效，仍用分享时记录的浅色
		const fallback = await (await fetch(`${created.json.url}?theme=dracula`)).text();
		expect(fallback).toContain("--bg:#f7f8fa");
	});

	it("HTML 原样输出并带 sandbox CSP", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.html", ttlSeconds: 0 });
		expect(created.json.expiresAt).toBe(0);

		const page = await fetch(created.json.url);
		const body = await page.text();
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(page.headers.get("content-security-policy")).toContain("sandbox");
		expect(body).toContain('<h1 id="shared">HTML 分享</h1>');
	});

	it("过期后返回 410", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 0.05 });
		expect(created.json.expiresAt).toBeGreaterThan(0);
		await new Promise((resolve) => setTimeout(resolve, 120));

		const page = await fetch(created.json.url);
		expect(page.status).toBe(410);
		expect(await page.text()).toContain("分享链接已过期");
	});

	it("已生成的链接可复用", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-test.md",
			ttlSeconds: 3600,
			theme: "light",
		});
		const list = await api("/api/shares?sessionId=1&kind=file&name=share-test.md");
		expect(list.status).toBe(200);
		const item = (list.json.shares as { token: string; url: string; expiresAt: number; theme: string }[]).find(
			(entry) => entry.token === created.json.token,
		);
		expect(item).toBeTruthy();
		expect(item?.url).toContain(`/s/${created.json.token}`);
		expect(item?.expiresAt).toBeGreaterThan(Date.now());
		expect(item?.theme).toBe("light");
	});

	it("过期链接不再出现在复用列表", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 0.05 });
		await new Promise((resolve) => setTimeout(resolve, 120));
		const list = await api("/api/shares?sessionId=1&kind=file&name=share-test.md");
		expect(
			(list.json.shares as { token: string }[]).some((entry) => entry.token === created.json.token),
		).toBe(false);
	});

	it("文件不存在时拒绝生成", async () => {
		const res = await post("/api/share", { sessionId: "1", kind: "file", name: "no-such-file.md", ttlSeconds: 3600 });
		expect(res.status).toBe(400);
		expect(res.json.error).toContain("文件不存在");
	});

	it("会话分享也能列出", async () => {
		const createdSession = await post("/api/sessions", {});
		const id = createdSession.json.id as string;
		const shared = await post("/api/share", { sessionId: id, kind: "conversation", ttlSeconds: 0 });
		const list = await api(`/api/shares?sessionId=${id}&kind=conversation`);
		expect(list.status).toBe(200);
		expect((list.json.shares as { token: string }[]).some((entry) => entry.token === shared.json.token)).toBe(true);
		await api(`/api/sessions?id=${id}`, { method: "DELETE" });
	});

	it("未知 token 返回 404", async () => {
		const page = await fetch(`${BASE}/s/doesnotexist`);
		expect(page.status).toBe(404);
	});
});

describe("工具注册（防回归）", () => {
	it("关键工具都已注册给模型", async () => {
		const { json } = await api("/api/debug/agent");
		const tools: string[] = json.tools ?? [];
		for (const name of ["dispatch_tasks", "update_plan", "web_search", "web_fetch_page", "write_file", "codemode", "remember", "recall"]) {
			expect(tools).toContain(name);
		}
		// 目标模式（v0.31.0）
		for (const name of ["set_goal", "complete_goal", "report_goal"]) {
			expect(tools).toContain(name);
		}
	});

	it("子代理工具暴露可用工具清单", async () => {
		const { json } = await api("/api/debug/agent");
		const callable: string[] = json.callable ?? [];
		// codemode 脚本能调用的工具（callers 含 tools）
		expect(callable).toContain("web_search");
		expect(callable).toContain("write_file");
	});
});

describe("计划", () => {
	it("空计划返回空数组", async () => {
		const { json } = await api("/api/plan?sessionId=1");
		expect(Array.isArray(json.steps)).toBe(true);
	});
});

describe("目标模式", () => {
	it("初始为空", async () => {
		const { json } = await api("/api/goal?sessionId=1");
		expect(json.goal).toBeNull();
	});

	it("空目标被拒绝", async () => {
		const { status, json } = await post("/api/goal", { sessionId: "1", objective: "  " });
		expect(status).toBe(400);
		expect(json.ok).toBe(false);
	});

	it("建立 → 读取 → 停止", async () => {
		const created = await post("/api/goal", {
			sessionId: "1",
			objective: "写完对比报告",
			tokenBudget: 50000,
			maxTurns: 5,
		});
		expect(created.json.ok).toBe(true);
		expect(created.json.goal.status).toBe("active");
		expect(created.json.goal.objective).toBe("写完对比报告");
		expect(created.json.goal.tokenBudget).toBe(50000);
		expect(created.json.goal.maxTurns).toBe(5);

		const read = await api("/api/goal?sessionId=1");
		expect(read.json.goal.status).toBe("active");

		const stopped = await api("/api/goal?sessionId=1", { method: "DELETE" });
		expect(stopped.json.ok).toBe(true);
		expect(stopped.json.goal.status).toBe("paused");
	});

	it("重复建立会覆盖旧目标", async () => {
		await post("/api/goal", { sessionId: "1", objective: "第一版", tokenBudget: 20000 });
		const second = await post("/api/goal", { sessionId: "1", objective: "第二版", tokenBudget: 30000 });
		expect(second.json.goal.objective).toBe("第二版");
		expect(second.json.goal.status).toBe("active");
		expect(second.json.goal.tokensUsed).toBe(0);
		await api("/api/goal?sessionId=1", { method: "DELETE" });
	});
});

describe("会话分支", () => {
	it("无效 entryId 被拒绝", async () => {
		const res = await post("/api/branches", { sessionId: "1", entryId: 0 });
		expect(res.status).toBe(400);
	});

	it("创建分支 → 记录来源 → 子会话带历史", async () => {
		const created = await post("/api/sessions", {});
		const sid: string = created.json.id;
		await post("/api/reset", { sessionId: sid });
		await post("/api/reset", { sessionId: sid });

		const entries = await api(`/api/entries?sessionId=${sid}`);
		const ids: number[] = entries.json.map((e: { id: number }) => e.id);
		const maxId = Math.max(...ids);

		const res = await post("/api/branches", { sessionId: sid, entryId: maxId });
		expect(res.json.ok).toBe(true);
		const childId: string = res.json.id;
		expect(childId).not.toBe(sid);

		const sessions = await api("/api/sessions");
		const child = sessions.json.sessions.find((s: { id: string }) => s.id === childId);
		expect(child.parent_id).toBe(sid);
		expect(child.fork_at).toBeGreaterThan(0);
		expect(child.fork_at).toBeLessThan(maxId);

		// 分叉点之前的历史被继承，且不包含被点的那条消息
		const childEntries = await api(`/api/entries?sessionId=${childId}`);
		expect(childEntries.json.length).toBeGreaterThan(0);
		expect(Math.max(...childEntries.json.map((e: { id: number }) => e.id))).toBeLessThanOrEqual(child.fork_at);

		await api(`/api/sessions?id=${childId}`, { method: "DELETE" });
		await api(`/api/sessions?id=${sid}`, { method: "DELETE" });
	});
});

describe("生成中插话", () => {
	it("空插话被拒绝", async () => {
		const res = await post("/api/interject", { sessionId: "1", message: "   " });
		expect(res.status).toBe(400);
		expect(res.json.ok).toBe(false);
	});
});

describe("交互式问答（ask_user）", () => {
	it("待回答问题默认为空", async () => {
		const { json } = await api("/api/questions?sessionId=1");
		expect(Array.isArray(json.questions)).toBe(true);
	});

	it("缺少问题 id 被拒绝", async () => {
		const bad = await post("/api/questions", { answers: [] });
		expect(bad.status).toBe(400);
	});

	it("不存在的问题返回 404", async () => {
		const missing = await post("/api/questions", { id: 999999, answers: [{ id: "q1", choice: "a" }] });
		expect(missing.status).toBe(404);
	});

	it("ask_user 工具已注册", async () => {
		const { json } = await api("/api/debug/agent");
		expect(json.tools).toContain("ask_user");
	});
});

describe("自定义工具", () => {
	it("非法工具名被拒绝", async () => {
		const bad = await post("/api/custom-tools", { name: "1bad", code: "return 1" });
		expect(bad.status).toBe(400);
	});

	it("内置工具名被拒绝", async () => {
		const bad = await post("/api/custom-tools", { name: "codemode", code: "return 1" });
		expect(bad.status).toBe(400);
		expect(bad.json.error).toContain("内置");
	});

	it("参数 schema 必须是对象", async () => {
		const bad = await post("/api/custom-tools", { name: "bad_schema", parameters: "[1,2]", code: "return 1" });
		expect(bad.status).toBe(400);
	});

	it("空代码被拒绝", async () => {
		const bad = await post("/api/custom-tools", { name: "no_code", code: "   " });
		expect(bad.status).toBe(400);
	});

	it("新增 → 列表 → 工具清单可见（exec 级）→ 删除", async () => {
		const created = await post("/api/custom-tools", {
			name: "test_tool",
			description: "测试用",
			parameters: JSON.stringify({ type: "object", properties: { x: { type: "number" } } }),
			code: "return { doubled: Number(args.x ?? 0) * 2 };",
		});
		expect(created.json.ok).toBe(true);
		expect(created.json.tools).toBe(1);

		const list = await api("/api/custom-tools");
		expect(list.json.tools.map((t: { name: string }) => t.name)).toContain("test_tool");

		const tools = await api("/api/tools");
		const entry = tools.json.tools.find((t: { name: string }) => t.name === "test_tool");
		expect(entry).toMatchObject({ category: "exec" });

		const del = await api("/api/custom-tools?name=test_tool", { method: "DELETE" });
		expect(del.json.ok).toBe(true);
		const after = await api("/api/custom-tools");
		expect(after.json.tools.map((t: { name: string }) => t.name)).not.toContain("test_tool");
	});
});

describe("工具审批", () => {
	it("工具清单带分级，默认全部放行", async () => {
		const { json } = await api("/api/tools");
		expect(json.approval).toEqual({ read: "allow", write: "allow", exec: "allow" });
		const byName = new Map(json.tools.map((t: { name: string; category: string; policy: string }) => [t.name, t]));
		expect(byName.get("read_file")).toMatchObject({ category: "read", policy: "allow" });
		expect(byName.get("write_file")).toMatchObject({ category: "write" });
		expect(byName.get("codemode")).toMatchObject({ category: "exec" });
		expect(byName.get("dispatch_tasks")).toMatchObject({ category: "exec" });
	});

	it("改分级策略后生效策略跟随", async () => {
		await post("/api/settings", { approval: { write: "ask" } });
		const { json } = await api("/api/tools");
		expect(json.approval.write).toBe("ask");
		const writeTool = json.tools.find((t: { name: string }) => t.name === "write_file");
		expect(writeTool.policy).toBe("ask");
		// 其它档位不受影响
		expect(json.tools.find((t: { name: string }) => t.name === "read_file").policy).toBe("allow");
	});

	it("逐工具覆盖优先于分级", async () => {
		await post("/api/settings", { approvalTools: { write_file: "allow" } });
		const { json } = await api("/api/tools");
		expect(json.tools.find((t: { name: string }) => t.name === "write_file").policy).toBe("allow");
		await post("/api/settings", { approvalTools: { write_file: "follow" }, approval: { write: "allow" } });
	});

	it("非法与不存在的审批决定被拒绝", async () => {
		const bad = await post("/api/approvals", { id: 0, action: "once" });
		expect(bad.status).toBe(400);
		const missing = await post("/api/approvals", { id: 999999, action: "once" });
		expect(missing.status).toBe(404);
	});

	it("待审批列表默认空", async () => {
		const { json } = await api("/api/approvals?sessionId=1");
		expect(Array.isArray(json.approvals)).toBe(true);
	});
});

describe("导出与版本", () => {
	it("导出 Markdown 返回文本", async () => {
		const res = await fetch(`${BASE}/api/export?format=md&sessionId=1`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/markdown");
	});

	it("版本接口返回构建号", async () => {
		const { json } = await api("/api/version");
		expect(typeof json.build).toBe("string");
	});
});

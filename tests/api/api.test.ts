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

describe("工具注册（防回归）", () => {
	it("关键工具都已注册给模型", async () => {
		const { json } = await api("/api/debug/agent");
		const tools: string[] = json.tools ?? [];
		for (const name of ["dispatch_tasks", "update_plan", "web_search", "web_fetch_page", "write_file", "codemode", "remember", "recall"]) {
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

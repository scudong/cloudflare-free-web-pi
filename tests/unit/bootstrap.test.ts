import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_KEYS, collectBootstrap, type BootstrapLoaders } from "../../src/worker/bootstrap";
import { AppError } from "../../src/worker/http/errors";

const VALUES: Record<string, unknown> = {
	session: { ok: true, name: "pi-harness-spike" },
	entries: [{ id: 1, kind: "pi.user" }],
	sessions: [{ id: "1", title: "默认会话" }],
	files: [{ name: "a.md", size: 3 }],
	memories: [{ id: 1, content: "记住" }],
	approvals: [{ id: 1, tool: "write_file" }],
	settings: { webSearch: true },
	plan: [{ title: "第一步", status: "pending" }],
	goal: { objective: "做完" },
	questions: [{ id: 1, questions: [] }],
	prompts: [{ name: "总结", content: "总结 $1" }],
	rules: [{ name: "r", content: "中文", enabled: true }],
	customTools: [{ name: "echo" }],
	skills: [{ name: "s" }],
	automations: [{ id: "a1" }],
	mcpServers: [{ id: "m1" }],
	models: { models: ["deepseek-flash"], default: "deepseek-flash" },
};

function loaders(overrides: Partial<Record<string, () => unknown>> = {}): BootstrapLoaders {
	const out = {} as Record<string, () => unknown>;
	for (const key of BOOTSTRAP_KEYS) out[key] = () => VALUES[key];
	return { ...out, ...overrides } as BootstrapLoaders;
}

describe("首屏聚合 collectBootstrap", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("全部面板成功时原样返回，errors 为空", async () => {
		const payload = await collectBootstrap(loaders());
		for (const key of BOOTSTRAP_KEYS) expect(payload[key]).toEqual(VALUES[key]);
		expect(payload.errors).toEqual({});
	});

	it("单个数组面板失败：该字段回退空数组，errors 只给稳定码，不回传异常原文", async () => {
		const payload = await collectBootstrap(
			loaders({
				files: () => {
					throw new Error("vfs_v2: no such table");
				},
			}),
		);
		expect(payload.files).toEqual([]);
		expect(payload.errors).toEqual({ files: "internal_error" });
		expect(JSON.stringify(payload)).not.toContain("vfs_v2");
		expect(payload.entries).toEqual(VALUES.entries);
		expect(payload.settings).toEqual(VALUES.settings);
	});

	it("单个对象面板失败：该字段回退 null，异步拒绝同样被隔离", async () => {
		const payload = await collectBootstrap(
			loaders({ settings: () => Promise.reject(new Error("app_settings locked")) }),
		);
		expect(payload.settings).toBeNull();
		expect(payload.errors).toEqual({ settings: "internal_error" });
		expect(payload.memories).toEqual(VALUES.memories);
	});

	it("非 Error 抛出与非 503 AppError 都收敛为 internal_error", async () => {
		const payload = await collectBootstrap(
			loaders({
				skills: () => {
					throw "x".repeat(500);
				},
				prompts: () => {
					throw new AppError("bad_request", 400, "bad");
				},
			}),
		);
		expect(payload.skills).toEqual([]);
		expect(payload.prompts).toEqual([]);
		expect(payload.errors).toEqual({ skills: "internal_error", prompts: "internal_error" });
	});

	it("依赖不可用（Harness 会话失败 / 503）报 unavailable，原文仍只进日志", async () => {
		const sessionFailed = new Error("Session failed after a storage error; close and reopen it");
		sessionFailed.name = "SessionFailed";
		const payload = await collectBootstrap(
			loaders({
				entries: () => {
					throw sessionFailed;
				},
				settings: () => {
					throw new AppError("unavailable", 503, "upstream down");
				},
			}),
		);
		expect(payload.entries).toEqual([]);
		expect(payload.errors).toEqual({ entries: "unavailable", settings: "unavailable" });
		expect(JSON.stringify(payload)).not.toContain("storage error");
	});

	it("多个面板同时失败互不影响", async () => {
		const payload = await collectBootstrap(
			loaders({
				entries: async () => {
					throw new Error("harness down");
				},
				mcpServers: async () => {
					throw new Error("mcp table missing");
				},
			}),
		);
		expect(payload.entries).toEqual([]);
		expect(payload.mcpServers).toEqual([]);
		expect(payload.errors).toEqual({ entries: "internal_error", mcpServers: "internal_error" });
		expect(payload.sessions).toEqual(VALUES.sessions);
		expect(payload.models).toEqual(VALUES.models);
	});
});

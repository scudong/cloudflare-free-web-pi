import { describe, expect, it, vi } from "vitest";
import type { Harness } from "@earendil-works/pi-durable";
import type { SqlHandle } from "../../src/worker/db/migrations";
import { buildContext, type AppEnv } from "../../src/worker/http/context";
import { AppError } from "../../src/worker/http/errors";
import { dispatch } from "../../src/worker/routes";
import type { Route } from "../../src/worker/http/router";
import type { SessionRuntime } from "../../src/worker/services/session-service";

const sql: SqlHandle = { exec: () => ({ toArray: () => [] }) };
const env = {} as AppEnv;
/** 只为类型占位：buildContext 不触碰 Harness 成员。 */
const harness = {} as Harness;
const sessionRuntime: SessionRuntime = {
	entries: async () => [],
	createConversation: async () => "1",
	forkBefore: async () => ({ id: "2", parentId: "1", at: 1 }),
	rootId: async () => "1",
	scanConversationIds: async () => [],
	modelFor: () => "deepseek-flash",
	pauseGoal: () => {},
};

function context(overrides: Partial<Parameters<typeof buildContext>[0]> = {}) {
	return buildContext({
		req: new Request("https://pi.example/chat?x=1"),
		env,
		scopeId: "agent-1",
		userKey: "owner",
		origin: "https://pi.example",
		sql,
		ensureMigrated: async () => {},
		open: async () => harness,
		legacy: async () => new Response("legacy"),
		sessionRuntime,
		settings: { get: (_key, fallback) => fallback },
		webFetch: async () => ({ ok: false, kind: "error", message: "stub" }),
		...overrides,
	});
}

describe("buildContext", () => {
	it("暴露请求字段与已迁移 SQL 句柄", () => {
		const ctx = context();
		expect(ctx.url.pathname).toBe("/chat");
		expect(ctx.url.search).toBe("?x=1");
		expect(ctx.origin).toBe("https://pi.example");
		expect(ctx.scopeId).toBe("agent-1");
		expect(ctx.userKey).toBe("owner");
		expect(ctx.sql()).toBe(sql);
	});

	it("ready() 委托 ensureMigrated，harness() 惰性 open", async () => {
		const ensureMigrated = vi.fn(async () => {});
		const open = vi.fn(async () => harness);
		const ctx = context({ ensureMigrated, open });
		expect(open).not.toHaveBeenCalled();
		await ctx.ready();
		expect(ensureMigrated).toHaveBeenCalledTimes(1);
		await ctx.harness();
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("legacy() 委托旧 handler", async () => {
		const ctx = context();
		expect(await (await ctx.legacy()).text()).toBe("legacy");
	});
});

describe("dispatch", () => {
	const route = (overrides: Partial<Route> = {}): Route => ({
		method: "GET",
		path: "/chat",
		needsHarness: true,
		handle: async () => new Response("routed", { status: 200 }),
		...overrides,
	});

	it("未命中走 legacy", async () => {
		const ctx = context();
		expect(await (await dispatch(ctx, [])).text()).toBe("legacy");
	});

	it("命中后按 ready → harness → handle 顺序执行", async () => {
		const calls: string[] = [];
		const ctx = context({
			ensureMigrated: async () => {
				calls.push("ready");
			},
			open: async () => {
				calls.push("harness");
				return harness;
			},
		});
		const res = await dispatch(ctx, [
			route({
				handle: async () => {
					calls.push("handle");
					return new Response("routed");
				},
			}),
		]);
		expect(await res.text()).toBe("routed");
		expect(calls).toEqual(["ready", "harness", "handle"]);
	});

	it("needsHarness=false 不 open", async () => {
		const open = vi.fn(async () => harness);
		const ctx = context({ open });
		await dispatch(ctx, [route({ needsHarness: false })]);
		expect(open).not.toHaveBeenCalled();
	});

	it("AppError 走映射，未知异常保持 500 截断", async () => {
		const bad = await dispatch(context(), [
			route({
				handle: async () => {
					throw new AppError("bad_request", 400, "参数错误");
				},
			}),
		]);
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "参数错误" });

		const unknown = await dispatch(context(), [
			route({
				handle: async () => {
					throw new Error("boom");
				},
			}),
		]);
		expect(unknown.status).toBe(500);
		expect(await unknown.json()).toEqual({ error: "Error: boom" });
	});
});

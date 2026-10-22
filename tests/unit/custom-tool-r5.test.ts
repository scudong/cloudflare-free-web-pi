import { describe, expect, it, vi } from "vitest";
import type { SqlHandle } from "../../src/worker/db/migrations";
import { buildExtension as buildCustomTools, saveTool, CustomToolApiError } from "../../src/worker/services/custom-tool-service";
import { buildExtension as buildMcp, type McpCache } from "../../src/worker/services/mcp-service";

// 自定义工具服务会在模块加载时引用 workerd 专属的 QuickJS 沙箱，node 单测里替换掉。
vi.mock("@earendil-works/pi-codemode/cloudflare", () => ({
	createInlineCodemodeSandbox: () => ({ execute: async () => ({ ok: false }) }),
}));

/** 极简 SQL 替身：仓储只用到 `exec(...).toArray()`。 */
function fakeSql(handler: (query: string) => unknown[]): SqlHandle {
	return {
		exec(query: string) {
			return { toArray: () => handler(query) };
		},
	} as unknown as SqlHandle;
}

const toolRow = (name: string) => ({ name, description: "", parameters: "{}", code: "return 1" });

describe("R5：自定义工具名集合按实例隔离", () => {
	it("两次构建不会互相覆盖对方的集合", () => {
		const owner = new Set<string>();
		const user = new Set<string>();
		buildCustomTools(fakeSql(() => [toolRow("owner_tool")]), owner);
		buildCustomTools(fakeSql(() => [toolRow("user_tool")]), user);

		expect([...owner]).toEqual(["owner_tool"]);
		expect([...user]).toEqual(["user_tool"]);
	});

	it("重建时清空旧名（删掉工具后不再参与分级）", () => {
		const names = new Set<string>();
		const sql = fakeSql(() => [toolRow("old_tool")]);
		buildCustomTools(sql, names);
		buildCustomTools(fakeSql(() => []), names);
		expect([...names]).toEqual([]);
	});
});

describe("R5：MCP 缓存由调用方显式传入", () => {
	const server = { id: "s1", name: "Server", url: "https://mcp.example.com", headers: "{}" };
	const mcpSql = fakeSql((query) => (query.includes("FROM mcp_servers") ? [server] : []));

	it("命中传入的缓存，不建立新连接", async () => {
		const cache: McpCache = new Map([
			["s1", { client: {} as never, tools: [{ name: "ping" }, { name: "pong" }] }],
		]);
		const ext = await buildMcp(mcpSql, cache);
		expect(ext?.tools?.length).toBe(2);
	});

	it("两个缓存各自持有不同的连接结果", async () => {
		const owner: McpCache = new Map([["s1", { client: {} as never, tools: [{ name: "owner_tool" }] }]]);
		const user: McpCache = new Map([["s1", { client: {} as never, tools: [{ name: "user_tool" }, { name: "user_tool_2" }] }]]);
		expect((await buildMcp(mcpSql, owner))?.tools?.length).toBe(1);
		expect((await buildMcp(mcpSql, user))?.tools?.length).toBe(2);
	});
});

describe("自定义工具写入校验", () => {
	it("保留名与非法 code 走 400", () => {
		const names = new Set<string>();
		const sql = fakeSql(() => []);
		expect(() => saveTool(sql, { name: "read_file", code: "return 1" }, names)).toThrow(CustomToolApiError);
		expect(() => saveTool(sql, { name: "probe", code: "" }, names)).toThrow(CustomToolApiError);
	});
});

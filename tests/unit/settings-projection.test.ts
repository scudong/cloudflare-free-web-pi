import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import type { AppEnv, RequestContext } from "../../src/worker/http/context";
import { requestSettings } from "../../src/worker/http/context";
import { capabilityRoutes } from "../../src/worker/routes/capabilities";
import { get as getSetting, listAll, set as setSetting } from "../../src/worker/repo/settings-repo";
import { readBootstrap } from "../../src/worker/services/bootstrap-service";

/**
 * NERE-82 P2-2 验收：`/bootstrap` 的 13 条设置读取合成 1 条，
 * `/tools` 的 SQL 数与工具数无关。
 */

type Stats = { selects: number; appSettings: number; queries: string[] };

function measuringSql(db: DatabaseSync): { sql: SqlHandle; stats: Stats } {
	const stats: Stats = { selects: 0, appSettings: 0, queries: [] };
	return {
		stats,
		sql: {
			exec(query, ...bindings) {
				if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
					db.exec(query);
					return { toArray: () => [] };
				}
				const rows = db.prepare(query).all(...(bindings as never[]));
				if (/^\s*SELECT\b/i.test(query)) {
					stats.selects += 1;
					if (query.includes("FROM app_settings")) stats.appSettings += 1;
					stats.queries.push(query);
				}
				return { toArray: () => rows };
			},
		},
	};
}

const sessionRuntime = {
	entries: async () => ({ conversationId: "1", items: [] }),
	createConversation: async () => "1",
	forkBefore: async () => ({ id: "2", parentId: "1", at: 1 }),
	rootId: async () => "1",
	scanConversationIds: async () => [],
	modelFor: () => "deepseek-flash",
	pauseGoal: () => {},
};

function setup() {
	const db = new DatabaseSync(":memory:");
	const { sql, stats } = measuringSql(db);
	migrate(sql);
	return { db, sql, stats };
}

function reset(stats: Stats): void {
	stats.selects = 0;
	stats.appSettings = 0;
	stats.queries = [];
}

function settingsPort(sql: SqlHandle) {
	return requestSettings({
		get: (key, fallback) => getSetting(sql, key, fallback),
		snapshot: () => Object.fromEntries(listAll(sql).map((row) => [row.key, row.value])),
	});
}

describe("设置读取投影（NERE-82 P2-2）", () => {
	it("/bootstrap 只读一次 app_settings，总 SELECT 数 ≤ 18", async () => {
		const { db, sql, stats } = setup();
		for (let i = 0; i < 13; i++) setSetting(sql, `key_${i}`, String(i));

		reset(stats);
		const payload = await readBootstrap(
			{ sql, settings: settingsPort(sql), env: {} as AppEnv, sessionRuntime },
			"1",
		);
		expect(payload.errors).toEqual({});
		// 1 条 listAll（settingsView）+ 1 条 active_provider（models 面板）。
		expect(stats.appSettings).toBe(2);
		expect(stats.selects).toBeLessThanOrEqual(18);
		db.close();
	});

	it("/tools 的 app_settings 查询数与工具数无关", async () => {
		const { db, sql, stats } = setup();
		setSetting(sql, "approval_read", "ask");
		const route = capabilityRoutes.find((item) => item.method === "GET" && item.path === "/tools")!;

		const run = async (count: number) => {
			const names = Array.from({ length: count }, (_, i) => `tool_${i}`);
			reset(stats);
			const res = await route.handle({
				req: new Request("https://pi.example/tools"),
				url: new URL("https://pi.example/tools"),
				env: {} as AppEnv,
				sql: () => sql,
				settings: settingsPort(sql),
				toolRuntime: { names: () => names, customNames: () => [] },
			} as unknown as RequestContext);
			expect(res.status).toBe(200);
			expect(stats.appSettings).toBe(1);
		};

		await run(3);
		await run(60);
		db.close();
	});
});

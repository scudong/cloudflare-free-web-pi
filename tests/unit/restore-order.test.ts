import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { listPrompts } from "../../src/worker/repo/prompts-repo";
import { get as getSetting } from "../../src/worker/repo/settings-repo";
import { createDataService } from "../../src/worker/services/data-service";

/** NERE-82 nit：restore 必须在写入 settings / prompts 之后再重建扩展。 */

function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

describe("restore 顺序（NERE-82 nit）", () => {
	it("afterRestore 能看到刚恢复的 settings 与 prompts，且早于 alarm", async () => {
		const db = new DatabaseSync(":memory:");
		const sql = sqlHandle(db);
		migrate(sql);

		const seen: string[] = [];
		const service = createDataService({
			sql,
			kb: { backupDocs: () => [], hasDoc: () => false } as never,
			runtime: {
				afterRestore: async () => {
					seen.push(`settings=${getSetting(sql, "restore_probe", "")}`);
					seen.push(`prompts=${listPrompts(sql).length}`);
				},
			} as never,
			alarm: {
				schedule: async () => {
					seen.push("alarm");
				},
			},
		});

		const counts = await service.restore({
			version: 1,
			data: {
				settings: [{ key: "restore_probe", value: "ready" }],
				prompts: [{ name: "周报模板", description: "", content: "写周报" }],
			},
		});

		expect(counts).toMatchObject({ settings: 1, prompts: 1 });
		expect(seen).toEqual(["settings=ready", "prompts=1", "alarm"]);
		db.close();
	});
});

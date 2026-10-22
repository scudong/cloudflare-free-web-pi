import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { RULES_VERSION } from "../../src/worker/lib/skill-audit";
import { upsertSkill } from "../../src/worker/repo/skills-repo";
import { buildInstructions } from "../../src/worker/services/instructions-service";
import { createSkillService } from "../../src/worker/services/skill-service";

/**
 * NERE-82 P2-1 验收：`/skills/hub` 与提示词技能索引只读元数据列，
 * 100 个技能时读取字节数应与正文体积无关（一个量级下降）。
 */

type SqlStats = { selects: number; bytes: number; queries: string[] };

/** 与其它单测相同的 SqlHandle 包装，另外统计 SELECT 的返回字节。 */
function measuringSql(db: DatabaseSync): { sql: SqlHandle; stats: SqlStats } {
	const stats: SqlStats = { selects: 0, bytes: 0, queries: [] };
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
					stats.bytes += JSON.stringify(rows).length;
					stats.queries.push(query);
				}
				return { toArray: () => rows };
			},
		},
	};
}

const CONTENT = "正文用于说明技能步骤。".repeat(1200); // ~13 KB
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;

function auditReport() {
	return JSON.stringify({
		status: "pass",
		reasons: [],
		detected: { runtime: "prompt", network: [], tools: [] },
		auditedAt: "2026-10-22T00:00:00Z",
		hash: CONTENT_HASH,
		rulesVersion: RULES_VERSION,
		auditSource: "local",
	});
}

function seed(sql: SqlHandle, count: number): void {
	for (let i = 0; i < count; i++) {
		upsertSkill(sql, {
			name: `skill-${String(i).padStart(3, "0")}`,
			description: `技能 ${i} 的用途说明`,
			content: CONTENT,
			version: "1.0.0",
			source: "local",
			author: "hou",
			license: "MIT",
			runtime: "prompt",
			tags: ["utility"],
			contentHash: CONTENT_HASH,
			auditStatus: "pass",
			auditReport: auditReport(),
			manifest: JSON.stringify({ name: `skill-${i}`, version: "1.0.0", runtime: "prompt", requires: { tools: [], bindings: [], network: [] } }),
			createdAt: "2026-10-22T00:00:00Z",
			updatedAt: "2026-10-22T00:00:00Z",
		});
	}
}

function reset(stats: SqlStats): void {
	stats.selects = 0;
	stats.bytes = 0;
	stats.queries = [];
}

describe("技能投影（NERE-82 P2-1）", () => {
	it("hub 只读元数据：100 个技能时读取字节数比全量行小一个量级以上", async () => {
		const db = new DatabaseSync(":memory:");
		const { sql, stats } = measuringSql(db);
		migrate(sql);
		seed(sql, 100);
		const service = createSkillService({ sql, settings: { get: (_key, fallback) => fallback } });
		const fullBytes = JSON.stringify(db.prepare("SELECT * FROM skills").all()).length;

		reset(stats);
		const hub = await service.hub({ installed: "1", limit: "100" });
		expect(hub.skills).toHaveLength(100);
		expect(stats.queries.some((query) => query.includes("FROM skills") && query.includes(", content,"))).toBe(false);
		expect(stats.bytes * 10).toBeLessThan(fullBytes);
		db.close();
	});

	it("提示词技能索引只读元数据", async () => {
		const db = new DatabaseSync(":memory:");
		const { sql, stats } = measuringSql(db);
		migrate(sql);
		seed(sql, 100);
		const kb = { prefetch: async () => ({ block: "", refs: [] }) };
		const fullBytes = JSON.stringify(db.prepare("SELECT * FROM skills").all()).length;

		reset(stats);
		const result = await buildInstructions({ sql, settings: { get: (_key, fallback) => fallback }, kb: kb as never }, null);
		expect(result.instructions).toContain("skill-000");
		expect(stats.queries.some((query) => query.includes("FROM skills") && query.includes(", content,"))).toBe(false);
		expect(stats.bytes * 10).toBeLessThan(fullBytes);
		db.close();
	});
});

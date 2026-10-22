import type { SqlHandle } from "../db/migrations";

/**
 * 只读面板辅助仓储（ADR-0001 §3）：`/capabilities` 需要 prompts / rules 的条目数。
 * 这两个表的完整 CRUD 属于其它域，本文件只提供计数，避免 capabilities 服务内联 SQL。
 */
export function countPrompts(sql: SqlHandle): number {
	return Number((sql.exec("SELECT COUNT(*) AS n FROM prompts").toArray() as { n: number }[])[0]?.n ?? 0);
}

export function countEnabledRules(sql: SqlHandle): number {
	return Number(
		(sql.exec("SELECT COUNT(*) AS n FROM rules WHERE enabled = 1").toArray() as { n: number }[])[0]?.n ?? 0,
	);
}

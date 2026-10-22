import type { SqlHandle } from "../db/migrations";

/** 提示模板与规则文件（v0.31.0）：两张表的唯一写入口。 */
export type PromptRow = { name: string; description: string; content: string };
export type RuleRow = { name: string; content: string; enabled: number };

export function listPrompts(sql: SqlHandle): PromptRow[] {
	return sql.exec("SELECT name, description, content FROM prompts ORDER BY name").toArray() as PromptRow[];
}

export function upsertPrompt(sql: SqlHandle, row: PromptRow, now: string): void {
	sql.exec(
		"INSERT INTO prompts (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
		row.name,
		row.description,
		row.content,
		now,
	);
}

export function deletePrompt(sql: SqlHandle, name: string): void {
	sql.exec("DELETE FROM prompts WHERE name = ?", name);
}

export function listRules(sql: SqlHandle): RuleRow[] {
	return sql.exec("SELECT name, content, enabled FROM rules ORDER BY name").toArray() as RuleRow[];
}

export function upsertRule(sql: SqlHandle, row: { name: string; content: string; enabled: number }, now: string): void {
	sql.exec(
		"INSERT INTO rules (name, content, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content",
		row.name,
		row.content,
		row.enabled,
		now,
	);
}

export function setRuleEnabled(sql: SqlHandle, name: string, enabled: boolean): void {
	sql.exec("UPDATE rules SET enabled = ? WHERE name = ?", enabled ? 1 : 0, name);
}

export function deleteRule(sql: SqlHandle, name: string): void {
	sql.exec("DELETE FROM rules WHERE name = ?", name);
}

/** 备份：两张表的全量（顺序与旧 backup 一致）。 */
export function listPromptsForBackup(sql: SqlHandle): PromptRow[] {
	return sql.exec("SELECT name, description, content FROM prompts").toArray() as PromptRow[];
}

export function listRulesForBackup(sql: SqlHandle): RuleRow[] {
	return sql.exec("SELECT name, content, enabled FROM rules").toArray() as RuleRow[];
}

/** 恢复：整行 upsert（`enabled` 由调用方归一化为 0/1）。 */
export function restorePrompt(sql: SqlHandle, row: PromptRow, now: string): void {
	upsertPrompt(sql, row, now);
}

export function restoreRule(sql: SqlHandle, row: { name: string; content: string; enabled: number }, now: string): void {
	sql.exec(
		"INSERT INTO rules (name, content, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content, enabled = excluded.enabled",
		row.name,
		row.content,
		row.enabled,
		now,
	);
}

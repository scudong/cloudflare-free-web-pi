import type { SqlHandle } from "../db/migrations";

/** 自定义工具仓储（ADR-0001 §3）：只做 `custom_tools` 的 SQL。 */
export type CustomToolRow = { name: string; description: string; parameters: string; code: string };
export type CustomToolView = {
	name: string;
	description: string;
	parameters: string;
	code: string;
	enabled: number;
	created_at: string;
};

export function listEnabled(sql: SqlHandle): CustomToolRow[] {
	return sql
		.exec("SELECT name, description, parameters, code FROM custom_tools WHERE enabled = 1 ORDER BY name")
		.toArray() as CustomToolRow[];
}

export function listAll(sql: SqlHandle): CustomToolView[] {
	return sql
		.exec("SELECT name, description, parameters, code, enabled, created_at FROM custom_tools ORDER BY created_at DESC")
		.toArray() as CustomToolView[];
}

export function upsert(
	sql: SqlHandle,
	row: { name: string; description: string; parameters: string; code: string; now: string },
): void {
	sql.exec(
		`INSERT INTO custom_tools (name, description, parameters, code, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)
		 ON CONFLICT(name) DO UPDATE SET description = excluded.description, parameters = excluded.parameters, code = excluded.code, enabled = 1`,
		row.name,
		row.description,
		row.parameters,
		row.code,
		row.now,
	);
}

export function remove(sql: SqlHandle, name: string): void {
	sql.exec("DELETE FROM custom_tools WHERE name = ?", name);
}

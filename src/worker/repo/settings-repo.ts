import type { SqlHandle } from "../db/migrations";

/**
 * 全局设置仓储（ADR-0001 §3）：只做 `app_settings` 的 SQL。
 * 语义收口（默认值、审批策略解析、Harness 重建时机）在 services/settings-service.ts。
 */
export function get(sql: SqlHandle, key: string, fallback: string): string {
	try {
		const rows = sql.exec("SELECT value FROM app_settings WHERE key = ?", key).toArray() as { value: string }[];
		return rows[0]?.value ?? fallback;
	} catch {
		return fallback;
	}
}

export function set(sql: SqlHandle, key: string, value: string): void {
	sql.exec(
		"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		key,
		value,
	);
}

/** 备份条目（`{key, value}`），恢复按 key upsert。 */
export function listAll(sql: SqlHandle): { key: string; value: string }[] {
	return sql.exec("SELECT key, value FROM app_settings").toArray() as { key: string; value: string }[];
}

export function restoreRow(sql: SqlHandle, row: { key: string; value: string }): void {
	set(sql, row.key, row.value);
}

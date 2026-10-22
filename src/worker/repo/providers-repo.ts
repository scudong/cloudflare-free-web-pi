import type { SqlHandle } from "../db/migrations";

/**
 * LLM 供应商仓储（ADR-0001 §3）：只做 `providers` 的 SQL。
 * 端点契约（密钥留空回落、当前供应商、模型解析）在 services/settings-service.ts。
 */
export type ProviderRow = { id: string; name: string; base_url: string; api_key: string; models: string };

const SELECT = "SELECT id, name, base_url, api_key, models FROM providers";

export function list(sql: SqlHandle): ProviderRow[] {
	try {
		return sql.exec(`${SELECT} ORDER BY created_at ASC`).toArray() as ProviderRow[];
	} catch {
		return [];
	}
}

export function find(sql: SqlHandle, id: string): ProviderRow | undefined {
	return (sql.exec(`${SELECT} WHERE id = ?`, id).toArray() as ProviderRow[])[0];
}

export function upsert(sql: SqlHandle, row: ProviderRow & { createdAt: string }): void {
	sql.exec(
		"INSERT INTO providers (id, name, base_url, api_key, models, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key, models = excluded.models",
		row.id,
		row.name,
		row.base_url,
		row.api_key,
		row.models,
		row.createdAt,
	);
}

export function remove(sql: SqlHandle, id: string): void {
	sql.exec("DELETE FROM providers WHERE id = ?", id);
}

export function listForBackup(sql: SqlHandle): ProviderRow[] {
	return sql.exec("SELECT id, name, base_url, api_key, models FROM providers").toArray() as ProviderRow[];
}

export function restoreRow(sql: SqlHandle, row: ProviderRow, createdAt: string): void {
	upsert(sql, { ...row, createdAt });
}

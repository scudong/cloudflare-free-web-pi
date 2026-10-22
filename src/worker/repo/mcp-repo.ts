import type { SqlHandle } from "../db/migrations";

/**
 * MCP 服务器仓储（ADR-0001 §3）：只做 `mcp_servers` 的 SQL。
 * 连接、工具清单缓存在 services/mcp-service.ts，缓存对象由 DO 实例显式传入（R5）。
 */
export type McpServerSummary = { id: string; name: string; url: string; created_at: string };
export type McpServerConfig = { id: string; name: string; url: string; headers: string };

export function list(sql: SqlHandle): McpServerSummary[] {
	return sql.exec("SELECT id, name, url, created_at FROM mcp_servers ORDER BY created_at ASC").toArray() as McpServerSummary[];
}

/** 连接所需字段（含 headers 原文）；顺序与旧 buildMcpExtension 一致。 */
export function listConfigured(sql: SqlHandle): McpServerConfig[] {
	return sql.exec("SELECT id, name, url, headers FROM mcp_servers ORDER BY created_at ASC").toArray() as McpServerConfig[];
}

export function count(sql: SqlHandle): number {
	const rows = sql.exec("SELECT COUNT(*) AS n FROM mcp_servers").toArray() as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

export function upsert(sql: SqlHandle, row: McpServerConfig & { createdAt: string }): void {
	sql.exec(
		"INSERT INTO mcp_servers (id, name, url, headers, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, headers = excluded.headers",
		row.id,
		row.name,
		row.url,
		row.headers,
		row.createdAt,
	);
}

export function remove(sql: SqlHandle, id: string): void {
	sql.exec("DELETE FROM mcp_servers WHERE id = ?", id);
}

export function listForBackup(sql: SqlHandle): McpServerConfig[] {
	return sql.exec("SELECT id, name, url, headers FROM mcp_servers").toArray() as McpServerConfig[];
}

export function restoreRow(sql: SqlHandle, row: McpServerConfig, createdAt: string): void {
	upsert(sql, { ...row, createdAt });
}

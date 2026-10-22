import type { SqlHandle } from "../db/migrations";

/** `reflect_state`：每个会话上一次反思到的条目 id（chat-service 的节流阈值）。 */
export function getLastEntryId(sql: SqlHandle, conversationId: string): number {
	const rows = sql
		.exec("SELECT last_entry_id FROM reflect_state WHERE conversation_id = ?", conversationId)
		.toArray() as { last_entry_id: number }[];
	return Number(rows[0]?.last_entry_id ?? 0);
}

export function setLastEntryId(sql: SqlHandle, conversationId: string, uptoId: number, now: string): void {
	sql.exec(
		"INSERT INTO reflect_state (conversation_id, last_entry_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET last_entry_id = excluded.last_entry_id, updated_at = excluded.updated_at",
		conversationId,
		uptoId,
		now,
	);
}

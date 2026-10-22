import type { SqlHandle } from "../db/migrations";

/**
 * 分享仓储（ADR-0001 §3）：只做 `shares` 表的 SQL，返回类型化记录。
 * token 生成、TTL 解析、主题回落都在 services/share-service.ts。
 */
export type ShareKind = "conversation" | "file";

export type ShareRow = {
	token: string;
	kind: string;
	sessionId: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
};

/** 新建分享要落库的字段（已解析 TTL / 主题 / token）。 */
export type NewShareRow = {
	token: string;
	kind: ShareKind;
	sessionId: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
};

const SELECT =
	"SELECT token, kind, session_id AS sessionId, name, expires_at AS expiresAt, theme, created_at AS createdAt FROM shares";

/** 未过期的分享链接（新→旧）。 */
export function listUnexpired(sql: SqlHandle, sessionId: string, kind: ShareKind, name: string, now: number): ShareRow[] {
	return (
		kind === "file"
			? sql
					.exec(
						`${SELECT} WHERE kind = 'file' AND session_id = ? AND name = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC`,
						sessionId,
						name,
						now,
					)
					.toArray()
			: sql
					.exec(
						`${SELECT} WHERE kind = 'conversation' AND session_id = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC`,
						sessionId,
						now,
					)
					.toArray()
	) as ShareRow[];
}

/** 按 token 取分享（含已过期：调用方负责 410）。 */
export function getByToken(sql: SqlHandle, token: string): ShareRow | undefined {
	const rows = sql
		.exec(`${SELECT} WHERE token = ?`, token)
		.toArray() as ShareRow[];
	return rows[0];
}

/** 同一文件最近一条未过期分享（会话分享页里的文件卡用它给出口）。 */
export function latestTokenForFile(sql: SqlHandle, sessionId: string, name: string, now: number): string | undefined {
	const rows = sql
		.exec(
			"SELECT token FROM shares WHERE kind = 'file' AND session_id = ? AND name = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC LIMIT 1",
			sessionId,
			name,
			now,
		)
		.toArray() as { token: string }[];
	return rows[0]?.token;
}

export function insert(sql: SqlHandle, row: NewShareRow): void {
	sql.exec(
		"INSERT INTO shares (token, kind, session_id, name, expires_at, theme, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		row.token,
		row.kind,
		row.sessionId,
		row.name,
		row.expiresAt,
		row.theme,
		row.createdAt,
	);
}

/** 清掉已过期的分享，避免表无限增长。 */
export function purgeExpired(sql: SqlHandle, now: number): void {
	sql.exec("DELETE FROM shares WHERE expires_at > 0 AND expires_at <= ?", now);
}

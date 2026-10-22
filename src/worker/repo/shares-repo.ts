import type { SqlHandle } from "../db/migrations";

/**
 * 分享仓储（ADR-0001 §3）：只做 `shares` 表的 SQL，返回类型化记录。
 * token 生成、TTL 解析、主题回落都在 services/share-service.ts。
 */
export type ShareKind = "conversation" | "file";

/** 清单过滤口径：active = 未过期（含永久），expired = 已过期，all = 全部。 */
export type ShareStatus = "active" | "expired" | "all";

export type ShareRow = {
	token: string;
	kind: string;
	sessionId: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
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

/** 同一 IP 的打开计数窗口：1 小时内只计 1 次（NERE-42）。 */
export const OPEN_DEDUPE_MS = 60 * 60 * 1000;

const SELECT =
	"SELECT token, kind, session_id AS sessionId, name, expires_at AS expiresAt, theme, created_at AS createdAt, open_count AS openCount, last_opened_at AS lastOpenedAt FROM shares";

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

/** 全量清单（NERE-42）：默认不调用方自己定型，SQL 只负责按状态过滤。 */
export function listAll(sql: SqlHandle, status: ShareStatus, now: number): ShareRow[] {
	const where =
		status === "active"
			? " WHERE expires_at = 0 OR expires_at > ?"
			: status === "expired"
				? " WHERE expires_at > 0 AND expires_at <= ?"
				: "";
	const bindings = status === "all" ? [] : [now];
	return sql
		.exec(`${SELECT}${where} ORDER BY created_at DESC`, ...bindings)
		.toArray() as ShareRow[];
}

/** 按 token 取分享（含已过期：调用方负责 410）。 */
export function getByToken(sql: SqlHandle, token: string): ShareRow | undefined {
	const rows = sql
		.exec(`${SELECT} WHERE token = ?`, token)
		.toArray() as ShareRow[];
	return rows[0];
}

/**
 * 记一次打开（NERE-42）。同一 IP 哈希在窗口内重复打开不改任何行（`open_count` 与
 * `last_opened_at` 都保持首次计入的值），因此 `last_opened_at` 的口径是「最近一次计入打开」。
 */
export function recordOpen(sql: SqlHandle, token: string, ipHash: string, at: number): void {
	sql.exec(
		`UPDATE shares SET open_count = open_count + 1, last_opened_at = ?, opened_ip_hash = ?
		WHERE token = ? AND NOT (opened_ip_hash = ? AND last_opened_at > ?)`,
		at,
		ipHash,
		token,
		ipHash,
		at - OPEN_DEDUPE_MS,
	);
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

/** 撤销分享（NERE-42）：命中返回 true，不存在返回 false。
 * `RETURNING` 让「有没有删到」在一次往返里确定，避免再查一遍。 */
export function deleteByToken(sql: SqlHandle, token: string): boolean {
	const rows = sql.exec("DELETE FROM shares WHERE token = ? RETURNING token", token).toArray();
	return rows.length > 0;
}

/** 清掉已过期的分享，避免表无限增长。 */
export function purgeExpired(sql: SqlHandle, now: number): void {
	sql.exec("DELETE FROM shares WHERE expires_at > 0 AND expires_at <= ?", now);
}

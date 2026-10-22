import type { SqlHandle } from "../db/migrations";

/**
 * 技能仓储（ADR-0001 §3）：只做 `skills` / `skill_audits` / `skill_events` 的 SQL。
 * 审计判定、目录合并、事件口径都在 `services/skill-service.ts`。
 */

export type SkillRow = {
	name: string;
	description: string;
	content: string;
	createdAt: string;
	version: string;
	source: string;
	author: string;
	license: string;
	runtime: string;
	tags: string;
	contentHash: string;
	auditStatus: string;
	auditReport: string;
	manifest: string | null;
	updatedAt: string;
};

/** 导入/工具写入的完整行（审计结果与 manifest 已就绪）。 */
export type SkillWrite = {
	name: string;
	description: string;
	content: string;
	version: string;
	source: string;
	author: string;
	license: string;
	runtime: string;
	tags: string[];
	contentHash: string;
	auditStatus: string;
	auditReport: string;
	manifest: string | null;
	createdAt: string;
	updatedAt: string;
};

const SELECT =
	"SELECT name, description, content, created_at AS createdAt, version, source, author, license, runtime, tags, " +
	"content_hash AS contentHash, audit_status AS auditStatus, audit_report AS auditReport, manifest, updated_at AS updatedAt FROM skills";

export function listSkillRows(sql: SqlHandle): SkillRow[] {
	return sql.exec(`${SELECT} ORDER BY name`).toArray() as SkillRow[];
}

export function getSkillRow(sql: SqlHandle, name: string): SkillRow | undefined {
	return (sql.exec(`${SELECT} WHERE name = ?`, name).toArray() as SkillRow[])[0];
}

export function upsertSkill(sql: SqlHandle, row: SkillWrite): void {
	sql.exec(
		`INSERT INTO skills
			(name, description, content, created_at, version, source, author, license, runtime, tags, content_hash, audit_status, audit_report, manifest, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
			description = excluded.description,
			content = excluded.content,
			version = excluded.version,
			source = excluded.source,
			author = excluded.author,
			license = excluded.license,
			runtime = excluded.runtime,
			tags = excluded.tags,
			content_hash = excluded.content_hash,
			audit_status = excluded.audit_status,
			audit_report = excluded.audit_report,
			manifest = excluded.manifest,
			updated_at = excluded.updated_at`,
		row.name,
		row.description,
		row.content,
		row.createdAt,
		row.version,
		row.source,
		row.author,
		row.license,
		row.runtime,
		JSON.stringify(row.tags),
		row.contentHash,
		row.auditStatus,
		row.auditReport,
		row.manifest,
		row.updatedAt,
	);
}

/** 手工粘贴（`POST /skills`）不审计：只写基础列，`content_hash` 惰性计算。 */
export function upsertManualSkill(
	sql: SqlHandle,
	input: { name: string; description: string; content: string },
	now: string,
): void {
	sql.exec(
		`INSERT INTO skills (name, description, content, created_at, version, source, author, license, runtime, tags, content_hash, audit_status, audit_report, updated_at)
		 VALUES (?, ?, ?, ?, '0.0.0', 'local', '', 'UNLICENSED', 'prompt', '[]', '', 'pass', '{}', ?)
		 ON CONFLICT(name) DO UPDATE SET
			description = excluded.description,
			content = excluded.content,
			version = excluded.version,
			source = excluded.source,
			runtime = excluded.runtime,
			content_hash = excluded.content_hash,
			audit_status = excluded.audit_status,
			audit_report = excluded.audit_report,
			updated_at = excluded.updated_at`,
		input.name,
		input.description,
		input.content,
		now,
		now,
	);
}

export function deleteSkill(sql: SqlHandle, name: string): void {
	sql.exec("DELETE FROM skills WHERE name = ?", name);
}

export function updateContentHash(sql: SqlHandle, name: string, contentHash: string, now: string): void {
	sql.exec("UPDATE skills SET content_hash = ?, updated_at = ? WHERE name = ? AND content_hash = ''", contentHash, now, name);
}

export function countSkills(sql: SqlHandle): number {
	return Number((sql.exec("SELECT COUNT(*) AS n FROM skills").toArray() as { n: number }[])[0]?.n ?? 0);
}

/* ---------------- 审计缓存 ---------------- */

export type AuditCacheRow = { status: string; report: string; auditedAt: string };

export function getCachedAudit(sql: SqlHandle, hash: string, rulesVersion: number): AuditCacheRow | undefined {
	return (
		sql
			.exec(
				"SELECT status, report, audited_at AS auditedAt FROM skill_audits WHERE content_hash = ? AND rules_version = ?",
				hash,
				rulesVersion,
			)
			.toArray() as AuditCacheRow[]
	)[0];
}

export function putCachedAudit(
	sql: SqlHandle,
	input: { hash: string; rulesVersion: number; status: string; report: string; auditedAt: string },
): void {
	sql.exec(
		"INSERT OR REPLACE INTO skill_audits (content_hash, rules_version, status, report, audited_at) VALUES (?, ?, ?, ?, ?)",
		input.hash,
		input.rulesVersion,
		input.status,
		input.report,
		input.auditedAt,
	);
}

/* ---------------- 埋点（NERE-55 追加范围 A / NERE-59） ---------------- */

export type SkillEventType =
	| "skill_hub_view"
	| "skill_detail_view"
	| "skill_import"
	| "skill_blocked"
	| "skill_install"
	| "skill_loaded"
	| "skill_invoked";

export function recordEvent(
	sql: SqlHandle,
	input: { name: string; type: SkillEventType; source?: string; at: number; meta?: string },
): void {
	sql.exec(
		"INSERT INTO skill_events (name, type, source, at, meta) VALUES (?, ?, ?, ?, ?)",
		input.name,
		input.type,
		input.source ?? "",
		input.at,
		input.meta ?? "",
	);
}

/** 窗口内按 type 计数；返回 `Record<type, n>`。 */
export function eventCounts(sql: SqlHandle, since: number): Record<string, number> {
	const rows = sql
		.exec("SELECT type, COUNT(*) AS n FROM skill_events WHERE at >= ? GROUP BY type", since)
		.toArray() as { type: string; n: number }[];
	const counts: Record<string, number> = {};
	for (const row of rows) counts[row.type] = Number(row.n);
	return counts;
}

/** 窗口内被加载/显式调用的去重技能名。 */
export function invokedNames(sql: SqlHandle, since: number): string[] {
	return (
		sql
			.exec(
				"SELECT DISTINCT name FROM skill_events WHERE at >= ? AND type IN ('skill_loaded', 'skill_invoked') ORDER BY name",
				since,
			)
			.toArray() as { name: string }[]
	).map((row) => row.name);
}

/** 每个技能最后一次被加载/调用的时间戳；GET /skills 的 `lastInvokedAt`。 */
export function lastInvokedMap(sql: SqlHandle): Record<string, number> {
	const rows = sql
		.exec(
			"SELECT name, MAX(at) AS at FROM skill_events WHERE type IN ('skill_loaded', 'skill_invoked') GROUP BY name",
		)
		.toArray() as { name: string; at: number }[];
	const map: Record<string, number> = {};
	for (const row of rows) map[row.name] = Number(row.at);
	return map;
}

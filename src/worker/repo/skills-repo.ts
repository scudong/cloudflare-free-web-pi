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

/** 列表/索引投影：除正文外的全部元数据（hub、instructions、list_skills 用）。 */
export type SkillMeta = Omit<SkillRow, "content">;

const SELECT =
	"SELECT name, description, content, created_at AS createdAt, version, source, author, license, runtime, tags, " +
	"content_hash AS contentHash, audit_status AS auditStatus, audit_report AS auditReport, manifest, updated_at AS updatedAt FROM skills";
const SELECT_META =
	"SELECT name, description, created_at AS createdAt, version, source, author, license, runtime, tags, " +
	"content_hash AS contentHash, audit_status AS auditStatus, audit_report AS auditReport, manifest, updated_at AS updatedAt FROM skills";

export function listSkillRows(sql: SqlHandle): SkillRow[] {
	return sql.exec(`${SELECT} ORDER BY name`).toArray() as SkillRow[];
}

/** 不读正文：100 个技能时列表字节数取决于元数据，而不是 SKILL.md 体积。 */
export function listSkillMeta(sql: SqlHandle): SkillMeta[] {
	return sql.exec(`${SELECT_META} ORDER BY name`).toArray() as SkillMeta[];
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

/** 手工粘贴（`POST /skills`）：写入前已审计，落库的是真实状态与报告。 */
export function upsertManualSkill(
	sql: SqlHandle,
	input: {
		name: string;
		description: string;
		content: string;
		contentHash: string;
		auditStatus: string;
		auditReport: string;
		manifest: string | null;
	},
	now: string,
): void {
	sql.exec(
		`INSERT INTO skills (name, description, content, created_at, version, source, author, license, runtime, tags, content_hash, audit_status, audit_report, manifest, updated_at)
		 VALUES (?, ?, ?, ?, '0.0.0', 'local', '', 'UNLICENSED', 'prompt', '[]', ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
			description = excluded.description,
			content = excluded.content,
			version = excluded.version,
			source = excluded.source,
			runtime = excluded.runtime,
			content_hash = excluded.content_hash,
			audit_status = excluded.audit_status,
			audit_report = excluded.audit_report,
			manifest = excluded.manifest,
			updated_at = excluded.updated_at`,
		input.name,
		input.description,
		input.content,
		now,
		input.contentHash,
		input.auditStatus,
		input.auditReport,
		input.manifest,
		now,
	);
}

export function deleteSkill(sql: SqlHandle, name: string): void {
	sql.exec("DELETE FROM skills WHERE name = ?", name);
}

/** 本地重审计后把判定回写 `skills`：hub 与 `GET /skills` / 提示词索引共用同一真相。 */
export function updateSkillAudit(
	sql: SqlHandle,
	name: string,
	input: { contentHash: string; auditStatus: string; auditReport: string },
): void {
	sql.exec(
		"UPDATE skills SET content_hash = CASE WHEN content_hash = '' THEN ? ELSE content_hash END, audit_status = ?, audit_report = ? WHERE name = ?",
		input.contentHash,
		input.auditStatus,
		input.auditReport,
		name,
	);
}

export function countSkills(sql: SqlHandle): number {
	return Number((sql.exec("SELECT COUNT(*) AS n FROM skills").toArray() as { n: number }[])[0]?.n ?? 0);
}

/** 模型可见的技能数（`audit_status = 'blocked'` 不进入提示词索引，也不计入能力清单）。 */
export function countVisibleSkills(sql: SqlHandle): number {
	return Number(
		(sql.exec("SELECT COUNT(*) AS n FROM skills WHERE audit_status != 'blocked'").toArray() as { n: number }[])[0]?.n ?? 0,
	);
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

/** 备份：只导基础三列（与旧 /backup 一致，审计字段不导出）。 */
export function listForBackup(sql: SqlHandle): { name: string; description: string; content: string }[] {
	return sql.exec("SELECT name, description, content FROM skills ORDER BY name").toArray() as {
		name: string;
		description: string;
		content: string;
	}[];
}

/** 恢复：只写基础三列；已存在则更新描述与正文（旧 restore 语义）。 */
export function restoreRow(
	sql: SqlHandle,
	row: { name: string; description: string; content: string },
	now: string,
): void {
	sql.exec(
		"INSERT INTO skills (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
		row.name,
		row.description,
		row.content,
		now,
	);
}

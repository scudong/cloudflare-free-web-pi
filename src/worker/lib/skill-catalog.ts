/**
 * 内置技能目录（NERE-55，契约 §6）：构建期快照作为 JSON 模块打入 Worker，列表请求零 subrequest。
 *
 * catalog 只含元数据 + 内容地址 + sha256 + 审计快照，不内联内容。
 * 校验（无 blocked、hash 一致）由 `tests/unit/skill-catalog.test.ts` 与 CI 门禁执行。
 */

import bundled from "../../../skills/catalog.json";
import type { AuditReport, SkillManifest, SkillRuntime } from "./skill-audit";

export type CatalogAudit = AuditReport;
export type CatalogEntry = SkillManifest & {
	contentUrl: string;
	contentHash: string;
	audit: CatalogAudit;
	origin?: "bundled" | "remote";
};

export type SkillCatalog = {
	schemaVersion: 1;
	generatedAt: string;
	entries: CatalogEntry[];
};

/** 内置目录（`skills/catalog.json`）。JSON 模块由 wrangler/esbuild/vitest 直接解析。 */
export const BUNDLED_CATALOG = bundled as unknown as SkillCatalog;
export const BUNDLED_CATALOG_GENERATED_AT = BUNDLED_CATALOG.generatedAt;

/** 目录条目的运行时取值；未知值按 other（fail closed）。 */
export function catalogRuntime(entry: { runtime?: unknown }): SkillRuntime {
	const value = String(entry.runtime ?? "");
	return (["prompt", "javascript", "typescript", "python", "shell", "binary", "other"] as const).includes(
		value as SkillRuntime,
	)
		? (value as SkillRuntime)
		: "other";
}

/**
 * 目录快照门禁（NERE-55 追加范围 B）：`skills/catalog.json` 必须与仓库里的 SKILL.md 一致。
 *
 * - `npm run catalog:check`：只校验（CI 硬门禁）。
 * - `npm run catalog`：用同一套审计规则重新生成（本地改完技能后跑）。
 *
 * 任一 blocked 条目、sha256 不一致、audit.hash 与 contentHash 不一致 → 测试失败，构建失败。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	auditSkill,
	byteLength,
	parseFrontmatter,
	sha256Content,
	slugifySkillName,
	stripFrontmatter,
	type SkillManifest,
	type AuditReport,
} from "../../src/worker/lib/skill-audit";

const ROOT = join(__dirname, "../..");
const SKILLS_DIR = join(ROOT, "skills");
const CATALOG_PATH = join(SKILLS_DIR, "catalog.json");
const WRITE = process.env.SKILL_CATALOG_WRITE === "1";

type StoredEntry = {
	schemaVersion: number;
	name: string;
	version: string;
	description: string;
	author: string;
	source: string;
	license: string;
	runtime: string;
	tags: string[];
	requires: { tools: string[]; bindings: string[]; network: string[] };
	contentUrl: string;
	contentHash: string;
	audit?: AuditReport;
};

type StoredCatalog = { schemaVersion: number; generatedAt: string; entries: StoredEntry[] };

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as StoredCatalog;

function skillNames(): string[] {
	return readdirSync(SKILLS_DIR)
		.filter((name) => {
			const path = join(SKILLS_DIR, name);
			if (!statSync(path).isDirectory()) return false;
			try {
				return statSync(join(path, "SKILL.md")).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}

function rawUrlFor(name: string): string {
	return `https://raw.githubusercontent.com/scudong/cloudflare-free-web-pi/main/skills/${name}/SKILL.md`;
}

function manifestFor(entry: StoredEntry): SkillManifest {
	return {
		schemaVersion: 1,
		name: entry.name,
		version: entry.version,
		description: entry.description,
		author: entry.author,
		source: entry.source,
		license: entry.license,
		runtime: "prompt",
		tags: entry.tags,
		requires: entry.requires,
		contentHash: entry.contentHash,
	};
}

async function regenerate(): Promise<StoredCatalog> {
	const existing = new Map(catalog.entries.map((entry) => [entry.name, entry]));
	const entries: StoredEntry[] = [];
	for (const dir of skillNames()) {
		const markdown = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
		const frontmatter = parseFrontmatter(markdown);
		const previous = existing.get(dir);
		const name = slugifySkillName(frontmatter.name) || dir;
		const hash = await sha256Content(stripFrontmatter(markdown));
		const base: StoredEntry = {
			schemaVersion: 1,
			name,
			version: previous?.version ?? "1.0.0",
			description: (frontmatter.description || previous?.description || "（未提供描述）").slice(0, 200),
			author: previous?.author ?? "pi-harness",
			source: previous?.source ?? `https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/${dir}`,
			license: previous?.license ?? "MIT",
			runtime: "prompt",
			tags: previous?.tags ?? [],
			requires: previous?.requires ?? { tools: [], bindings: [], network: [] },
			contentUrl: previous?.contentUrl ?? rawUrlFor(dir),
			contentHash: hash,
		};
		const audit = await auditSkill({
			manifest: manifestFor(base),
			content: markdown,
			filename: "SKILL.md",
			auditSource: "catalog",
		});
		entries.push({ ...base, contentHash: audit.hash, audit });
	}
	return { schemaVersion: 1, generatedAt: new Date().toISOString(), entries };
}

describe("skills/catalog.json 门禁", () => {
	it("目录规模与基础结构", () => {
		expect(catalog.schemaVersion).toBe(1);
		expect(catalog.entries.length).toBeLessThanOrEqual(200);
		expect(byteLength(readFileSync(CATALOG_PATH, "utf8"))).toBeLessThanOrEqual(256 * 1024);
		const names = catalog.entries.map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		for (const entry of catalog.entries) {
			expect(entry.schemaVersion).toBe(1);
			expect(entry.contentUrl).toMatch(/^https:\/\//);
			expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
	});

	it("没有任何 blocked 条目，且 audit.hash == contentHash", () => {
		for (const entry of catalog.entries) {
			const audit = entry.audit;
			expect(audit?.status, `${entry.name} 不应在内置目录里被 blocked`).not.toBe("blocked");
			expect(audit?.hash, `${entry.name} 的审计哈希必须与 contentHash 一致`).toBe(entry.contentHash);
		}
	});

	it("每个条目的 sha256 与仓库里的 SKILL.md 正文一致，且重审计无 blocked", async () => {
		for (const entry of catalog.entries) {
			const dir = skillNames().find(
				(name) => name === entry.name || slugifySkillName(parseFrontmatter(readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8")).name) === entry.name,
			);
			expect(dir, `catalog 条目 ${entry.name} 找不到对应的 skills/<name>/SKILL.md`).toBeTruthy();
			const markdown = readFileSync(join(SKILLS_DIR, dir!, "SKILL.md"), "utf8");
			expect(await sha256Content(stripFrontmatter(markdown)), `${entry.name} 内容哈希漂移，请运行 npm run catalog`).toBe(
				entry.contentHash,
			);
			const report = await auditSkill({
				manifest: manifestFor(entry),
				content: markdown,
				filename: "SKILL.md",
				auditSource: "catalog",
			});
			expect(report.status, `${entry.name} 重审计结果为 blocked`).not.toBe("blocked");
			expect(report.status).toBe(entry.audit?.status);
		}
	});

	it("目录与仓库技能集合一致（新增/删除技能必须重新生成）", () => {
		const catalogDirs = new Set(
			catalog.entries.map((entry) => entry.contentUrl.split("/skills/")[1]?.split("/")[0] ?? entry.name),
		);
		for (const name of skillNames()) expect(catalogDirs.has(name), `skills/${name} 未进入 catalog`).toBe(true);
	});

	it.runIf(WRITE)("重新生成 catalog.json", async () => {
		const next = await regenerate();
		writeFileSync(CATALOG_PATH, `${JSON.stringify(next, null, 2)}\n`);
	});
});

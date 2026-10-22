import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { sha256Content, type AuditReport } from "../../src/worker/lib/skill-audit";
import type { CatalogEntry } from "../../src/worker/lib/skill-catalog";
import { listSkillRows } from "../../src/worker/repo/skills-repo";
import { createSkillService, SkillApiError, trackSkillCall } from "../../src/worker/services/skill-service";

function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP|UPDATE)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

const openDbs: DatabaseSync[] = [];
function setup(deps: { fetchImpl?: typeof fetch; catalog?: CatalogEntry[] } = {}) {
	const db = new DatabaseSync(":memory:");
	openDbs.push(db);
	const sql = sqlHandle(db);
	migrate(sql);
	const service = createSkillService({
		sql,
		settings: { get: () => "" },
		now: () => new Date("2026-10-22T06:00:00Z"),
		...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
		...(deps.catalog ? { catalog: deps.catalog } : {}),
	});
	return { db, sql, service };
}

function passAudit(runtime: CatalogEntry["runtime"], tools: string[] = []): AuditReport {
	return {
		status: "pass",
		reasons: [],
		detected: { runtime, network: [], tools },
		auditedAt: "2026-10-22T00:00:00Z",
		hash: "",
		rulesVersion: 1,
		auditSource: "catalog",
	};
}

function catalogEntry(overrides: Partial<CatalogEntry> & { name: string; contentHash: string }): CatalogEntry {
	const runtime = overrides.runtime ?? "prompt";
	const installable = runtime === "prompt" || runtime === "javascript" || runtime === "typescript";
	const audit: AuditReport = installable
		? { ...passAudit(runtime), hash: overrides.contentHash }
		: {
				...passAudit(runtime),
				status: "blocked",
				reasons: [{ rule: "M3", level: "blocked", message: `运行时 ${runtime} 不受支持` }],
				hash: overrides.contentHash,
			};
	const entry: CatalogEntry = {
		schemaVersion: 1,
		name: overrides.name,
		version: "1.0.0",
		description: "目录技能",
		author: "hou",
		source: "https://example.com/skills/" + overrides.name,
		license: "MIT",
		runtime,
		tags: ["utility"],
		requires: { tools: [], bindings: [], network: [] },
		contentUrl: `https://raw.githubusercontent.com/scudong/cloudflare-free-web-pi/main/skills/${overrides.name}/SKILL.md`,
		contentHash: overrides.contentHash,
		audit,
	};
	return { ...entry, ...overrides };
}

afterEach(() => {
	while (openDbs.length) openDbs.pop()?.close();
});

describe("Skill Hub：导入审计与准入", () => {
	it("Python 技能导入 → 422 audit_blocked，库中无记录，返回原因", async () => {
		const { sql, service } = setup();
		const pythonManifest = {
			schemaVersion: 1,
			name: "csv-report",
			version: "1.0.0",
			description: "用 Python 生成 CSV 报告",
			author: "hou",
			source: "https://example.com/csv-report",
			license: "MIT",
			runtime: "python",
			tags: ["csv"],
			requires: { tools: [], bindings: [], network: [] },
			entry: "main.py",
		};
		await expect(
			service.importSkill({ manifest: pythonManifest, content: "#!/usr/bin/env python3\nprint(1)\n" }),
		).rejects.toMatchObject({ status: 422, code: "audit_blocked" });
		expect(listSkillRows(sql)).toHaveLength(0);
		const metrics = service.metrics("1");
		expect(metrics.installBlocked).toBe(1);
		expect(metrics.installOk).toBe(0);
		expect(metrics.blockedRatio).toBe(1);
	});

	it("shell 技能导入 → blocked", async () => {
		const { service } = setup();
		await expect(
			service.importSkill({
				manifest: {
					schemaVersion: 1,
					name: "db-backup",
					version: "1.0.0",
					description: "备份",
					author: "hou",
					source: "https://example.com/db-backup",
					license: "MIT",
					runtime: "shell",
					tags: [],
					requires: { tools: [], bindings: [], network: [] },
					entry: "backup.sh",
				},
				content: "#!/usr/bin/env bash\ntar -czf backup.tgz notes\n",
			}),
		).rejects.toMatchObject({ status: 422, code: "audit_blocked" });
	});

	it("纯 JS 导入 → pass 入库；同哈希重复导入 changed:false", async () => {
		const { sql, service } = setup();
		const content = "const now = await tools.now({});\nreturn { now };\n";
		const body = {
			manifest: {
				schemaVersion: 1,
				name: "pure-js",
				version: "1.0.0",
				description: "读取当前时间",
				author: "hou",
				source: "https://example.com/pure-js",
				license: "MIT",
				runtime: "javascript",
				tags: ["utility"],
				requires: { tools: ["now"], bindings: [], network: [] },
				entry: "index.js",
				contentHash: await sha256Content(content),
			},
			content,
		};
		const first = await service.importSkill(body);
		expect(first.changed).toBe(true);
		expect(first.audit.status).toBe("pass");
		const rows = listSkillRows(sql);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: "pure-js", runtime: "javascript", auditStatus: "pass", version: "1.0.0" });
		expect(rows[0]!.contentHash).toBe(await sha256Content(content));

		const second = await service.importSkill(body);
		expect(second.changed).toBe(false);
		expect(service.metrics("7").installOk).toBe(1);
	});

	it("同名不同哈希 → 409；overwrite=1 覆盖", async () => {
		const { sql, service } = setup();
		const base = {
			manifest: {
				schemaVersion: 1,
				name: "clock",
				version: "1.0.0",
				description: "时钟",
				author: "hou",
				source: "https://example.com/clock",
				license: "MIT",
				runtime: "javascript",
				tags: [],
				requires: { tools: ["now"], bindings: [], network: [] },
				entry: "index.js",
			},
			content: "return await tools.now({});\n",
		};
		await service.importSkill(base);
		await expect(
			service.importSkill({ ...base, content: "return { ok: true };\n" }),
		).rejects.toMatchObject({ status: 409, code: "name_conflict" });
		const overwritten = await service.importSkill({ ...base, content: "return { ok: true };\n", overwrite: true });
		expect(overwritten.changed).toBe(true);
		expect(listSkillRows(sql)[0]!.content).toBe("return { ok: true };\n");
	});

	it("URL 导入先审计：Python fence → 422，不写库", async () => {
		const fetchImpl = (async () =>
			new Response("# 步骤\n```python\nprint(1)\n```\n", {
				headers: { "content-type": "text/markdown" },
			})) as unknown as typeof fetch;
		const { sql, service } = setup({ fetchImpl });
		await expect(service.importSkill({ url: "https://example.com/skills/demo/SKILL.md" })).rejects.toMatchObject({
			status: 422,
			code: "audit_blocked",
		});
		expect(listSkillRows(sql)).toHaveLength(0);
	});

	it("URL 导入 legacy SKILL.md → warn 入库，哈希覆盖去 frontmatter 的正文", async () => {
		const text = "---\nname: imported-demo\ndescription: 演示\n---\n# 演示\n只写正文。\n";
		const fetchImpl = (async () => new Response(text, { headers: { "content-type": "text/markdown" } })) as unknown as typeof fetch;
		const { sql, service } = setup({ fetchImpl });
		const result = await service.importSkill({ url: "https://example.com/imported-demo/SKILL.md" });
		expect(result.name).toBe("imported-demo");
		expect(result.audit.status).toBe("warn");
		expect(result.audit.reasons.map((reason) => reason.rule)).toContain("I3");
		const row = listSkillRows(sql)[0]!;
		expect(row.content).toBe("# 演示\n只写正文。\n");
		expect(row.contentHash).toBe(await sha256Content("# 演示\n只写正文。\n"));
		expect(row.auditStatus).toBe("warn");
	});

	it("URL 导入内网地址 → 422，不抓取", async () => {
		let called = 0;
		const fetchImpl = (async () => {
			called += 1;
			return new Response("x");
		}) as unknown as typeof fetch;
		const { service } = setup({ fetchImpl });
		await expect(service.importSkill({ url: "https://127.0.0.1/SKILL.md" })).rejects.toMatchObject({ status: 422 });
		expect(called).toBe(0);
	});

	it("目录同名条目的哈希不匹配 → blocked（安装时校验）", async () => {
		const content = "# 正文\n";
		const entry = catalogEntry({ name: "hashed", contentHash: "sha256:" + "0".repeat(64) });
		const fetchImpl = (async () => new Response(`---\nname: hashed\n---\n${content}`, { headers: { "content-type": "text/markdown" } })) as unknown as typeof fetch;
		const { service } = setup({ fetchImpl, catalog: [entry] });
		await expect(service.importSkill({ url: "https://example.com/hashed/SKILL.md" })).rejects.toMatchObject({
			status: 422,
			code: "audit_blocked",
		});
	});
});

describe("Skill Hub：列表、筛选与审计详情", () => {
	const catalog = [
		catalogEntry({ name: "pure-js", contentHash: "sha256:" + "a".repeat(64), runtime: "javascript" }),
		catalogEntry({ name: "notes", contentHash: "sha256:" + "b".repeat(64), runtime: "prompt", tags: ["notes"] }),
		catalogEntry({ name: "csv-report", contentHash: "sha256:" + "c".repeat(64), runtime: "python", tags: ["csv"] }),
	];

	it("默认按 audit 排序（pass→warn→blocked），可用 runtime 筛 python", async () => {
		const { service } = setup({ catalog });
		const all = await service.hub({});
		expect(all.total).toBe(3);
		expect(all.skills.map((skill) => skill.name)).toEqual(["notes", "pure-js", "csv-report"]);
		expect(all.skills.map((skill) => skill.audit.status)).toEqual(["pass", "pass", "blocked"]);

		const python = await service.hub({ runtime: "python" });
		expect(python.skills.map((skill) => skill.name)).toEqual(["csv-report"]);
		const blocked = await service.hub({ audit: "blocked" });
		// 目录里的 python 条目 + 8 条社区技能（验收 9）
		expect(blocked.skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["csv-report", "brave-search", "vscode"]));
		expect(blocked.skills.filter((skill) => skill.name === "csv-report")).toHaveLength(1);
		const tags = await service.hub({ tag: "notes" });
		expect(tags.skills.map((skill) => skill.name)).toEqual(["notes"]);
		const js = await service.hub({ runtime: "js" });
		expect(js.skills.map((skill) => skill.name)).toEqual(["pure-js"]);
	});

	it("非法 runtime/audit → 400", async () => {
		const { service } = setup({ catalog });
		await expect(service.hub({ runtime: "ruby" })).rejects.toBeInstanceOf(SkillApiError);
		await expect(service.hub({ audit: "meh" })).rejects.toMatchObject({ status: 400, code: "bad_request" });
	});

	it("已安装标记、installedHash 与本地审计优先", async () => {
		const { service } = setup({ catalog });
		await service.importSkill({
			manifest: {
				schemaVersion: 1,
				name: "pure-js",
				version: "2.0.0",
				description: "本地版本",
				author: "hou",
				source: "https://example.com/pure-js",
				license: "MIT",
				runtime: "javascript",
				tags: [],
				requires: { tools: ["now"], bindings: [], network: [] },
				entry: "index.js",
			},
			content: "return await tools.now({});\n",
		});
		const hub = await service.hub({ installed: "1" });
		expect(hub.skills).toHaveLength(1);
		expect(hub.skills[0]!.installed).toBe(true);
		expect(hub.skills[0]!.installedHash).toBeDefined();
		expect(hub.skills[0]!.version).toBe("1.0.0");
		expect(hub.skills[0]!.audit.auditSource).toBe("local");
	});

	it("审计详情：已安装 → local；仅目录 → catalog；不存在 → 404", async () => {
		const { service } = setup({ catalog });
		const fromCatalog = await service.auditFor("notes");
		expect(fromCatalog.audit.auditSource).toBe("catalog");
		expect(fromCatalog.version).toBe("1.0.0");
		await expect(service.auditFor("missing")).rejects.toMatchObject({ status: 404, code: "not_found" });
		await expect(service.auditFor("Bad Name")).rejects.toMatchObject({ status: 400, code: "bad_request" });
	});

	it("目录条目缺 audit/哈希不一致 → blocked（fail closed）", async () => {
		const broken = { ...catalog[1]!, audit: undefined } as unknown as CatalogEntry;
		const { service } = setup({ catalog: [broken] });
		const hub = await service.hub({});
		expect(hub.skills[0]!.audit.status).toBe("blocked");
		expect(hub.skills[0]!.audit.reasons[0]!.rule).toBe("I1");
	});
});

describe("Skill Hub：埋点与 NERE-59 指标", () => {
	it("hub 打开 / 安装 / 加载 → metrics 与 lastInvokedAt 正确", async () => {
		const { sql, service } = setup();
		await service.hub({});
		await service.importSkill({
			manifest: {
				schemaVersion: 1,
				name: "clock",
				version: "1.0.0",
				description: "时钟",
				author: "hou",
				source: "https://example.com/clock",
				license: "MIT",
				runtime: "javascript",
				tags: [],
				requires: { tools: ["now"], bindings: [], network: [] },
				entry: "index.js",
			},
			content: "return await tools.now({});\n",
		});
		trackSkillCall(sql, "clock", "loaded");
		const metrics = service.metrics("1");
		expect(metrics.hubViews).toBeGreaterThanOrEqual(1);
		expect(metrics.installOk).toBe(1);
		expect(metrics.installed).toBe(1);
		expect(metrics.called7d).toBe(1);
	});

	it("listCompat 返回 lastInvokedAt（未调用为 null）", async () => {
		const { sql, service } = setup();
		service.addManual({ name: "manual", description: "手写", content: "# 正文" });
		expect(service.listCompat().skills[0]!).toMatchObject({ name: "manual", lastInvokedAt: null });
		trackSkillCall(sql, "manual", "invoked");
		const invoked = service.listCompat().skills[0] as { lastInvokedAt: number | null };
		expect(typeof invoked.lastInvokedAt).toBe("number");
		expect(service.metrics("1").called7d).toBe(1);
	});

	it("社区目录 8 条全部 blocked，且不可安装", () => {
		const { service } = setup();
		const community = service.community();
		expect(community.skills).toHaveLength(8);
		expect(community.skills.every((skill) => skill.audit_status === "blocked")).toBe(true);
		expect(community.skills.every((skill) => skill.audit.reasons[0]!.rule === "M3")).toBe(true);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillHubPanel } from "../../src/web/components/SkillHubPanel";
import { SkillHubRow } from "../../src/web/components/SkillHubRow";
import { api } from "../../src/web/lib/api";
import {
	BLOCKED_HINT,
	EMPTY_SKILL_HUB_FILTERS,
	HUB_RUNTIME_FILTERS,
	canInstallHubEntry,
	filterHubSkills,
	hasActiveHubFilters,
	hubEntryInstallUrl,
	isHubEntryUpdatable,
	parseHubPage,
	parseHubSkills,
	sortHubSkills,
	sourceHost,
	type SkillHubFilters,
} from "../../src/web/lib/skill-hub";
import type { SkillHubEntry } from "../../src/web/types";

/**
 * 验收用的 6 条示例（NERE-53 契约 §验收）：3 pass（纯提示词 / 纯 JS / TS+联网）、
 * 1 warn（声明网络但未使用）、2 blocked（Python / shell）。
 * 字段按契约 §5.2：source 是 URL，audit 是完整 AuditReport（reasons 为对象）。
 */
const RAW_SKILLS = [
	{
		name: "meeting-notes",
		version: "1.2.0",
		description: "把会议记录整理成结构化纪要，纯提示词技能，无需脚本。",
		author: "pi-skills",
		source: "https://github.com/badlogic/pi-skills/tree/main/meeting-notes",
		license: "MIT",
		runtime: "prompt",
		tags: ["writing", "notes"],
		contentHash: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		installed: false,
		audit: {
			status: "pass",
			reasons: [],
			detected: { runtime: "prompt", network: [], tools: [] },
			auditedAt: "2026-10-21T08:00:00Z",
			hash: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			rulesVersion: 1,
			auditSource: "local",
		},
	},
	{
		name: "pdf-to-markdown",
		version: "0.4.1",
		description: "把 PDF 拆成 Markdown，内置纯 JS 解析器。",
		author: "community",
		source: "https://github.com/example/skills/tree/main/pdf-to-markdown",
		license: "Apache-2.0",
		runtime: "javascript",
		tags: ["document", "pdf"],
		contentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
		installed: false,
		audit: {
			status: "pass",
			reasons: [],
			detected: { runtime: "javascript", network: [], tools: ["vfs"] },
		},
	},
	{
		name: "web-snapshot",
		version: "2.0.0",
		description: "抓取网页并截图归档，已声明 api.github.com 出站。",
		author: "community",
		source: "https://github.com/example/skills/tree/main/web-snapshot",
		license: "MIT",
		runtime: "typescript",
		tags: ["web", "screenshot"],
		contentHash: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		installed: false,
		audit: {
			status: "pass",
			reasons: [],
			detected: { runtime: "typescript", network: ["api.github.com"], tools: ["fetch", "write_file"] },
			hash: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		},
	},
	{
		name: "crm-sync",
		version: "1.0.0",
		description: "把客户记录同步到 CRM，声明了网络权限。",
		author: "acme",
		source: "https://skills.acme.dev/crm-sync",
		license: "UNLICENSED",
		runtime: "javascript",
		tags: ["crm"],
		contentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
		installed: true,
		installedHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
		audit: {
			status: "warning",
			reasons: [
				{
					rule: "S2",
					level: "warn",
					message: "声明了网络权限 crm.example.com，但正文未使用",
					evidence: "requires.network: crm.example.com",
				},
			],
			detected: { runtime: "javascript", network: ["crm.example.com"], tools: [] },
		},
	},
	{
		name: "legacy-report",
		version: "3.1.0",
		description: "用 Python 生成周报 PDF。",
		author: "legacy",
		source: "https://github.com/legacy/skills/tree/main/legacy-report",
		license: "GPL-3.0",
		runtime: "python",
		tags: ["report"],
		contentHash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
		installed: false,
		audit: {
			status: "blocked",
			reasons: [
				{
					rule: "M3",
					level: "blocked",
					message: "运行时 python 不受支持：仅支持 JS/TS 与纯提示词技能",
					evidence: "#!/usr/bin/env python3",
				},
			],
			detected: { runtime: "python", network: [], tools: ["requests"] },
			hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
		},
	},
	{
		name: "deploy-hook",
		version: "0.1.0",
		description: "部署完成后跑的 shell 钩子。",
		author: "legacy",
		source: "https://github.com/legacy/skills/tree/main/deploy-hook",
		license: "UNLICENSED",
		runtime: "shell",
		tags: ["deploy"],
		contentHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
		installed: false,
		audit: {
			status: "blocked",
			reasons: [
				{
					rule: "M3",
					level: "blocked",
					message: "检测到 `#!/usr/bin/env bash` 脚本；Worker 不能执行 shell",
					evidence: "#!/usr/bin/env bash",
				},
			],
			detected: { runtime: "shell", network: [], tools: ["bash"] },
		},
	},
];

const ENTRIES = parseHubSkills({ skills: RAW_SKILLS });
const byName = (name: string): SkillHubEntry => ENTRIES.find((entry) => entry.name === name)!;
const filters = (patch: Partial<SkillHubFilters>): SkillHubFilters => ({ ...EMPTY_SKILL_HUB_FILTERS, ...patch });

describe("parseHubSkills · 契约映射", () => {
	it("6 条示例按顺序解析，字段与审计详情齐全", () => {
		expect(ENTRIES.map((entry) => entry.name)).toEqual([
			"meeting-notes",
			"pdf-to-markdown",
			"web-snapshot",
			"crm-sync",
			"legacy-report",
			"deploy-hook",
		]);
		expect(byName("web-snapshot")).toMatchObject({
			version: "2.0.0",
			runtime: "typescript",
			tags: ["web", "screenshot"],
			license: "MIT",
			installed: false,
			audit: {
				status: "pass",
				detected: { runtime: "typescript", network: ["api.github.com"], tools: ["fetch", "write_file"] },
			},
		});
		expect(byName("web-snapshot").audit.hash).toBe(
			"sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		);
		expect(byName("meeting-notes").audit).toMatchObject({ rulesVersion: 1, auditSource: "local" });
	});

	it("AuditReason 对象保留 rule / level / message / evidence", () => {
		expect(byName("legacy-report").audit.reasons).toEqual([
			{
				rule: "M3",
				level: "blocked",
				message: "运行时 python 不受支持：仅支持 JS/TS 与纯提示词技能",
				evidence: "#!/usr/bin/env python3",
			},
		]);
	});

	it("早期字符串 reasons 仍兼容", () => {
		const entries = parseHubSkills({ skills: [{ name: "old", audit: { status: "warn", reasons: ["旧格式原因"] } }] });
		expect(entries[0]?.audit.reasons).toEqual([{ message: "旧格式原因" }]);
	});

	it("installed / installedHash 从服务端读取", () => {
		expect(byName("crm-sync").installed).toBe(true);
		expect(byName("crm-sync").installedHash).toMatch(/^sha256:333/);
		expect(isHubEntryUpdatable(byName("crm-sync"))).toBe(true);
		expect(isHubEntryUpdatable(byName("web-snapshot"))).toBe(false);
	});

	it("非数组 / 缺 skills 包装 → 空数组", () => {
		expect(parseHubSkills(null)).toEqual([]);
		expect(parseHubSkills("oops")).toEqual([]);
		expect(parseHubSkills({})).toEqual([]);
	});

	it("丢弃无名称条目；未知审计状态按 warn 并补原因", () => {
		const entries = parseHubSkills({
			skills: [{ description: "没有名字" }, { name: "mystery", audit: { status: "unknown" } }],
		});
		expect(entries.map((entry) => entry.name)).toEqual(["mystery"]);
		expect(entries[0]?.audit.status).toBe("warn");
		expect(entries[0]?.audit.reasons.map((reason) => reason.message).join()).toContain("审计状态缺失或无法识别");
	});

	it("warning / passed 等别名归一", () => {
		expect(byName("crm-sync").audit.status).toBe("warn");
		const entries = parseHubSkills({ skills: [{ name: "old", audit: { status: "passed" } }] });
		expect(entries[0]?.audit.status).toBe("pass");
	});
});

describe("parseHubPage · 列表响应包装（契约 §5.2）", () => {
	it("total / catalog / filters 都解析；runtimes 只留可安装三种", () => {
		const page = parseHubPage({
			skills: RAW_SKILLS,
			total: 6,
			nextOffset: null,
			catalog: { source: "remote", fetchedAt: "2026-10-22T01:00:00Z", stale: true, count: 6 },
			filters: {
				runtimes: ["prompt", "javascript", "typescript", "python", "shell"],
				tags: ["web", "crm"],
				sources: ["github.com"],
			},
		});
		expect(page.entries).toHaveLength(6);
		expect(page.total).toBe(6);
		expect(page.catalog).toMatchObject({ source: "remote", stale: true, count: 6 });
		expect(page.options.runtimes).toEqual(["prompt", "javascript", "typescript"]);
		expect(page.options.tags).toEqual(["web", "crm"]);
		expect(page.options.sources).toEqual(["github.com"]);
	});

	it("缺 catalog / filters 时给安全默认值", () => {
		const page = parseHubPage({ skills: [] });
		expect(page.catalog).toBeNull();
		expect(page.options).toEqual({ runtimes: [], tags: [], sources: [] });
		expect(page.total).toBe(0);
	});
});

describe("filterHubSkills · 筛选维度（验收 1）", () => {
	it("runtime 筛选项只有 prompt / javascript / typescript", () => {
		expect(HUB_RUNTIME_FILTERS.map((option) => option.value)).toEqual([
			"",
			"javascript,typescript",
			"typescript",
			"javascript",
			"prompt",
		]);
		for (const option of HUB_RUNTIME_FILTERS) {
			for (const value of option.value.split(",").filter(Boolean)) {
				expect(["prompt", "javascript", "typescript"]).toContain(value);
			}
		}
	});

	it("runtime=TS 只剩 JS/TS 里的 TypeScript 条目", () => {
		expect(filterHubSkills(ENTRIES, filters({ runtime: "typescript" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
		expect(filterHubSkills(ENTRIES, filters({ runtime: "ts" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
	});

	it("runtime=JS/TS 分组保留全部 JS/TS，Python / shell 被排除", () => {
		expect(filterHubSkills(ENTRIES, filters({ runtime: "javascript,typescript" })).map((entry) => entry.name)).toEqual([
			"pdf-to-markdown",
			"web-snapshot",
			"crm-sync",
		]);
	});

	it("audit=blocked 只剩 Python 与 shell 两条", () => {
		expect(filterHubSkills(ENTRIES, filters({ audit: "blocked" })).map((entry) => entry.name)).toEqual([
			"legacy-report",
			"deploy-hook",
		]);
	});

	it("搜索命中名称、描述与标签（大小写不敏感）", () => {
		expect(filterHubSkills(ENTRIES, filters({ q: "CRM" })).map((entry) => entry.name)).toEqual(["crm-sync"]);
		expect(filterHubSkills(ENTRIES, filters({ q: "纪要" })).map((entry) => entry.name)).toEqual(["meeting-notes"]);
		expect(filterHubSkills(ENTRIES, filters({ q: "screenshot" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
		expect(filterHubSkills(ENTRIES, filters({ q: "不存在的技能" }))).toEqual([]);
	});

	it("tag / source(host) / 组合筛选", () => {
		expect(filterHubSkills(ENTRIES, filters({ tag: "web" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
		expect(filterHubSkills(ENTRIES, filters({ source: "acme" })).map((entry) => entry.name)).toEqual(["crm-sync"]);
		expect(filterHubSkills(ENTRIES, filters({ source: "github.com" }))).toHaveLength(5);
		expect(filterHubSkills(ENTRIES, filters({ runtime: "javascript", audit: "pass" })).map((entry) => entry.name)).toEqual([
			"pdf-to-markdown",
		]);
	});

	it("sourceHost 从 URL 取 host，local 原样保留", () => {
		expect(sourceHost("https://github.com/acme/skills/tree/main/crm-sync")).toBe("github.com");
		expect(sourceHost("local")).toBe("local");
		expect(sourceHost("")).toBe("");
	});
});

describe("sortHubSkills · 默认 audit 优先", () => {
	it("pass → warn → blocked，同级按名称", () => {
		const sorted = sortHubSkills(ENTRIES);
		expect(sorted.map((entry) => entry.audit.status)).toEqual(["pass", "pass", "pass", "warn", "blocked", "blocked"]);
		expect(sorted.slice(-2).map((entry) => entry.name)).toEqual(["deploy-hook", "legacy-report"]);
	});

	it("不修改入参", () => {
		const before = ENTRIES.map((entry) => entry.name);
		sortHubSkills(ENTRIES);
		expect(ENTRIES.map((entry) => entry.name)).toEqual(before);
	});
});

describe("安装门槛（验收 2）", () => {
	it("blocked 一律不可安装，即使有 http(s) 来源", () => {
		expect(byName("legacy-report").source).toMatch(/^https:\/\//);
		expect(canInstallHubEntry(byName("legacy-report"))).toBe(false);
		expect(canInstallHubEntry(byName("deploy-hook"))).toBe(false);
	});

	it("pass / warn 有 http(s) 来源时可安装", () => {
		expect(canInstallHubEntry(byName("web-snapshot"))).toBe(true);
		expect(canInstallHubEntry(byName("crm-sync"))).toBe(true);
		expect(hubEntryInstallUrl(byName("web-snapshot"))).toBe("https://github.com/example/skills/tree/main/web-snapshot");
	});

	it("没有安装地址时不发请求", () => {
		const entry = { ...byName("meeting-notes"), source: "local" };
		expect(hubEntryInstallUrl(entry)).toBe("");
		expect(canInstallHubEntry(entry)).toBe(false);
		expect(hasActiveHubFilters(EMPTY_SKILL_HUB_FILTERS)).toBe(false);
		expect(hasActiveHubFilters(filters({ audit: "pass" }))).toBe(true);
	});
});

describe("api.skillHub · 查询串", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("只拼契约里的参数，空值省略", async () => {
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ skills: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);

		await api.skillHub({
			q: "周报",
			runtime: "typescript",
			audit: "blocked",
			source: "github.com",
			origin: "remote",
			installed: "0",
			sort: "name",
			limit: 50,
			offset: 20,
		});
		await api.skillHub();
		expect(calls).toEqual([
			"/api/skills/hub?q=%E5%91%A8%E6%8A%A5&runtime=typescript&audit=blocked&source=github.com&origin=remote&installed=0&sort=name&limit=50&offset=20",
			"/api/skills/hub",
		]);
	});
});

describe("api.importSkill · 422 审计拦截（契约 §5.4）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("422 不抛错，带出 code / auditStatus / details.audit.reasons", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: false,
					installed: false,
					error: "审计未通过，技能未安装",
					code: "audit_blocked",
					details: {
						audit: {
							status: "blocked",
							reasons: [
								{
									rule: "M3",
									level: "blocked",
									message: "运行时 python 不受支持：仅支持 JS/TS 与纯提示词技能",
									evidence: "#!/usr/bin/env python3",
								},
							],
							detected: { runtime: "python", network: [], tools: [] },
						},
					},
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
			),
		);

		const result = await api.importSkill("https://example.com/skills/legacy-report/skill.json");
		expect(result).toMatchObject({
			ok: false,
			installed: false,
			code: "audit_blocked",
			auditStatus: "blocked",
			reasons: ["运行时 python 不受支持：仅支持 JS/TS 与纯提示词技能"],
		});
	});

	it("照样读取成功响应；非 422 失败仍抛 ApiError", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true, installed: true, changed: false, name: "pure-js" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(api.importSkill("https://example.com/skill.json")).resolves.toMatchObject({
			ok: true,
			installed: true,
			name: "pure-js",
		});

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "服务暂不可用" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(api.importSkill("https://example.com/skill.json")).rejects.toMatchObject({ status: 503 });
	});
});

describe("SkillHubRow · blocked 详情（验收 2）", () => {
	it("安装按钮禁用、原因可见、点按不发请求", () => {
		const entry = byName("legacy-report");
		const onClick = vi.fn();
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={entry}
				expanded
				installed={false}
				installing={false}
				onToggle={() => {}}
				onInstall={onClick}
			/>,
		);
		expect(html).toContain(BLOCKED_HINT);
		expect(html).toContain("运行时 python 不受支持");
		expect(html).toContain("python3");
		expect(html).toContain("[M3]");
		expect(html).toContain("Python");
		expect(html).toContain("disabled");
		expect(html).toContain('aria-label="不可安装技能 legacy-report"');
		expect(html).toContain("不可安装");
		// 组件只在 installable 时才回调：blocked 的按钮禁用且 onClick 内有 guard。
		expect(canInstallHubEntry(entry)).toBe(false);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("pass 条目展开审计报告：hash、出站域名、工具、来源、许可证", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("web-snapshot")}
				expanded
				installed={false}
				installing={false}
				onToggle={() => {}}
				onInstall={() => {}}
			/>,
		);
		expect(html).toContain("审计通过");
		expect(html).toContain("api.github.com");
		expect(html).toContain("fetch、write_file");
		expect(html).toContain("2c26b46b68ffc68f");
		expect(html).toContain("MIT");
		expect(html).toContain('aria-label="安装技能 web-snapshot"');
		expect(html).not.toContain(BLOCKED_HINT);
	});

	it("已安装条目显示「已安装 / 重新安装」", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("meeting-notes")}
				expanded
				installed
				installing={false}
				onToggle={() => {}}
				onInstall={() => {}}
			/>,
		);
		expect(html).toContain("已安装");
		expect(html).toContain("重新安装");
	});

	it("installedHash 与 contentHash 不同 → 可更新", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("crm-sync")}
				expanded
				installed={false}
				installing={false}
				onToggle={() => {}}
				onInstall={() => {}}
			/>,
		);
		expect(html).toContain("可更新");
		expect(html).toContain('aria-label="更新技能 crm-sync"');
	});
});

describe("SkillHubPanel · 首屏状态", () => {
	it("首次渲染是 loading 骨架，筛选控件齐全", () => {
		const html = renderToStaticMarkup(<SkillHubPanel installed={[]} onInstall={async () => true} />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("搜索技能名称、描述或标签");
		expect(html).toContain('aria-label="按运行时筛选"');
		expect(html).toContain('aria-label="按审计状态筛选"');
		expect(html).toContain('aria-label="按标签筛选"');
		expect(html).toContain('aria-label="按来源筛选"');
		expect((html.match(/animate-pulse/g) ?? []).length).toBe(3);
		expect(html).toContain("正在加载技能列表");
	});
});

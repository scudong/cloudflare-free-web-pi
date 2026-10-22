import { describe, expect, it } from "vitest";
import {
	auditSkill,
	checkImportUrl,
	isValidNetworkHost,
	networkCovers,
	parseManifest,
	slugifySkillName,
	stripFrontmatter,
	type SkillManifest,
} from "../../src/worker/lib/skill-audit";
import { rewriteSkillStub } from "../../src/worker/lib/skill-import";

function manifest(overrides: Record<string, unknown> = {}): SkillManifest {
	const parsed = parseManifest({
		schemaVersion: 1,
		name: "pure-js",
		version: "1.0.0",
		description: "读取当前时间",
		author: "hou",
		source: "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/pure-js",
		license: "MIT",
		runtime: "javascript",
		tags: ["utility"],
		requires: { tools: ["now"], bindings: [], network: [] },
		entry: "index.js",
		contentHash: "sha256:589f21f9e11c4ab10c7a103197086d920b81d611d00c16ea7df5c07592ccebe5",
		...overrides,
	});
	if (!parsed.ok) throw new Error(parsed.reason.message);
	return parsed.manifest;
}

const RULES = (report: { reasons: { rule: string }[] }) => report.reasons.map((reason) => reason.rule);

describe("skill-audit：契约 §8 的五个验收样例", () => {
	it("8.1 纯 JS 无网络 → pass，哈希与契约一致", async () => {
		const content = "const now = await tools.now({});\nreturn { now };\n";
		const report = await auditSkill({
			manifest: manifest(),
			content,
			filename: "index.js",
			auditedAt: "2026-10-22T00:00:00Z",
		});
		expect(report.status).toBe("pass");
		expect(report.reasons).toEqual([]);
		expect(report.detected).toEqual({ runtime: "javascript", network: [], tools: ["now"] });
		expect(report.hash).toBe("sha256:589f21f9e11c4ab10c7a103197086d920b81d611d00c16ea7df5c07592ccebe5");
	});

	it("8.2 TypeScript + 声明 fetch 域名 → pass", async () => {
		const m = manifest({
			name: "github-issues",
			version: "1.2.0",
			description: "列出仓库的最新 issue",
			runtime: "typescript",
			tags: ["github", "api"],
			requires: { tools: ["http_fetch"], bindings: [], network: ["api.github.com"] },
			entry: "index.js",
			entrySource: "index.ts",
			contentHash: "sha256:27c91b161e9d6155f5c8740f45e006a24151f33f7d010dc03e6fb2c14843ae8f",
		});
		const content = 'const { repo } = load("args");\nconst page = await tools.http_fetch({ url: `https://api.github.com/repos/${repo}` });\nreturn page;\n';
		const report = await auditSkill({ manifest: m, content, filename: "index.js" });
		expect(report.status).toBe("pass");
		expect(report.detected).toEqual({ runtime: "typescript", network: ["api.github.com"], tools: ["http_fetch"] });
		expect(report.hash).toBe("sha256:27c91b161e9d6155f5c8740f45e006a24151f33f7d010dc03e6fb2c14843ae8f");
	});

	it("8.3 纯提示词 → pass；正文工具名与声明一致", async () => {
		const m = manifest({
			name: "offline-notes",
			version: "1.0.0",
			description: "用工作台文件做离线笔记",
			runtime: "prompt",
			tags: ["notes", "offline"],
			requires: { tools: ["read_file", "list_files", "write_file"], bindings: [], network: [] },
			entry: undefined,
			contentHash: "sha256:dbdb7947e6a4451a2ee2b334b5a13e2e0252b58c3ac3942703a4913d9848a80d",
		});
		const content =
			"---\nname: offline-notes\ndescription: 用工作台文件做离线笔记\n---\n# 离线笔记\n1. 用 `list_files` 查看已有笔记。\n2. 用 `read_file` 读取，用 `write_file` 写回。\n只使用工作台文件，不访问网络。\n";
		const report = await auditSkill({ manifest: m, content, filename: "SKILL.md" });
		expect(report.status).toBe("pass");
		expect(report.reasons).toEqual([]);
		expect(report.detected).toEqual({
			runtime: "prompt",
			network: [],
			tools: ["list_files", "read_file", "write_file"],
		});
		expect(report.hash).toBe("sha256:dbdb7947e6a4451a2ee2b334b5a13e2e0252b58c3ac3942703a4913d9848a80d");
	});

	it("8.4 Python → blocked，至少 M3 + L3 + L5", async () => {
		const m = manifest({
			name: "csv-report",
			description: "用 Python 生成 CSV 报告",
			runtime: "python",
			tags: ["csv"],
			requires: { tools: [], bindings: [], network: [] },
			entry: "main.py",
			contentHash: "sha256:8f9153bfdab71afd056f19a2a44a442746e4d193b5e6ec378d2f7a6a886a6d10",
		});
		const content =
			'#!/usr/bin/env python3\nimport csv\nimport sys\n\ndef main() -> None:\n    with open(sys.argv[1], newline="") as f:\n        for row in csv.DictReader(f):\n            print(row)\n\nif __name__ == "__main__":\n    main()\n';
		const report = await auditSkill({ manifest: m, content, filename: "main.py" });
		expect(report.status).toBe("blocked");
		expect(RULES(report)).toEqual(expect.arrayContaining(["M3", "L3", "L5"]));
		expect(report.detected).toEqual({ runtime: "python", network: [], tools: [] });
		expect(report.hash).toBe("sha256:8f9153bfdab71afd056f19a2a44a442746e4d193b5e6ec378d2f7a6a886a6d10");
	});

	it("8.5 Shell → blocked，M3 + L3 + L5", async () => {
		const m = manifest({
			name: "db-backup",
			description: "用 shell 打包笔记备份",
			runtime: "shell",
			tags: ["backup"],
			requires: { tools: [], bindings: [], network: [] },
			entry: "backup.sh",
			contentHash: "sha256:b2e22f3cde88b5d471546cff6af7799e5e709f85bae3597501561fdbaff2e44e",
		});
		const content = "#!/usr/bin/env bash\nset -euo pipefail\ntar -czf backup.tgz \"$HOME/notes\"\necho \"backup written\"\n";
		const report = await auditSkill({ manifest: m, content, filename: "backup.sh" });
		expect(report.status).toBe("blocked");
		expect(RULES(report)).toEqual(expect.arrayContaining(["M3", "L3", "L5"]));
		expect(report.hash).toBe("sha256:b2e22f3cde88b5d471546cff6af7799e5e709f85bae3597501561fdbaff2e44e");
	});

	it("8.6 warn：声明未使用的域名 + 元数据缺失", async () => {
		const m = manifest({
			name: "weather-brief",
			description: "查天气写简报",
			runtime: "prompt",
			license: "UNLICENSED",
			requires: { tools: [], bindings: [], network: ["api.open-meteo.com", "api.example.com"] },
			entry: undefined,
			contentHash: undefined,
		});
		const content = "# 天气简报\n1. 用 http_fetch 访问 `api.open-meteo.com` 取预报。\n";
		const report = await auditSkill({ manifest: m, content, filename: "SKILL.md" });
		expect(report.status).toBe("warn");
		expect(RULES(report)).toEqual(expect.arrayContaining(["C4", "I3"]));
	});
});

describe("skill-audit：误报控制与规则边界", () => {
	it("正文裸词 python 不触发 blocked（只扫 fence/shebang/命令行）", async () => {
		const report = await auditSkill({
			manifest: manifest({ name: "no-python", runtime: "prompt", entry: undefined, requires: { tools: [], bindings: [], network: [] } }),
			content: "# 说明\n本技能不需要 Python，也不执行 shell。\n",
			filename: "SKILL.md",
		});
		expect(report.status).toBe("pass");
	});

	it("prompt 里的 python fence 与宿主命令 → blocked", async () => {
		const report = await auditSkill({
			manifest: manifest({ name: "bad-prompt", runtime: "prompt", entry: undefined, requires: { tools: [], bindings: [], network: [] } }),
			content: "# 步骤\n```python\nprint(1)\n```\n然后运行：\npython main.py\n",
			filename: "SKILL.md",
		});
		expect(report.status).toBe("blocked");
		expect(RULES(report)).toEqual(expect.arrayContaining(["S1", "S2"]));
	});

	it("注释/字符串里的 child_process 不误报，真实调用 blocked", async () => {
		const m = manifest({ requires: { tools: [], bindings: [], network: [] } });
		const harmless = await auditSkill({
			manifest: m,
			content: '// 不要用 child_process\nconst note = "fs and process are unavailable";\nreturn note;\n',
			filename: "index.js",
		});
		expect(harmless.status).toBe("pass");
		const harmful = await auditSkill({
			manifest: m,
			content: 'const cp = require("child_process");\nreturn cp;\n',
			filename: "index.js",
		});
		expect(harmful.status).toBe("blocked");
		expect(harmful.reasons.map((reason) => reason.rule)).toContain("C1");
	});

	it("使用未声明域名 → C3 warn；声明未使用工具 → C7 warn", async () => {
		const m = manifest({
			requires: { tools: ["now"], bindings: [], network: [] },
		});
		const report = await auditSkill({
			manifest: m,
			content: 'const data = await tools.http_fetch({ url: "https://evil.example.net/x" });\nreturn data;\n',
			filename: "index.js",
		});
		expect(report.status).toBe("warn");
		expect(RULES(report)).toEqual(expect.arrayContaining(["C3", "C5", "C7"]));
	});

	it("禁用工具声明/调用 → blocked", async () => {
		const declared = await auditSkill({
			manifest: manifest({ requires: { tools: ["install_skill"], bindings: [], network: [] } }),
			content: "return 1;\n",
			filename: "index.js",
		});
		expect(declared.status).toBe("blocked");
		expect(RULES(declared)).toContain("M5");
		const called = await auditSkill({
			manifest: manifest({ requires: { tools: [], bindings: [], network: [] } }),
			content: "await tools.dispatch_tasks({ prompts: [] });\n",
			filename: "index.js",
		});
		expect(called.status).toBe("blocked");
		expect(RULES(called)).toContain("C6");
	});

	it("疑似密钥 → M7 blocked，证据截断", async () => {
		const report = await auditSkill({
			manifest: manifest(),
			content: 'const key = "sk-abcdefghijklmnopqrstuvwxyz012345";\nreturn key;\n',
			filename: "index.js",
		});
		expect(report.status).toBe("blocked");
		const reason = report.reasons.find((item) => item.rule === "M7");
		expect(reason?.evidence?.length ?? 0).toBeLessThanOrEqual(120);
		expect(reason?.evidence).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
	});

	it("executedAt/hash 之外确定性：同一输入两次 reasons 相同", async () => {
		const input = {
			manifest: manifest({ requires: { tools: [], bindings: [], network: [] } }),
			content: "return 1;\n",
			filename: "index.js",
		};
		const a = await auditSkill({ ...input, auditedAt: "2026-01-01T00:00:00Z" });
		const b = await auditSkill({ ...input, auditedAt: "2026-01-01T00:00:00Z" });
		expect(a).toEqual(b);
	});
});

describe("skill-audit：导入 URL 与 manifest 解析", () => {
	it("X1 非 HTTPS / X2 内网与 IP 字面量", () => {
		expect(checkImportUrl("http://example.com/a.md").ok).toBe(false);
		expect(checkImportUrl("https://127.0.0.1/x").ok).toBe(false);
		expect(checkImportUrl("https://localhost/x").ok).toBe(false);
		expect(checkImportUrl("https://10.0.0.2/x").ok).toBe(false);
		expect(checkImportUrl("https://api.github.com/x").ok).toBe(true);
	});

	it("网络声明校验与通配覆盖", () => {
		expect(isValidNetworkHost("api.github.com")).toBe(true);
		expect(isValidNetworkHost("*.githubusercontent.com")).toBe(true);
		expect(isValidNetworkHost("*")).toBe(false);
		expect(isValidNetworkHost("*.com")).toBe(false);
		expect(isValidNetworkHost("https://a.com")).toBe(false);
		expect(isValidNetworkHost("192.168.1.1")).toBe(false);
		expect(networkCovers("*.example.com", "a.example.com")).toBe(true);
		expect(networkCovers("*.example.com", "a.b.example.com")).toBe(false);
	});

	it("manifest 未知字段 → M1 拒绝", () => {
		const parsed = parseManifest({
			schemaVersion: 1,
			name: "demo",
			version: "1.0.0",
			description: "d",
			author: "a",
			source: "local",
			license: "MIT",
			runtime: "prompt",
			tags: [],
			requires: { tools: [], bindings: [], network: [] },
			typo: true,
		});
		expect(parsed.ok).toBe(false);
	});

	it("frontmatter 剥离与名字归一化", () => {
		expect(stripFrontmatter("---\nname: x\n---\nbody\n")).toBe("body\n");
		expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
		expect(slugifySkillName("Hello World!")).toBe("hello-world");
		expect(slugifySkillName("___")).toBe("");
		expect(rewriteSkillStub('Call the Skill tool with "x-y".')).toContain('load_skill("x-y")');
	});
});

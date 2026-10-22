import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * NERE-81 的静态验收：这些都是「数字 / 位置」类约束，单测直接读源码断言，
 * 避免以后重构时悄悄回退（尤其是把 api.* 又写回组件、或宽度又读回 railView）。
 */

describe("P2-1 左栏宽度读生效视图（NERE-81）", () => {
	const app = read("src/web/App.tsx");

	it("宽度用 leftPaneWidth(activeRailView, leftWidth)，不再判断原始 railView", () => {
		expect(app).toContain("leftPaneWidth(activeRailView, leftWidth)");
		expect(app).not.toContain('railView === "sessions"');
	});

	it("activeRailView 由 effectiveRailView 派生", () => {
		expect(app).toContain("effectiveRailView(railView");
	});
});

describe("P2-3 SettingsDialog 收敛到 hook（NERE-81）", () => {
	const dialog = read("src/web/components/SettingsDialog.tsx");
	const hook = read("src/web/hooks/useSettingsData.ts");

	it("SettingsDialog 内 api.* = 0", () => {
		expect(count(dialog, "api.")).toBe(0);
	});

	it("取数全部在 hooks/useSettingsData.ts", () => {
		expect(count(hook, "api.")).toBeGreaterThan(0);
		// 展示用常量（含 api. 字样）放在 lib，避免静态检查误判
		expect(hook).not.toContain("api.deepseek.com");
	});

	it("部署自检不再单独拉 /api/settings（用 bootstrap 的 kbRetrieval）", () => {
		expect(hook).not.toContain("api.settings(");
		expect(hook).toContain("kbRetrieval");
	});
});

describe("P2-4 弹窗互斥收进一个 overlay（NERE-81）", () => {
	const app = read("src/web/App.tsx");

	it("App 不再有 setSettingsOpen / setActivePanel", () => {
		expect(count(app, "setSettingsOpen")).toBe(0);
		expect(count(app, "setActivePanel")).toBe(0);
	});

	it("设置与面板都由 lib/panels 的 overlay 派生", () => {
		expect(app).toContain("panelOf(panel)");
		expect(app).toContain("isSettingsOpen(panel)");
	});
});

describe("P2-2 弹窗分包（NERE-81）", () => {
	const app = read("src/web/App.tsx");
	const vite = read("src/web/vite.config.mts");

	it("设置 / 知识库+MCP / 技能都走动态 import", () => {
		expect(app).toContain('import("./components/SettingsDialog")');
		expect(app).toContain('import("./components/PanelDialogs")');
		expect(app).toContain('import("./components/SkillPanel")');
	});

	it("vite.config.mts 写明首包 gzip 预算 150 KB", () => {
		expect(vite).toContain("150 KB");
	});
});

describe("P2-5 frontend-map 与实际一致（NERE-81）", () => {
	const map = read("docs/frontend-map.md");
	const appLines = read("src/web/App.tsx").split("\n").length - 1;
	const dialogApi = count(read("src/web/components/SettingsDialog.tsx"), "api.");

	it("App 行数一致", () => {
		expect(map).toContain(`App（页面层，${appLines} 行）`);
	});

	it("SettingsDialog api 数一致（0）", () => {
		expect(map).toContain("| `SettingsDialog.tsx` | 0 |");
		expect(dialogApi).toBe(0);
	});

	it("KbImport 已入组件表", () => {
		expect(map).toContain("KbImport");
	});

	it("状态表补了 kbFocus / kbFocusSeq", () => {
		expect(map).toContain("`kbFocus`");
		expect(map).toContain("`kbFocusSeq`");
	});
});

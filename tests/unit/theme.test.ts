import { describe, expect, it } from "vitest";
import { THEMES, applyTheme, isThemeId, readTheme } from "../../src/web/lib/theme";

describe("主题注册表", () => {
	it("四套主题齐全且 id 唯一", () => {
		expect(THEMES.map((t) => t.id)).toEqual(["dark", "light", "sepia", "midnight"]);
		expect(new Set(THEMES.map((t) => t.id)).size).toBe(4);
	});

	it("每套主题都有标签、色块与状态栏色", () => {
		for (const theme of THEMES) {
			expect(theme.label.length).toBeGreaterThan(0);
			expect(theme.swatch).toMatch(/^#[0-9a-f]{6}$/i);
			expect(theme.color).toMatch(/^#[0-9a-f]{6}$/i);
			expect(["dark", "light"]).toContain(theme.scheme);
		}
	});

	it("isThemeId 只认已注册的 id", () => {
		expect(isThemeId("sepia")).toBe(true);
		expect(isThemeId("dracula")).toBe(false);
	});
});

describe("主题读写（无 DOM 时安全降级）", () => {
	it("无法访问 localStorage 时回落到浅色", () => {
		expect(readTheme()).toBe("light");
	});

	it("applyTheme 在无 DOM 环境不抛错", () => {
		expect(() => applyTheme("midnight")).not.toThrow();
	});
});

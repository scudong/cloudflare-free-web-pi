/** 主题（v0.24.0）：深色 / 浅色 / 米黄 / 午夜蓝。全部靠 CSS 变量覆盖实现，组件无需感知。 */

export type ThemeId = "dark" | "light" | "sepia" | "midnight";

export interface ThemeMeta {
	id: ThemeId;
	label: string;
	icon: string;
	scheme: "dark" | "light";
	/** 浏览器地址栏 / 状态栏颜色。 */
	color: string;
	/** 外观选择器里的预览色块。 */
	swatch: string;
}

export const THEMES: ThemeMeta[] = [
	{ id: "dark", label: "深色", icon: "🌙", scheme: "dark", color: "#020617", swatch: "#0f172a" },
	{ id: "light", label: "浅色", icon: "☀️", scheme: "light", color: "#f8fafc", swatch: "#f8fafc" },
	{ id: "sepia", label: "米黄", icon: "📜", scheme: "light", color: "#f4eee1", swatch: "#f4eee1" },
	{ id: "midnight", label: "午夜蓝", icon: "🌌", scheme: "dark", color: "#060b18", swatch: "#0d1830" },
];

export const THEME_KEY = "pi-theme";
const THEME_CLASSES = ["theme-light", "theme-sepia", "theme-midnight"];

export function isThemeId(value: string): value is ThemeId {
	return THEMES.some((t) => t.id === value);
}

/** 读当前主题：URL 参数 > localStorage > 深色；system 按媒体查询解析。 */
export function readTheme(): ThemeId {
	try {
		const raw = new URLSearchParams(window.location.search).get("theme") ?? localStorage.getItem(THEME_KEY) ?? "dark";
		if (raw === "system") return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
		return isThemeId(raw) ? raw : "dark";
	} catch {
		return "dark";
	}
}

/** 应用主题：切换 html 上的 theme-* 类 + 更新 meta + 记住选择。 */
export function applyTheme(id: ThemeId): void {
	const meta = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
	const root = document.documentElement;
	for (const cls of THEME_CLASSES) root.classList.remove(cls);
	if (meta.id !== "dark") root.classList.add(`theme-${meta.id}`);
	document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", meta.scheme);
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", meta.color);
	try {
		localStorage.setItem(THEME_KEY, meta.id);
	} catch {
		// 无 localStorage 时仅本次会话生效
	}
}

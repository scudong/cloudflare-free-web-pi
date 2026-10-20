/**
 * 主题（v0.25.0）：深色 / 浅色 / 米黄 / 午夜蓝。
 * 调色板取自 Arco Design（字节跳动开源设计系统）：灰阶 gray-1..10 + 品牌蓝 #165DFF。
 * 全部靠 CSS 变量覆盖实现，组件无需感知。
 */

export type ThemeId = "dark" | "light" | "sepia" | "midnight";

export interface ThemeMeta {
	id: ThemeId;
	label: string;
	scheme: "dark" | "light";
	/** 浏览器地址栏 / 状态栏颜色。 */
	color: string;
	/** 外观选择器里的预览色块。 */
	swatch: string;
}

export const THEMES: ThemeMeta[] = [
	{ id: "dark", label: "深色", scheme: "dark", color: "#17171a", swatch: "#232324" },
	{ id: "light", label: "浅色", scheme: "light", color: "#f7f8fa", swatch: "#f7f8fa" },
	{ id: "sepia", label: "米黄", scheme: "light", color: "#fcf8ec", swatch: "#f7efd9" },
	{ id: "midnight", label: "午夜蓝", scheme: "dark", color: "#0b1220", swatch: "#1a2440" },
];

export const THEME_KEY = "pi-theme";
const THEME_CLASSES = ["theme-light", "theme-sepia", "theme-midnight"];

export function isThemeId(value: string): value is ThemeId {
	return THEMES.some((t) => t.id === value);
}

/** 读当前主题：URL 参数 > localStorage > 浅色（首次进入默认，v0.43.1）；system 按媒体查询解析。 */
export function readTheme(): ThemeId {
	try {
		const raw = new URLSearchParams(window.location.search).get("theme") ?? localStorage.getItem(THEME_KEY) ?? "light";
		if (raw === "system") return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
		return isThemeId(raw) ? raw : "light";
	} catch {
		return "light";
	}
}

/** 应用主题：切换 html 上的 theme-* 类 + 更新 meta + 记住选择。 */
export function applyTheme(id: ThemeId): void {
	const meta = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
	try {
		const root = document.documentElement;
		for (const cls of THEME_CLASSES) root.classList.remove(cls);
		if (meta.id !== "dark") root.classList.add(`theme-${meta.id}`);
		document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", meta.scheme);
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", meta.color);
	} catch {
		// 无 DOM（测试 / SSR）时只跳过视觉部分
	}
	try {
		localStorage.setItem(THEME_KEY, meta.id);
	} catch {
		// 无 localStorage 时仅本次会话生效
	}
}

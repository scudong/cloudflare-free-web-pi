import { describe, expect, it } from "vitest";
import { loadBoolOrNull, saveBool } from "../../src/web/lib/localStore";
import { LEFT_OPEN_KEY, selectRailView } from "../../src/web/lib/layout";

describe("selectRailView · 收起左栏后点 Rail（NERE-75 P1-3）", () => {
	it("桌面端：一律展开左栏并写回偏好", () => {
		const opened: boolean[] = [];
		const saved: [string, boolean][] = [];
		selectRailView(
			true,
			(value) => opened.push(value),
			(key, value) => saved.push([key, value]),
		);
		expect(opened).toEqual([true]);
		expect(saved).toEqual([[LEFT_OPEN_KEY, true]]);
		expect(LEFT_OPEN_KEY).toBe("pi-harness.left-open");
	});

	it("桌面端写回的值能被 loadBoolOrNull 读回为 true（saveBool 用 \"1\" 编码）", () => {
		const data = new Map<string, string>();
		const fakeWindow = {
			localStorage: {
				getItem: (key: string) => data.get(key) ?? null,
				setItem: (key: string, value: string) => {
					data.set(key, value);
				},
			},
		};
		const globalScope = globalThis as unknown as { window?: unknown; localStorage?: unknown };
		const previousWindow = globalScope.window;
		const previousLocalStorage = globalScope.localStorage;
		globalScope.window = fakeWindow;
		globalScope.localStorage = fakeWindow.localStorage;
		try {
			selectRailView(true, () => {}, saveBool);
			expect(data.get(LEFT_OPEN_KEY)).toBe("1");
			expect(loadBoolOrNull(LEFT_OPEN_KEY)).toBe(true);
		} finally {
			globalScope.window = previousWindow;
			globalScope.localStorage = previousLocalStorage;
		}
	});

	it("移动端 Rail 不渲染：不改状态、不写存储", () => {
		const opened: boolean[] = [];
		const saved: [string, boolean][] = [];
		selectRailView(
			false,
			(value) => opened.push(value),
			(key, value) => saved.push([key, value]),
		);
		expect(opened).toEqual([]);
		expect(saved).toEqual([]);
	});
});

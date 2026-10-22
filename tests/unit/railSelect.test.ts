import { describe, expect, it } from "vitest";
import { loadBoolOrNull, saveBool } from "../../src/web/lib/localStore";
import { LEFT_OPEN_KEY, effectiveRailView, leftPaneWidth, selectRailView } from "../../src/web/lib/layout";

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

describe("左栏宽度读生效视图（NERE-81 P2-1）", () => {
	it("非 owner 的 railView=\"users\" 回落到会话列表", () => {
		expect(effectiveRailView("users", { owner: false, sharesAvailable: true })).toBe("sessions");
		expect(effectiveRailView("users", { owner: true, sharesAvailable: true })).toBe("users");
	});

	it("分享接口未上线时 railView=\"shares\" 回落到会话列表", () => {
		expect(effectiveRailView("shares", { owner: true, sharesAvailable: false })).toBe("sessions");
		expect(effectiveRailView("shares", { owner: true, sharesAvailable: true })).toBe("shares");
	});

	it("非 owner 的 users 视图宽度 = leftWidth，不是 300", () => {
		const view = effectiveRailView("users", { owner: false, sharesAvailable: true });
		expect(leftPaneWidth(view, 240)).toBe(240);
		expect(leftPaneWidth(view, 400)).toBe(400);
	});

	it("其它面板保持 300px 下限", () => {
		expect(leftPaneWidth("automations", 240)).toBe(300);
		expect(leftPaneWidth("automations", 420)).toBe(420);
	});
});

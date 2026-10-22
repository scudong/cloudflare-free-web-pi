import { describe, expect, it } from "vitest";
import {
	AutomationApiError,
	automationView,
	buildAutomationPatch,
	nextRunAt,
	parseScheduleInput,
} from "../../src/worker/services/automation-service";

/** 2026-10-22 08:00 UTC+8。 */
const NOW = Date.parse("2026-10-22T00:00:00Z");

function statusOf(run: () => unknown): number {
	try {
		run();
	} catch (err) {
		if (err instanceof AutomationApiError) return err.status;
		throw err;
	}
	return 200;
}

describe("nextRunAt（NERE-64 重算基准）", () => {
	it("daily 08:03 取今天未到的那次", () => {
		expect(nextRunAt({ kind: "daily", time: "08:03" }, NOW)).toBe(Date.parse("2026-10-22T00:03:00Z"));
	});

	it("daily 已过点则顺延到明天", () => {
		const at = Date.parse("2026-10-22T00:03:00Z");
		expect(nextRunAt({ kind: "daily", time: "08:03" }, at)).toBe(Date.parse("2026-10-23T00:03:00Z"));
	});

	it("interval 按分钟数从 now 起算", () => {
		expect(nextRunAt({ kind: "interval", minutes: 5 }, NOW)).toBe(NOW + 5 * 60_000);
	});
});

describe("parseScheduleInput（编辑校验）", () => {
	it("daily 只接受 HH:MM（24 小时制）", () => {
		expect(parseScheduleInput({ kind: "daily", time: "08:03" })).toEqual({ kind: "daily", time: "08:03" });
		expect(parseScheduleInput({ kind: "daily", time: "23:59" })).toEqual({ kind: "daily", time: "23:59" });
		for (const time of ["24:00", "08:60", "8:03", "", "08:3", null]) {
			expect(statusOf(() => parseScheduleInput({ kind: "daily", time }))).toBe(400);
		}
	});

	it("interval 只接受 >= 1 的整数分钟", () => {
		expect(parseScheduleInput({ kind: "interval", minutes: 1 })).toEqual({ kind: "interval", minutes: 1 });
		for (const minutes of [0, -5, 1.5, Number.NaN, undefined]) {
			expect(statusOf(() => parseScheduleInput({ kind: "interval", minutes }))).toBe(400);
		}
	});

	it("未知类型与非对象都 400", () => {
		for (const raw of [null, "daily", [], {}, { kind: "weekly" }]) {
			expect(statusOf(() => parseScheduleInput(raw))).toBe(400);
		}
	});
});

describe("buildAutomationPatch（字段组合与 next_run_at）", () => {
	it("只改名称：trim 后写 name，不动 next_run_at", () => {
		expect(buildAutomationPatch({ name: "  日报  " }, NOW)).toEqual({ name: "日报" });
	});

	it("只改提示词 / 会话：保留 next_run_at", () => {
		expect(buildAutomationPatch({ prompt: " 新提示 ", sessionId: "2991" }, NOW)).toEqual({
			prompt: "新提示",
			sessionId: "2991",
		});
	});

	it("改 daily 08:03：重算到下一个 08:03（UTC+8）", () => {
		const patch = buildAutomationPatch({ schedule: { kind: "daily", time: "08:03" } }, NOW);
		expect(patch.schedule).toBe(JSON.stringify({ kind: "daily", time: "08:03" }));
		expect(patch.nextRunAt).toBe(Date.parse("2026-10-22T00:03:00Z"));
	});

	it("改 interval 5：next_run_at = now + 5 分钟", () => {
		const patch = buildAutomationPatch({ schedule: { kind: "interval", minutes: 5 } }, NOW);
		expect(patch.schedule).toBe(JSON.stringify({ kind: "interval", minutes: 5 }));
		expect(patch.nextRunAt).toBe(NOW + 5 * 60_000);
	});

	it("只传 enabled=false：只停用，其他字段与下一次时间都不动", () => {
		expect(buildAutomationPatch({ enabled: false }, NOW)).toEqual({ enabled: false });
	});

	it("只传 enabled=true：沿用旧语义推到 now+60s", () => {
		expect(buildAutomationPatch({ enabled: true }, NOW)).toEqual({ enabled: true, nextRunAt: NOW + 60_000 });
	});

	it("编辑同时带回 enabled=true：以 schedule 为准，不受 60s 影响", () => {
		const patch = buildAutomationPatch(
			{ name: "日报", prompt: "跑", schedule: { kind: "interval", minutes: 5 }, sessionId: "2991", enabled: true },
			NOW,
		);
		expect(patch.enabled).toBe(true);
		expect(patch.nextRunAt).toBe(NOW + 5 * 60_000);
	});

	it("编辑未带 schedule 时即使 enabled=true 也不改 next_run_at", () => {
		const patch = buildAutomationPatch({ name: "日报", enabled: true }, NOW);
		expect(patch).toEqual({ name: "日报", enabled: true });
	});

	it("空名称 / 超长名称 / 空提示词 / 超长提示词 / 非法 enabled 都 400", () => {
		expect(statusOf(() => buildAutomationPatch({ name: "  " }, NOW))).toBe(400);
		expect(statusOf(() => buildAutomationPatch({ name: "x".repeat(41) }, NOW))).toBe(400);
		expect(statusOf(() => buildAutomationPatch({ prompt: "" }, NOW))).toBe(400);
		expect(statusOf(() => buildAutomationPatch({ prompt: "x".repeat(2001) }, NOW))).toBe(400);
		expect(statusOf(() => buildAutomationPatch({ enabled: "false" }, NOW))).toBe(400);
		expect(statusOf(() => buildAutomationPatch({ sessionId: 42 }, NOW))).toBe(400);
	});

	it("边界值可用：40 字名称 / 2000 字提示词", () => {
		const name = "名".repeat(40);
		const prompt = "p".repeat(2000);
		expect(buildAutomationPatch({ name, prompt }, NOW)).toEqual({ name, prompt });
	});
});

describe("automationView", () => {
	it("把仓储行转成接口形态（schedule 解析、enabled 布尔、next_run_at 同名）", () => {
		expect(
			automationView({
				id: "a1",
				name: "日报",
				prompt: "跑",
				session_id: "2991",
				schedule: '{"kind":"daily","time":"08:03"}',
				enabled: 0,
				last_run_at: 123,
				next_run_at: 456,
			}),
		).toEqual({
			id: "a1",
			name: "日报",
			prompt: "跑",
			sessionId: "2991",
			schedule: { kind: "daily", time: "08:03" },
			enabled: false,
			last_run_at: 123,
			next_run_at: 456,
		});
	});

	it("损坏的 schedule 退回 daily 09:00，不抛错", () => {
		const view = automationView({
			id: "a1",
			name: "x",
			prompt: "y",
			session_id: "",
			schedule: "{oops",
			enabled: 1,
			last_run_at: null,
			next_run_at: 0,
		});
		expect(view.schedule).toEqual({ kind: "daily", time: "09:00" });
	});
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutomationPanel } from "../../src/web/components/LeftPanels";
import { parseAutomations } from "../../src/web/lib/collections";
import { formatLastRunAt } from "../../src/web/lib/format";
import type { AutomationInfo } from "../../src/web/types";

/** NERE-68 2a：列表「上次运行」只读 last_run_at，不判断成败（last_status 是 2b）。 */
describe("parseAutomations · 上次运行", () => {
	it("解析 last_run_at / session_id", () => {
		const [job] = parseAutomations({
			automations: [
				{
					id: "a1",
					name: "早报",
					prompt: "总结昨天",
					schedule: '{"kind":"daily","time":"09:00"}',
					enabled: 1,
					last_run_at: 1761111000000,
					session_id: "42",
				},
			],
		});
		expect(job.lastRunAt).toBe(1761111000000);
		expect(job.sessionId).toBe("42");
	});

	it("缺失 / null / 0 / 非法值都解析为 undefined —— 列表据此整行不渲染", () => {
		const jobs = parseAutomations({
			automations: [
				{ id: "a1", name: "缺失", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1 },
				{ id: "a2", name: "null", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: null },
				{ id: "a3", name: "零", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: 0 },
				{ id: "a4", name: "非法", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: "not-a-time" },
			],
		});
		expect(jobs.map((job) => job.lastRunAt)).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("字符串形式的毫秒时间也接受", () => {
		const [job] = parseAutomations({
			automations: [
				{ id: "a1", name: "早报", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: "1761111000000" },
			],
		});
		expect(job.lastRunAt).toBe(1761111000000);
	});

	it("解析 last_status 三值；NULL / 未知 / 缺失一律 undefined（不猜状态）", () => {
		const jobs = parseAutomations({
			automations: [
				{ id: "a1", last_status: "ok" },
				{ id: "a2", last_status: "failed" },
				{ id: "a3", last_status: "deferred" },
				{ id: "a4", last_status: null },
				{ id: "a5", last_status: "weird" },
				{ id: "a6" },
			],
		});
		expect(jobs.map((job) => job.lastStatus)).toEqual(["ok", "failed", "deferred", undefined, undefined, undefined]);
	});
});

describe("formatLastRunAt", () => {
	it("格式化为 MM-DD HH:mm", () => {
		const at = new Date(2026, 9, 22, 9, 0).getTime();
		expect(formatLastRunAt(at)).toBe("10-22 09:00");
	});

	it("缺失 / 0 / 非法值不返回文案", () => {
		expect(formatLastRunAt(undefined)).toBeUndefined();
		expect(formatLastRunAt(0)).toBeUndefined();
		expect(formatLastRunAt(Number.NaN)).toBeUndefined();
	});
});

const LAST_RUN = new Date(2026, 9, 22, 9, 0).getTime();

function job(overrides: Partial<AutomationInfo> & { id: string }): AutomationInfo {
	return { name: "任务", prompt: "提示词", scheduleLabel: "每天 09:00", enabled: true, ...overrides };
}

function render(items: AutomationInfo[], onOpenSession?: (sessionId: string) => void): string {
	return renderToStaticMarkup(
		<AutomationPanel
			items={items}
			loading={false}
			error={null}
			onAdd={async () => true}
			onToggle={async () => true}
			onDelete={async () => true}
			onUpdate={async () => ({ ok: true })}
			onOpenSession={onOpenSession}
		/>,
	);
}

describe("AutomationPanel · 上次运行行", () => {
	it("有 last_run_at + session_id：显示时间与「查看产出」", () => {
		const html = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN, sessionId: "42" })], () => {});
		expect(html).toContain("上次 10-22 09:00");
		expect(html).toContain("查看产出");
		expect(html).toContain('aria-label="查看 早报 上次运行的产出"');
	});

	it("没有 last_run_at：整行不渲染", () => {
		const html = render([job({ id: "a1", name: "早报", sessionId: "42" })], () => {});
		expect(html).not.toContain("上次");
		expect(html).not.toContain("查看产出");
	});

	it("有 last_run_at 但没有 session_id：只显示时间，不渲染跳转", () => {
		const html = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN })], () => {});
		expect(html).toContain("上次 10-22 09:00");
		expect(html).not.toContain("查看产出");
	});

	it("没有跳转回调时不渲染「查看产出」", () => {
		const html = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN, sessionId: "42" })]);
		expect(html).toContain("上次 10-22 09:00");
		expect(html).not.toContain("查看产出");
	});

	it("三种 last_status 的徽标文案与色板各不相同", () => {
		const ok = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN, lastStatus: "ok" })]);
		const failed = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN, lastStatus: "failed" })]);
		const deferred = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN, lastStatus: "deferred" })]);
		expect(ok).toContain("成功");
		expect(ok).toContain("text-emerald-300");
		expect(failed).toContain("失败");
		expect(failed).toContain("text-rose-300");
		expect(deferred).toContain("顺延");
		expect(deferred).toContain("text-amber-300");
		expect(new Set([ok, failed, deferred]).size).toBe(3);
	});

	it("last_status 缺失 / 未知：不渲染徽标", () => {
		const html = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN })]);
		expect(html).not.toContain("成功");
		expect(html).not.toContain("失败");
		expect(html).not.toContain("顺延");
	});

	it("顺延不改 last_run_at：显示上一次时间 + 顺延徽标", () => {
		const html = render([job({ id: "a1", name: "早报", lastRunAt: LAST_RUN, lastStatus: "deferred", sessionId: "42" })], () => {});
		expect(html).toContain("上次 10-22 09:00");
		expect(html).toContain("顺延");
		expect(html).toContain("查看产出");
	});

	it("尚未运行但本轮顺延：没有时间也渲染顺延徽标", () => {
		const html = render([job({ id: "a1", name: "早报", lastStatus: "deferred", sessionId: "42" })], () => {});
		expect(html).toContain("上次运行");
		expect(html).toContain("顺延");
		expect(html).not.toContain("查看产出");
	});
});

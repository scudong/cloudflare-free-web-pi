import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationEditDialog } from "../../src/web/components/AutomationEditDialog";
import { AutomationPanel } from "../../src/web/components/AutomationPanel";
import {
	buildAutomationPatch,
	draftFromJob,
	mergeAutomationUpdate,
	parseAutomationUpdate,
	submitAutomationDraft,
	validateAutomationDraft,
	type AutomationDraft,
} from "../../src/web/lib/automation-edit";
import { automationScheduleLabel, parseAutomationSchedule } from "../../src/web/lib/automation-schedule";
import { parseAutomations } from "../../src/web/lib/collections";
import type { AutomationInfo } from "../../src/web/types";

const noop = () => {};

const JOB: AutomationInfo = {
	id: "a-1",
	name: "每日科技日报",
	prompt: "汇总昨天的科技新闻，按主题分组。",
	scheduleLabel: "每天 08:03",
	enabled: true,
	schedule: { kind: "daily", time: "08:03" },
	sessionId: "2991",
};

const INTERVAL_JOB: AutomationInfo = {
	...JOB,
	id: "a-2",
	name: "巡检",
	prompt: "检查服务状态",
	scheduleLabel: "每隔 5 分钟",
	schedule: { kind: "interval", minutes: 5 },
};

function draft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
	return { ...draftFromJob(JOB), ...overrides };
}

describe("调度解析与文案（NERE-65）", () => {
	it("JSON 字符串 / 对象都接受，时间补零", () => {
		expect(parseAutomationSchedule('{"kind":"daily","time":"8:03"}')).toEqual({ kind: "daily", time: "08:03" });
		expect(parseAutomationSchedule({ kind: "daily", time: "23:59" })).toEqual({ kind: "daily", time: "23:59" });
	});

	it("损坏 / 缺失 / 非法时间退回每天 09:00", () => {
		expect(parseAutomationSchedule("not json")).toEqual({ kind: "daily", time: "09:00" });
		expect(parseAutomationSchedule(null)).toEqual({ kind: "daily", time: "09:00" });
		expect(parseAutomationSchedule({ kind: "daily", time: "24:00" })).toEqual({ kind: "daily", time: "09:00" });
	});

	it("interval 的 minutes 非法时退回 60", () => {
		expect(parseAutomationSchedule({ kind: "interval", minutes: 5 })).toEqual({ kind: "interval", minutes: 5 });
		expect(parseAutomationSchedule({ kind: "interval", minutes: 0 })).toEqual({ kind: "interval", minutes: 60 });
		expect(parseAutomationSchedule('{"kind":"interval"}')).toEqual({ kind: "interval", minutes: 60 });
	});

	it("文案只有一份实现", () => {
		expect(automationScheduleLabel({ kind: "daily", time: "08:03" })).toBe("每天 08:03");
		expect(automationScheduleLabel({ kind: "interval", minutes: 5 })).toBe("每隔 5 分钟");
	});
});

describe("列表解析保留编辑所需字段（NERE-65）", () => {
	it("schedule / session_id 进入领域模型，文案仍由同一函数生成", () => {
		const [job] = parseAutomations({
			automations: [
				{
					id: "a9",
					name: "早报",
					prompt: "总结昨天",
					schedule: '{"kind":"daily","time":"08:03"}',
					session_id: "2991",
					next_run_at: 0,
					enabled: 1,
				},
			],
		});
		expect(job).toMatchObject({
			id: "a9",
			schedule: { kind: "daily", time: "08:03" },
			scheduleLabel: "每天 08:03",
			sessionId: "2991",
			enabled: true,
			nextLabel: undefined,
		});
	});

	it("坏调度不抛错：退回每天 09:00", () => {
		const [job] = parseAutomations({ automations: [{ id: "a1", name: "x", prompt: "y", schedule: "{oops" }] });
		expect(job?.scheduleLabel).toBe("每天 09:00");
	});
});

describe("打开弹窗回填（NERE-65 验收 1）", () => {
	it("daily：名称 / 提示词 / 时间 / 会话全部回填", () => {
		expect(draftFromJob(JOB)).toEqual({
			name: "每日科技日报",
			prompt: "汇总昨天的科技新闻，按主题分组。",
			kind: "daily",
			time: "08:03",
			minutes: "60",
			sessionId: "2991",
		});
	});

	it("interval：kind 与 minutes 回填", () => {
		const value = draftFromJob(INTERVAL_JOB);
		expect(value.kind).toBe("interval");
		expect(value.minutes).toBe("5");
	});

	it("任务没有 sessionId 时用当前会话兜底", () => {
		expect(draftFromJob({ ...JOB, sessionId: undefined }, "session-current").sessionId).toBe("session-current");
	});
});

describe("前端先拦非法输入（NERE-65 验收 4）", () => {
	it("空名称 / 超长名称", () => {
		expect(validateAutomationDraft(draft({ name: "   " }))).toEqual({ ok: false, field: "name", error: "名称不能为空。" });
		const long = validateAutomationDraft(draft({ name: "x".repeat(41) }));
		expect(long.ok).toBe(false);
		if (!long.ok) expect(long.error).toContain("40");
	});

	it("空提示词 / 超长提示词", () => {
		expect(validateAutomationDraft(draft({ prompt: "" }))).toEqual({
			ok: false,
			field: "prompt",
			error: "提示词不能为空。",
		});
		const long = validateAutomationDraft(draft({ prompt: "x".repeat(2001) }));
		expect(long.ok).toBe(false);
		if (!long.ok) expect(long.error).toContain("2000");
	});

	it("非法时间：24:00 / 9:5 / 空", () => {
		for (const time of ["24:00", "9:5", "", "12:60"]) {
			const result = validateAutomationDraft(draft({ time }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("time");
		}
	});

	it("interval 非法分钟：0 / 小数 / 空", () => {
		for (const minutes of ["0", "1.5", "", "-3"]) {
			const result = validateAutomationDraft(draft({ kind: "interval", minutes }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("minutes");
		}
	});

	it("合法输入 trim 后通过，载荷形状与 NERE-64 契约一致", () => {
		const result = validateAutomationDraft(draft({ name: "  新名字  ", prompt: "  新提示  ", sessionId: " 2991 " }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(buildAutomationPatch(JOB, result.value)).toEqual({
			id: "a-1",
			name: "新名字",
			prompt: "新提示",
			schedule: { kind: "daily", time: "08:03" },
			sessionId: "2991",
			enabled: true,
		});
	});

	it("切换为 interval 时载荷只带 minutes", () => {
		const result = validateAutomationDraft(draft({ kind: "interval", minutes: "15" }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.schedule).toEqual({ kind: "interval", minutes: 15 });
	});
});

describe("保存流程（NERE-65 验收 3 / 4）", () => {
	it("非法输入不发请求，错误文案可直接展示", async () => {
		const save = vi.fn(async () => ({ ok: true }));
		const result = await submitAutomationDraft(JOB, draft({ name: "" }), save);
		expect(save).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: false, error: "名称不能为空。", field: "name" });
	});

	it("合法输入只发一次 PATCH，载荷是校验后的值", async () => {
		const save = vi.fn(async () => ({ ok: true }));
		const result = await submitAutomationDraft(JOB, draft({ name: "改名" }), save);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith({
			id: "a-1",
			name: "改名",
			prompt: JOB.prompt,
			schedule: { kind: "daily", time: "08:03" },
			sessionId: "2991",
			enabled: true,
		});
		expect(result.ok).toBe(true);
	});

	it("后端失败：返回错误文案，输入由调用方保留", async () => {
		const result = await submitAutomationDraft(JOB, draft(), async () => ({ ok: false, error: "prompt 超长" }));
		expect(result).toEqual({ ok: false, error: "prompt 超长" });
	});

	it("后端失败但没有文案：给通用兜底", async () => {
		const result = await submitAutomationDraft(JOB, draft(), async () => ({ ok: false }));
		expect(result).toEqual({ ok: false, error: "保存失败，请重试。" });
	});
});

describe("PATCH 返回值落地列表（NERE-65 验收 3）", () => {
	it("宽容解析 snake_case / 字符串 schedule", () => {
		expect(
			parseAutomationUpdate({
				id: "a-1",
				name: "新名字",
				prompt: "新提示",
				schedule: '{"kind":"interval","minutes":15}',
				session_id: "7",
				enabled: 0,
				next_run_at: 1761782400000,
			}),
		).toEqual({
			id: "a-1",
			name: "新名字",
			prompt: "新提示",
			schedule: { kind: "interval", minutes: 15 },
			sessionId: "7",
			enabled: false,
			nextRunAt: 1761782400000,
		});
	});

	it("缺少 id 的返回值不参与合并", () => {
		expect(parseAutomationUpdate({ name: "x" })).toBeNull();
		expect(parseAutomationUpdate(null)).toBeNull();
	});

	it("只更新返回的字段，顺序与其它任务不变", () => {
		const before = [JOB, INTERVAL_JOB];
		const after = mergeAutomationUpdate(before, {
			id: JOB.id,
			name: "每日科技日报（新版）",
			schedule: { kind: "interval", minutes: 30 },
			nextRunAt: 1761782400000,
		});
		expect(after.map((job) => job.id)).toEqual(["a-1", "a-2"]);
		expect(after[0]).toMatchObject({
			name: "每日科技日报（新版）",
			prompt: JOB.prompt,
			enabled: true,
			schedule: { kind: "interval", minutes: 30 },
			scheduleLabel: "每隔 30 分钟",
			sessionId: "2991",
		});
		expect(after[0]?.nextLabel).toBeTruthy();
		expect(after[1]).toBe(INTERVAL_JOB);
	});

	it("id 不在列表里时原样返回，不新增幽灵行", () => {
		const before = [JOB];
		expect(mergeAutomationUpdate(before, { id: "missing", name: "x" })).toBe(before);
	});
});

describe("弹窗 SSR 标记（NERE-65 交付 2）", () => {
	function render(job: AutomationInfo = JOB) {
		return renderToStaticMarkup(
			<AutomationEditDialog job={job} defaultSessionId="2991" onClose={noop} onSave={async () => ({ ok: true })} />,
		);
	}

	it("打开即回填：名称 / 提示词 / 时间 / 会话", () => {
		const html = render();
		expect(html).toContain('role="dialog"');
		expect(html).toContain('data-testid="automation-edit-modal"');
		expect(html).toContain("编辑定时任务");
		expect(html).toContain('value="每日科技日报"');
		expect(html).toContain(JOB.prompt);
		expect(html).toContain('value="08:03"');
		expect(html).toContain('value="2991"');
		expect(html).toContain("取消");
		expect(html).toContain("保存");
	});

	it("daily 选中「每天」，interval 选中「每隔」并回填分钟", () => {
		expect(render()).toMatch(/<option value="daily" selected="">每天<\/option>/);
		const interval = render(INTERVAL_JOB);
		expect(interval).toMatch(/<option value="interval" selected="">每隔<\/option>/);
		expect(interval).toContain('value="5"');
	});

	it("字段上限写在控件上", () => {
		const html = render();
		expect(html).toContain('maxLength="40"');
		expect(html).toContain('maxLength="2000"');
	});
});

describe("列表编辑入口（NERE-65 交付 1）", () => {
	it("每行「编辑」与启停 / 删除并列，带 aria-label", () => {
		const html = renderToStaticMarkup(
			<AutomationPanel
				items={[JOB, INTERVAL_JOB]}
				loading={false}
				error={null}
				onAdd={async () => true}
				onToggle={async () => true}
				onDelete={async () => true}
				onUpdate={async () => ({ ok: true })}
				defaultSessionId="2991"
			/>,
		);
		expect(html).toContain('aria-label="编辑 每日科技日报"');
		expect(html).toContain('aria-label="编辑 巡检"');
		expect(html).toContain('aria-label="暂停 每日科技日报"');
		expect(html).toContain('aria-label="删除 巡检"');
		// 弹窗按任务挂载：默认不打开，列表页不出现 dialog。
		expect(html).not.toContain('role="dialog"');
	});
});

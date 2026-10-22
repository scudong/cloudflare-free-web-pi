import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillCard } from "../../src/web/components/SkillCard";
import { parseSkills } from "../../src/web/lib/collections";
import {
	NEVER_TRIED_DAYS,
	lastUsedLabel,
	shouldSuggestRemoval,
	skillRuntimeLabel,
} from "../../src/web/lib/skill-usage";
import type { SkillInfo } from "../../src/web/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-22T12:00:00Z");

/** 服务端 GET /skills 的一条：字段只增不改（NERE-55 listCompat）。 */
const ROW = {
	name: "weekly-report",
	description: "把一周的流水整理成周报",
	content: "# 周报\n\n按项目分组。",
	created_at: "2026-10-20T09:00:00Z",
	runtime: "prompt",
	auditStatus: "pass",
	lastInvokedAt: null,
};

function card(skill: SkillInfo, now = NOW) {
	return renderToStaticMarkup(
		<SkillCard
			skill={skill}
			expanded={false}
			onToggle={() => {}}
			onDelete={() => {}}
			onTry={() => {}}
			now={now}
		/>,
	);
}

describe("lastUsedLabel · 上次使用口径（NERE-59）", () => {
	it("字段缺失 → null：没有埋点数据，整行不渲染（不显示 0 / 不显示「从未」）", () => {
		expect(lastUsedLabel(undefined, NOW)).toBeNull();
	});

	it("null → 从未使用", () => {
		expect(lastUsedLabel(null, NOW)).toBe("从未");
	});

	it("相对时间：刚刚 / 分钟 / 小时 / 天", () => {
		expect(lastUsedLabel(NOW - 30_000, NOW)).toBe("刚刚");
		expect(lastUsedLabel(NOW - 5 * MINUTE, NOW)).toBe("5 分钟前");
		expect(lastUsedLabel(NOW - 3 * HOUR, NOW)).toBe("3 小时前");
		expect(lastUsedLabel(NOW - 3 * DAY, NOW)).toBe("3 天前");
	});

	it("脏数据（NaN / 负数极端）不抛错：NaN 不渲染", () => {
		expect(lastUsedLabel(Number.NaN, NOW)).toBeNull();
		// 服务端时钟略快于浏览器时按「刚刚」处理，不出现「-1 天前」
		expect(lastUsedLabel(NOW + DAY, NOW)).toBe("刚刚");
	});
});

describe("shouldSuggestRemoval · 装了 7 天还没用过", () => {
	const based: Pick<SkillInfo, "lastInvokedAt" | "createdAt"> = {
		lastInvokedAt: null,
		createdAt: new Date(NOW - (NEVER_TRIED_DAYS + 1) * DAY).toISOString(),
	};

	it("从未使用且满 7 天 → 提示删掉", () => {
		expect(shouldSuggestRemoval(based, NOW)).toBe(true);
	});

	it("刚好 7 天前安装 → 提示；6 天前 → 不提示", () => {
		expect(shouldSuggestRemoval({ ...based, createdAt: new Date(NOW - NEVER_TRIED_DAYS * DAY).toISOString() }, NOW)).toBe(true);
		expect(shouldSuggestRemoval({ ...based, createdAt: new Date(NOW - 6 * DAY).toISOString() }, NOW)).toBe(false);
	});

	it("用过（哪怕是 null 之外的 0）或没有安装时间 → 不提示", () => {
		expect(shouldSuggestRemoval({ ...based, lastInvokedAt: NOW - HOUR }, NOW)).toBe(false);
		expect(shouldSuggestRemoval({ ...based, createdAt: undefined }, NOW)).toBe(false);
	});
});

describe("skillRuntimeLabel · 运行时徽标", () => {
	it("只显示 issue 要求的三类短标签", () => {
		expect(skillRuntimeLabel("prompt")).toBe("提示词");
		expect(skillRuntimeLabel("javascript")).toBe("JS");
		expect(skillRuntimeLabel("typescript")).toBe("TS");
		expect(skillRuntimeLabel(undefined)).toBeNull();
		expect(skillRuntimeLabel("")).toBeNull();
	});
});

describe("parseSkills · 宽容解析（NERE-59）", () => {
	it("空数组 / 缺字段 → 不崩、空态", () => {
		expect(parseSkills({ skills: [] })).toEqual([]);
		expect(parseSkills(undefined)).toEqual([]);
		expect(parseSkills({ skills: "nope" })).toEqual([]);
	});

	it("带上 runtime / auditStatus / createdAt / lastInvokedAt", () => {
		const [skill] = parseSkills({ skills: [ROW] });
		expect(skill).toMatchObject({
			name: "weekly-report",
			runtime: "prompt",
			auditStatus: "pass",
			createdAt: "2026-10-20T09:00:00Z",
			lastInvokedAt: null,
		});
	});

	it("老服务端没有 lastInvokedAt → undefined（无埋点数据）", () => {
		const { lastInvokedAt: _drop, ...legacy } = ROW;
		const [skill] = parseSkills({ skills: [legacy] });
		expect(skill!.lastInvokedAt).toBeUndefined();
	});

	it("无法识别的 auditStatus 不猜成 pass", () => {
		const [skill] = parseSkills({ skills: [{ ...ROW, auditStatus: "bogus" }] });
		expect(skill!.auditStatus).toBeUndefined();
	});

	it("lastInvokedAt 是数字字符串时转成数字（宽容读取）", () => {
		const [skill] = parseSkills({ skills: [{ ...ROW, lastInvokedAt: String(NOW) }] });
		expect(skill!.lastInvokedAt).toBe(NOW);
	});
});

describe("SkillCard · 已安装卡片（验收 1 / 3 / 4）", () => {
	const parsed = (overrides: Record<string, unknown> = {}) =>
		parseSkills({ skills: [{ ...ROW, ...overrides }] })[0]!;

	it("有埋点字段、从未调用 → 运行时 + 审计 + 「上次使用：从未」+ 试用按钮", () => {
		const html = card(parsed());
		expect(html).toContain("上次使用：从未");
		expect(html).toContain("提示词");
		expect(html).toContain("审计通过");
		expect(html).toContain("试用");
		expect(html).toContain(`aria-label="试用 weekly-report"`);
	});

	it("刚被调用过一次 → 「刚刚」", () => {
		const html = card(parsed({ lastInvokedAt: NOW - 1_000 }));
		expect(html).toContain("上次使用：刚刚");
		expect(html).not.toContain("上次使用：从未");
	});

	it("skill_events 为空（全部 lastInvokedAt=null）→ 正常渲染，无占位错误", () => {
		const list = parseSkills({ skills: [ROW, { ...ROW, name: "meeting-notes" }] });
		for (const skill of list) {
			const html = card(skill);
			expect(html).toContain("上次使用：从未");
			expect(html).not.toContain("NaN");
			expect(html).not.toContain("undefined");
		}
	});

	it("没有埋点字段（老服务端）→ 整行不渲染，不显示 0 / 从未", () => {
		const { lastInvokedAt: _drop, ...legacy } = ROW;
		const html = card(parseSkills({ skills: [legacy] })[0]!);
		expect(html).not.toContain("上次使用");
		expect(html).not.toContain("从未");
		// 卡片主体仍然可用
		expect(html).toContain("weekly-report");
		expect(html).toContain("试用");
	});

	it("从未使用且装了 8 天 → 底部灰字提示；刚装的不提示", () => {
		const old = card(parsed({ created_at: new Date(NOW - 8 * DAY).toISOString() }));
		expect(old).toContain("还没用过。试试「试用」，或删掉它保持面板清爽。");

		const fresh = card(parsed({ created_at: new Date(NOW - DAY).toISOString() }));
		expect(fresh).not.toContain("还没用过。试试");
	});
});

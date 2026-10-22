import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "../../src/web/components/Rail";
import {
	automationWatermark,
	countUnreadAutomations,
	countUnreadShares,
	nextWatermark,
	readWatermark,
	readWatermarks,
	shareWatermark,
	unreadKey,
	unreadScope,
	writeWatermark,
	type UnreadStorage,
} from "../../src/web/lib/unread";
import type { AutomationInfo, ShareRecord } from "../../src/web/types";

/** 假存储：替代真实 localStorage，测试里可以放心注入时间戳。 */
function memoryStorage(seed: Record<string, string> = {}): UnreadStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

const MINUTE = 60_000;
const T0 = 1_761_196_800_000; // 2025-10-23T00:00:00Z，按毫秒时间戳用

function share(token: string, lastOpenedAt: number, openCount = 1): ShareRecord {
	return {
		token,
		kind: "file",
		name: `${token}.md`,
		expiresAt: 0,
		createdAt: new Date(T0).toISOString(),
		openCount,
		lastOpenedAt,
		sessionId: "c-1",
		url: `/s/${token}`,
	};
}

function job(id: string, lastRunAt?: number): AutomationInfo {
	return { id, name: id, prompt: "p", scheduleLabel: "每天 09:00", enabled: true, lastRunAt };
}

describe("未读水位：键与用户作用域（NERE-74）", () => {
	it("按作用域 + 类型分键，前缀固定", () => {
		expect(unreadKey("shares", "owner")).toBe("pi-unread:owner:shares");
		expect(unreadKey("automations", "member")).toBe("pi-unread:member:automations");
		expect(unreadKey("shares", "owner")).not.toBe(unreadKey("shares", "member"));
		expect(unreadKey("shares", "")).toBe("pi-unread:local:shares");
	});

	it("主人 / 邀请用户落到不同作用域", () => {
		expect(unreadScope(true)).toBe("owner");
		expect(unreadScope(false)).toBe("member");
		expect(unreadScope(undefined)).toBe("member");
	});
});

describe("未读水位：读写容错", () => {
	it("写入后读回数字；缺失 / 空串 / 非法值一律 null", () => {
		const storage = memoryStorage();
		const key = unreadKey("shares", "owner");
		expect(readWatermark(storage, key)).toBeNull();
		writeWatermark(storage, key, T0 + MINUTE);
		expect(readWatermark(storage, key)).toBe(T0 + MINUTE);
		storage.setItem(key, "not-a-number");
		expect(readWatermark(storage, key)).toBeNull();
		storage.setItem(key, "");
		expect(readWatermark(storage, key)).toBeNull();
	});

	it("存储不可用（私密模式 / 抛异常）时读写都不崩", () => {
		const broken: UnreadStorage = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(readWatermark(broken, "k")).toBeNull();
		expect(() => writeWatermark(broken, "k", T0)).not.toThrow();
		expect(readWatermark(null, "k")).toBeNull();
		expect(() => writeWatermark(null, "k", T0)).not.toThrow();
	});

	it("一次读出两路水位", () => {
		const storage = memoryStorage({
			[unreadKey("shares", "owner")]: String(T0),
			[unreadKey("automations", "owner")]: String(T0 + MINUTE),
		});
		expect(readWatermarks(storage, "owner")).toEqual({ shares: T0, automations: T0 + MINUTE });
		expect(readWatermarks(storage, "member")).toEqual({ shares: null, automations: null });
	});
});

describe("分享未读：lastOpenedAt 严格大于水位", () => {
	it("水位取所有记录里最大的 lastOpenedAt（0 = 从未打开）", () => {
		expect(shareWatermark([share("a", 0, 0), share("b", T0), share("c", T0 - MINUTE)])).toBe(T0);
		expect(shareWatermark([])).toBe(0);
	});

	it("新打开的分享计数；等于水位的不算（点开面板后刷新不再出现）", () => {
		const items = [share("a", T0), share("b", T0 - MINUTE), share("c", 0, 0)];
		expect(countUnreadShares(items, T0 - MINUTE * 2)).toBe(2);
		expect(countUnreadShares(items, T0)).toBe(0);
	});

	it("水位未知（首次使用）不补报历史", () => {
		expect(countUnreadShares([share("a", T0)], null)).toBe(0);
	});

	it("验收集：首次种子化 → 无痕打开一条 → 圆点出现 → 打开面板写水位 → 刷新后不再出现", () => {
		const storage = memoryStorage();
		const key = unreadKey("shares", "owner");
		const before = [share("a", T0), share("b", T0 - MINUTE * 5)];

		// 第一次加载：没有水位 → 用当前最大值做种子，不显示圆点。
		const seeded = nextWatermark(readWatermark(storage, key), shareWatermark(before));
		expect(seeded).toBe(T0);
		writeWatermark(storage, key, seeded!);
		let items = before;
		expect(countUnreadShares(items, readWatermark(storage, key))).toBe(0);

		// 无痕窗口打开了自己的分享 → 服务端把 lastOpenedAt 推到 T0 + 1 分钟。
		items = [share("a", T0 + MINUTE, 2), share("b", T0 - MINUTE * 5)];
		let watermark = readWatermark(storage, key);
		expect(countUnreadShares(items, watermark)).toBe(1);

		// 打开面板：水位前移到最新值并落盘（模拟刷新后重新读 localStorage）。
		const advanced = nextWatermark(watermark, shareWatermark(items));
		expect(advanced).toBe(T0 + MINUTE);
		writeWatermark(storage, key, advanced!);

		const afterReload = readWatermark(storage, key);
		expect(countUnreadShares(items, afterReload)).toBe(0);
	});

	it("没有分享 / 从未被打开：永远不亮假红点", () => {
		const storage = memoryStorage();
		expect(countUnreadShares([], readWatermark(storage, unreadKey("shares", "owner")))).toBe(0);
		expect(countUnreadShares([share("a", 0, 0)], 0)).toBe(0);
	});
});

describe("定时未读：lastRunAt 严格大于水位", () => {
	it("水位取最大的 lastRunAt，缺失的不参与", () => {
		expect(automationWatermark([job("a"), job("b", T0), job("c", T0 - MINUTE)])).toBe(T0);
		expect(automationWatermark([job("a")])).toBe(0);
	});

	it("跑过的任务计数；等于水位的不算", () => {
		const items = [job("a", T0), job("b", T0 - MINUTE), job("c")];
		expect(countUnreadAutomations(items, T0 - MINUTE * 2)).toBe(2);
		expect(countUnreadAutomations(items, T0)).toBe(0);
		expect(countUnreadAutomations(items, null)).toBe(0);
	});

	it("同一点位覆盖成功与失败：只看时间推进", () => {
		const items = [{ ...job("a", T0 + MINUTE), lastStatus: "failed" as const }];
		expect(countUnreadAutomations(items, T0)).toBe(1);
	});
});

describe("水位推进", () => {
	it("没有水位 → 用当前最大值做种子（可以是 0）", () => {
		expect(nextWatermark(null, T0)).toBe(T0);
		expect(nextWatermark(null, 0)).toBe(0);
	});

	it("只增不减：没有新数据不写", () => {
		expect(nextWatermark(T0, T0)).toBeNull();
		expect(nextWatermark(T0, T0 - MINUTE)).toBeNull();
		expect(nextWatermark(T0, T0 + MINUTE)).toBe(T0 + MINUTE);
	});
});

describe("Rail 未读圆点（NERE-74）", () => {
	const railHtml = (props: { sharesUnread?: number; automationsUnread?: number; sharesAvailable?: boolean } = {}) =>
		renderToStaticMarkup(
			<Rail
				view="sessions"
				panel={null}
				onSelectView={() => {}}
				onTogglePanel={() => {}}
				onNewSession={() => {}}
				onOpenSettings={() => {}}
				sharesAvailable={props.sharesAvailable ?? true}
				sharesUnread={props.sharesUnread}
				automationsUnread={props.automationsUnread}
			/>,
		);

	it("没有未读时不渲染任何圆点，aria-label 保持原样", () => {
		const html = railHtml();
		expect(html).not.toContain("data-unread-dot");
		expect(html).toContain('aria-label="分享"');
		expect(html).toContain('aria-label="定时"');
	});

	it("有未读时渲染圆点，aria-label / title 带上条数", () => {
		const html = railHtml({ sharesUnread: 1, automationsUnread: 2 });
		expect(html).toContain('data-unread-dot="shares"');
		expect(html).toContain('data-unread-dot="automations"');
		expect(html).toContain('aria-label="分享，1 条未读"');
		expect(html).toContain('aria-label="定时，2 条未读"');
		expect(html).toContain('title="分享（1 条未读）"');
	});

	it("圆点不参与 tab 顺序：没有 tabindex，且对无障碍树隐藏", () => {
		const html = railHtml({ sharesUnread: 3, automationsUnread: 1 });
		const dot = html.slice(html.indexOf('data-unread-dot="shares"') - 200, html.indexOf('data-unread-dot="shares"') + 50);
		expect(dot).toContain('aria-hidden="true"');
		expect(html).not.toMatch(/tabindex/i);
		// 按钮顺序保持不变：分享仍在连接之前、定时在连接之后。
		expect(html.indexOf('aria-label="知识库"')).toBeLessThan(html.indexOf('aria-label="分享，3 条未读"'));
		expect(html.indexOf('aria-label="分享，3 条未读"')).toBeLessThan(html.indexOf('aria-label="连接"'));
		expect(html.indexOf('aria-label="连接"')).toBeLessThan(html.indexOf('aria-label="定时，1 条未读"'));
	});

	it("分享接口未上线时不渲染入口，也不会漏出圆点", () => {
		const html = railHtml({ sharesUnread: 5, sharesAvailable: false });
		expect(html).not.toContain("data-unread-dot=\"shares\"");
		expect(html).not.toContain("分享");
	});
});

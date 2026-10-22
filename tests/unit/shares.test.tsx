import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareRow } from "../../src/web/components/ShareRow";
import { SharesPanel } from "../../src/web/components/SharesPanel";
import { Rail } from "../../src/web/components/Rail";
import { insertAt, isAlreadyRevoked, probeSharesAvailability, revokeErrorMessage } from "../../src/web/hooks/useShares";
import { ApiError, api } from "../../src/web/lib/api";
import { parseShareRecords } from "../../src/web/lib/collections";
import { formatExpiry, formatOpenedAt } from "../../src/web/lib/format";
import type { ShareRecord } from "../../src/web/types";

/** 与契约 §2.1 一致的三条示例（2 文件 + 1 会话）。 */
const RECORDS = [
	{
		token: "f7kqm3x9ab2c",
		kind: "file",
		name: "周报-2026-W42.md",
		expiresAt: 1761782400000,
		theme: "dark",
		createdAt: "2026-10-22T03:11:09.402Z",
		openCount: 3,
		lastOpenedAt: 1761196800000,
		sessionId: "c-9f3a1e",
		url: "/s/f7kqm3x9ab2c",
	},
	{
		token: "s2mz8qp1de4f",
		kind: "conversation",
		name: "久期是什么",
		expiresAt: 0,
		theme: "dark",
		createdAt: "2026-10-21T22:04:51.118Z",
		openCount: 0,
		lastOpenedAt: 0,
		sessionId: "c-9f3a1e",
		url: "/s/s2mz8qp1de4f",
	},
	{
		token: "a1b2c3d4e5f6",
		kind: "file",
		name: "笔记.md",
		expiresAt: 0,
		theme: "light",
		createdAt: "2026-10-20T01:00:00.000Z",
		openCount: 1,
		lastOpenedAt: 1761100000000,
		sessionId: "c-other",
		url: "/s/a1b2c3d4e5f6",
	},
];

const FIRST: ShareRecord = parseShareRecords({ shares: [RECORDS[0]] })[0]!;
const SECOND: ShareRecord = parseShareRecords({ shares: [RECORDS[1]] })[0]!;

describe("parseShareRecords", () => {
	it("保序映射三条记录（验收 1）", () => {
		const records = parseShareRecords({ shares: RECORDS });
		expect(records.map((item) => item.token)).toEqual(["f7kqm3x9ab2c", "s2mz8qp1de4f", "a1b2c3d4e5f6"]);
		expect(records[0]).toMatchObject({
			kind: "file",
			name: "周报-2026-W42.md",
			expiresAt: 1761782400000,
			openCount: 3,
			lastOpenedAt: 1761196800000,
			sessionId: "c-9f3a1e",
			url: "/s/f7kqm3x9ab2c",
		});
	});

	it("非数组 / 缺 shares 包装 → 空数组", () => {
		expect(parseShareRecords(null)).toEqual([]);
		expect(parseShareRecords("oops")).toEqual([]);
		expect(parseShareRecords({})).toEqual([]);
	});

	it("丢弃 token 缺失或 kind 非法的项", () => {
		const records = parseShareRecords({
			shares: [
				{ kind: "file", name: "无 token" },
				{ token: "t1", kind: "unknown" },
				{ token: "t2", kind: "file" },
			],
		});
		expect(records.map((item) => item.token)).toEqual(["t2"]);
	});

	it("name / 数字字段 / url 缺失时给默认值", () => {
		const [record] = parseShareRecords({ shares: [{ token: "t3", kind: "conversation" }] });
		expect(record).toEqual({
			token: "t3",
			kind: "conversation",
			name: "（未命名）",
			expiresAt: 0,
			createdAt: "",
			openCount: 0,
			lastOpenedAt: 0,
			sessionId: "",
			url: "/s/t3",
		});
	});
});

describe("formatExpiry", () => {
	const NOW = 1_760_000_000_000;

	it("0 → 永久，过去 → 已过期", () => {
		expect(formatExpiry(0, NOW)).toBe("永久");
		expect(formatExpiry(NOW - 1, NOW)).toBe("已过期");
	});

	it("24 小时内按小时取整", () => {
		expect(formatExpiry(NOW + 2 * 3_600_000, NOW)).toBe("剩余 2 小时");
		expect(formatExpiry(NOW + 30 * 60_000, NOW)).toBe("剩余 1 小时");
	});

	it("超过 24 小时按天取整", () => {
		expect(formatExpiry(NOW + 47 * 3_600_000, NOW)).toBe("剩余 2 天");
		expect(formatExpiry(NOW + 49 * 3_600_000, NOW)).toBe("剩余 3 天");
	});
});

describe("formatOpenedAt", () => {
	it("0 → 从未打开", () => {
		expect(formatOpenedAt(0)).toBe("从未打开");
	});

	it("epoch 毫秒复用 formatTime 的展示格式", () => {
		expect(formatOpenedAt(1_761_196_800_000)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
	});
});

describe("撤销错误文案", () => {
	it("403 给权限提示", () => {
		expect(revokeErrorMessage(new ApiError(403, "forbidden"))).toBe("没有权限撤销这条链接（可能不属于当前账号）");
	});

	it("404 视为已经撤销", () => {
		expect(isAlreadyRevoked(new ApiError(404, "gone"))).toBe(true);
		expect(isAlreadyRevoked(new ApiError(403, "forbidden"))).toBe(false);
	});

	it("网络 / 5xx 带上传输层原因", () => {
		expect(revokeErrorMessage(new ApiError(0, "网络请求失败，请检查服务是否在运行。"))).toBe(
			"撤销失败：网络请求失败，请检查服务是否在运行。",
		);
		expect(revokeErrorMessage(new ApiError(500, "服务器错误"))).toBe("撤销失败：服务器错误");
		expect(revokeErrorMessage(new Error("boom"))).toBe("撤销失败：boom");
	});
});

describe("insertAt（撤销失败按原索引回滚）", () => {
	it("插回原位置，保持原顺序", () => {
		expect(insertAt(["a", "c"], 1, "b")).toEqual(["a", "b", "c"]);
	});

	it("索引越界时落在末尾", () => {
		expect(insertAt(["a"], 9, "b")).toEqual(["a", "b"]);
	});
});

describe("api.sharesAll / api.revokeShare", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("默认只取 active，路径不搬进组件", async () => {
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ shares: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);

		await api.sharesAll();
		await api.sharesAll("all");
		expect(calls).toEqual(["/api/shares/all?status=active", "/api/shares/all?status=all"]);
	});

	it("撤销走 DELETE 并编码 token", async () => {
		const calls: { url: string; method?: string }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method });
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);

		await api.revokeShare("a/b c");
		expect(calls).toEqual([{ url: "/api/shares/a%2Fb%20c", method: "DELETE" }]);
	});
});

describe("ShareRow", () => {
	it("展示类型 / 名称 / 打开次数 / 最近打开，并带可访问标签", () => {
		const html = renderToStaticMarkup(
			<ShareRow record={SECOND} revoking={false} onRevoke={() => {}} />,
		);
		expect(html).toContain("会话");
		expect(html).toContain("久期是什么");
		expect(html).toContain("永久");
		expect(html).toContain("打开 0 次");
		expect(html).toContain("从未打开");
		expect(html).toContain("复制分享链接 久期是什么");
		expect(html).toContain("撤销分享 久期是什么");
		expect(html).not.toContain("aria-busy");
		expect(html).not.toContain('disabled=""');
	});

	it("撤销中按钮禁用并标记 aria-busy", () => {
		const html = renderToStaticMarkup(<ShareRow record={FIRST} revoking onRevoke={() => {}} />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("disabled");
		expect(html).toContain("撤销中…");
	});
});

describe("SharesPanel 三态", () => {
	it("首次渲染是 loading：3 行骨架 + aria-busy，不显示空态", () => {
		const html = renderToStaticMarkup(<SharesPanel />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("刷新分享清单");
		expect((html.match(/animate-pulse/g) ?? []).length).toBe(3);
		expect(html).not.toContain("还没有分享链接");
	});
});

describe("分享入口能力门禁（NERE-56）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const railHtml = (sharesAvailable: boolean) =>
		renderToStaticMarkup(
			<Rail
				view="sessions"
				onViewChange={() => {}}
				onNewSession={() => {}}
				onOpenSettings={() => {}}
				sharesAvailable={sharesAvailable}
			/>,
		);

	it("探测失败（404 / 非 JSON / 网络错误）→ 入口不渲染", async () => {
		const failures: (() => Response | Promise<Response>)[] = [
			async () => new Response("not found", { status: 404 }),
			async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
			async () => Promise.reject(new TypeError("Failed to fetch")),
		];
		for (const failure of failures) {
			vi.spyOn(globalThis, "fetch").mockImplementation(failure as typeof fetch);
			const available = await probeSharesAvailability();
			expect(available).toBe(false);
			const html = railHtml(available);
			expect(html).not.toContain("分享");
			expect(html).not.toContain("清单加载失败");
			vi.restoreAllMocks();
		}
	});

	it("探测成功（含空清单）→ 入口渲染", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ shares: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const available = await probeSharesAvailability();
		expect(available).toBe(true);
		expect(railHtml(available)).toContain("分享");
	});
});

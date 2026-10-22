import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KbRefsBar, groupByDoc } from "../../src/web/components/KbRefsBar";
import { parseEntries, parseKbRefs } from "../../src/web/lib/entries";
import { PANEL_IDLE, reducePanel } from "../../src/web/lib/panels";
import type { KbRef } from "../../src/web/types";

const REFS: KbRef[] = [
	{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含义", source: "A.md" },
	{ docId: 7, chunkId: 131, chunkSeq: 5, title: "久期的含义", source: "A.md" },
	{ docId: 9, chunkId: 12, chunkSeq: 0, title: "装修预算清单" },
];

describe("parseKbRefs · 宽容解析（NERE-41）", () => {
	it("缺省 / 非数组 → []（老会话不报错）", () => {
		expect(parseKbRefs(undefined)).toEqual([]);
		expect(parseKbRefs(null)).toEqual([]);
		expect(parseKbRefs([])).toEqual([]);
		expect(parseKbRefs("kbRefs")).toEqual([]);
		expect(parseKbRefs({ docId: 7 })).toEqual([]);
	});

	it("丢弃 docId 非法的项，按 docId:chunkId 去重并保持原序", () => {
		const parsed = parseKbRefs([
			{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含义", source: "A.md" },
			{ docId: "7", chunkId: 129, chunkSeq: 4, title: "错类型" },
			null,
			{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含义" },
			42,
		]);
		expect(parsed).toEqual([{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含义", source: "A.md" }]);
	});

	it("parseEntries 把顶层 kbRefs 挂到 assistant 消息；缺省时不落字段", () => {
		const [hit] = parseEntries([
			{ id: 2, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "久期衡量…" }] }], kbRefs: [REFS[0]] },
		]);
		expect(hit).toMatchObject({ role: "assistant", kbRefs: [REFS[0]] });

		const [plain] = parseEntries([
			{ id: 1, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "今天晴。" }] }] },
		]);
		expect(plain).not.toHaveProperty("kbRefs");
	});
});

describe("groupByDoc · 按文档聚合（NERE-41）", () => {
	it("同一 docId 的多个 chunk 只留一项，保持首次出现顺序", () => {
		const groups = groupByDoc(REFS);
		expect(groups.map((group) => [group.docId, group.title, group.count])).toEqual([
			[7, "久期的含义", 2],
			[9, "装修预算清单", 1],
		]);
		// 代表项是该文档的首个命中片段
		expect(groups[0]!.ref.chunkSeq).toBe(2);
	});
});

describe("KbRefsBar · 参考资料条（NERE-41）", () => {
	it("缺省或空数组时不渲染任何 UI", () => {
		expect(renderToStaticMarkup(<KbRefsBar refs={[]} />)).toBe("");
		expect(renderToStaticMarkup(<KbRefsBar refs={[]} onOpen={() => {}} />)).toBe("");
	});

	it("默认收起为一行「参考资料：N 篇」，N 为去重后的文档数", () => {
		const html = renderToStaticMarkup(<KbRefsBar refs={REFS} onOpen={() => {}} />);
		expect(html).toContain("参考资料：2 篇");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("aria-controls=");
		// 收起态不渲染列表，也不伪造链接
		expect(html).not.toContain("<ul");
		expect(html).not.toContain("<a ");
	});
});

describe("知识库定位生命周期 · 重开弹窗不重放（NERE-75 P1-1）", () => {
	const focus = { docId: 7, chunkSeq: 2, nonce: 1 };

	it("点参考资料 A → Esc → 点 Rail「知识库」：停在列表", () => {
		const opened = reducePanel(PANEL_IDLE, { type: "kb-ref", focus });
		expect(opened).toEqual({ active: "kb", kbFocus: focus });

		const closed = reducePanel(opened, { type: "close" });
		expect(closed).toEqual(PANEL_IDLE);

		const reopened = reducePanel(closed, { type: "toggle", panel: "kb" });
		expect(reopened.active).toBe("kb");
		expect(reopened.kbFocus).toBeNull();
	});

	it("消费后立即清空：即使没有经过 close，重开也不会用旧 nonce 再打开一次", () => {
		const opened = reducePanel(PANEL_IDLE, { type: "kb-ref", focus });
		const consumed = reducePanel(opened, { type: "kb-focus-consumed" });
		expect(consumed).toEqual({ active: "kb", kbFocus: null });

		expect(reducePanel(consumed, { type: "toggle", panel: "kb" })).toEqual(PANEL_IDLE);
		expect(reducePanel(consumed, { type: "close" })).toEqual(PANEL_IDLE);
	});

	it("切到别的弹窗 / 打开设置同样丢弃未消费的定位", () => {
		const opened = reducePanel(PANEL_IDLE, { type: "kb-ref", focus });
		expect(reducePanel(opened, { type: "toggle", panel: "mcp" })).toEqual({ active: "mcp", kbFocus: null });
		expect(reducePanel(opened, { type: "settings" })).toEqual(PANEL_IDLE);
	});
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KbRefsBar, groupByDoc } from "../../src/web/components/KbRefsBar";
import { parseEntries, parseKbRefs } from "../../src/web/lib/entries";
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

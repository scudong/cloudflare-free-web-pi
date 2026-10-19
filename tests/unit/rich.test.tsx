import { describe, expect, it } from "vitest";
import { renderMarkdown, renderRichText } from "../../src/web/lib/rich";
import { findAll, tags, textOf } from "../helpers/reactText";

describe("renderMarkdown · 标题", () => {
	it("各级标题输出语义标签", () => {
		const out = renderMarkdown("# 一级\n\n## 二级\n\n### 三级\n\n#### 四级");
		expect(tags(out, "h1").length).toBe(1);
		expect(tags(out, "h2").length).toBe(1);
		expect(tags(out, "h3").length).toBe(1);
		expect(tags(out, "h4").length).toBe(1);
		expect(textOf(tags(out, "h2")[0])).toBe("二级");
	});
});

describe("renderMarkdown · 表格", () => {
	const md = ["| 名称 | 数量 |", "| --- | ---: |", "| 甲 | 1 |", "| 乙 | 2 |"].join("\n");

	it("分隔行不会被当成数据行", () => {
		const out = renderMarkdown(md);
		const text = textOf(out);
		expect(text).not.toContain("---");
		expect(text).toContain("甲");
		expect(text).toContain("乙");
	});

	it("表头与数据行数量正确", () => {
		const out = renderMarkdown(md);
		expect(tags(out, "th").length).toBe(2);
		expect(tags(out, "td").length).toBe(4);
	});

	it("右对齐标记映射为 text-align", () => {
		const out = renderMarkdown(md);
		const tds = tags(out, "td");
		expect(tds[1]?.props.style).toMatchObject({ textAlign: "right" });
	});
});

describe("renderMarkdown · 列表", () => {
	it("任务列表渲染成勾选框", () => {
		const out = renderMarkdown("- [ ] 待办\n- [x] 已完成");
		const text = textOf(out);
		expect(text).toContain("☐");
		expect(text).toContain("☑");
		expect(text).toContain("待办");
	});

	it("嵌套列表挂到父项下", () => {
		const out = renderMarkdown("- 外层\n  - 内层");
		expect(tags(out, "ul").length).toBe(2);
	});

	it("有序列表使用 ol", () => {
		const out = renderMarkdown("1. 第一\n2. 第二");
		expect(tags(out, "ol").length).toBe(1);
		expect(tags(out, "li").length).toBe(2);
	});
});

describe("renderMarkdown · 代码块", () => {
	// CodeBlock 是函数组件，未渲染时读不到内部文本，断言它收到的 props
	const codeBlocks = (out: unknown[]) =>
		findAll(out, (el) => typeof el.type === "function" && typeof el.props.code === "string");

	it("携带语言与代码内容", () => {
		const out = renderMarkdown("```js\nconst a = 1;\n```");
		const blocks = codeBlocks(out);
		expect(blocks.length).toBe(1);
		expect(blocks[0]!.props.lang).toBe("js");
		expect(blocks[0]!.props.code).toBe("const a = 1;");
	});

	it("无语言时 lang 为空串（组件内回落为 text）", () => {
		const out = renderMarkdown("```\nplain\n```");
		const blocks = codeBlocks(out);
		expect(blocks.length).toBe(1);
		expect(blocks[0]!.props.lang).toBe("");
		expect(blocks[0]!.props.code).toBe("plain");
	});
});

describe("renderMarkdown · 安全", () => {
	it("HTML 标签按纯文本输出，不产生元素", () => {
		const out = renderMarkdown('<script>alert(1)</script>');
		expect(textOf(out)).toContain("<script>");
		expect(tags(out, "script").length).toBe(0);
	});

	it("危险协议的链接不生成 a 标签", () => {
		const out = renderRichText("[点我](javascript:alert(1))");
		expect(tags(out, "a").length).toBe(0);
		expect(textOf(out)).toContain("点我");
	});

	it("https 链接生成 a 标签", () => {
		const out = renderRichText("[官网](https://example.com)");
		const a = tags(out, "a")[0];
		expect(a?.props.href).toBe("https://example.com");
		expect(a?.props.rel).toContain("noopener");
	});
});

describe("renderRichText · 行内", () => {
	it("粗体 / 斜体 / 删除线 / 行内代码", () => {
		const out = renderRichText("**粗** *斜* ~~删~~ `码`");
		expect(tags(out, "strong").length).toBe(1);
		expect(tags(out, "em").length).toBe(1);
		expect(tags(out, "code").length).toBe(1);
		expect(textOf(out)).toContain("删");
	});
});

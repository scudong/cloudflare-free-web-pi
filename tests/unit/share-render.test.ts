import { describe, expect, it } from "vitest";
import { demoShareToken, markdownToHtml, sharePage } from "../../src/worker/lib/share-render";

/**
 * 阶段 3：`sharePage` 迁入 lib/share-render.ts 后，PR #27/#29 的三块 DOM/CSS 必须原样保留。
 * 这里只钉渲染契约；API 侧的行为由 tests/api/api.test.ts 的分享用例覆盖。
 */

const META = { author: "π Harness", createdAt: "2026-10-22T05:00:00.000Z" };

describe("sharePage", () => {
	it("保留打印按钮与 @media print 规则（NERE-39）", () => {
		const html = sharePage("标题", "<article class=\"article\">正文</article>", 0, "dark", "", META);
		expect(html).toContain('class="print-btn"');
		expect(html).toContain('onclick="window.print()"');
		expect(html).toContain("打印 / 存为 PDF");
		expect(html).toContain("@media print");
		expect(html).toContain(".print-btn{display:none}");
		expect(html).toContain("thead{display:table-header-group}");
		expect(html).toContain("header{position:sticky");
	});

	it("保留页脚 Deploy 出口（NERE-46）", () => {
		const html = sharePage("标题", "正文", 0, "dark", "", META);
		expect(html).toContain('class="share-cta"');
		expect(html).toContain('href="https://github.com/scudong/cloudflare-free-web-pi?utm_source=share#deploy"');
		expect(html).toContain("用同样的方式做一个");
		expect(html).toContain(".share-cta,.demo-note{display:none}");
	});

	it("只读样例横条只给 demo token（NERE-46）", () => {
		const plain = sharePage("标题", "正文", 0, "dark", "", META);
		expect(plain).not.toContain('class="demo-note"');

		const demo = sharePage("标题", "正文", 0, "dark", "", META, true);
		expect(demo).toContain('class="demo-note"');
		expect(demo).toContain("<strong>这是只读样例</strong>");
	});
});

describe("demoShareToken", () => {
	it("只认站内 /s/<token> 与 https 绝对地址", () => {
		expect(demoShareToken("/s/demo-demo-demo")).toBe("demo-demo-demo");
		expect(demoShareToken("https://pi.example.com/s/abc123")).toBe("abc123");
		expect(demoShareToken("/s/")).toBe("");
		expect(demoShareToken("javascript:alert(1)")).toBe("");
		expect(demoShareToken(undefined)).toBe("");
	});
});

describe("markdownToHtml", () => {
	it("标题收集锚点、正文转义", () => {
		const headings: { level: number; text: string; id: string }[] = [];
		const html = markdownToHtml("# 总览\n\n## 重复\n\n## 重复\n\n<script>x</script>", { headings });
		expect(html).toContain('<h1 id="总览">总览</h1>');
		expect(html).toContain('<h2 id="重复">重复</h2>');
		expect(html).toContain('<h2 id="重复-2">重复</h2>');
		expect(html).not.toContain("<script>");
		expect(headings).toHaveLength(3);
	});
});

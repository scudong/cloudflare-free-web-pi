import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginGate } from "../../src/web/components/LoginGate";

const noop = async () => {};

describe("LoginGate · 公开演示入口（NERE-13）", () => {
	it("配置 demoUrl 时在登录表单下方渲染「看一个真实对话」", () => {
		const html = renderToStaticMarkup(<LoginGate onSubmit={noop} error={null} demoUrl="/s/demo-token" />);
		expect(html).toContain("请输入访问密码或邀请码");
		expect(html).toContain("看一个真实对话");
		expect(html).toContain("免登录 · 只读分享页");
		expect(html).toContain('href="/s/demo-token"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("未配置 demoUrl 时不渲染演示入口，不留死链", () => {
		const html = renderToStaticMarkup(<LoginGate onSubmit={noop} error={null} />);
		expect(html).not.toContain("看一个真实对话");
		expect(html).not.toContain("只读分享页");
	});
});

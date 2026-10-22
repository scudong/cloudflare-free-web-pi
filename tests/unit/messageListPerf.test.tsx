import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "../../src/web/components/MessageList";
import {
	clearMarkdownCache,
	markdownCacheStats,
	renderMarkdownCached,
	resetMarkdownCacheStats,
} from "../../src/web/lib/rich";
import type { ChatMessage } from "../../src/web/types";

const noop = () => {};

function assistantMessages(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `m${index}`,
		role: "assistant" as const,
		text: `## 第 ${index} 条\n\n这是历史消息 ${index} 的正文，包含 **粗体**、\`代码\` 与一个列表：\n\n- 第一项\n- 第二项`,
	}));
}

function renderConversation(messages: ChatMessage[], elapsed = 0): string {
	return renderToStaticMarkup(
		<MessageList
			messages={messages}
			pending={false}
			elapsed={elapsed}
			loading={false}
			loadError={null}
			onRetry={noop}
			plan={[]}
		/>,
	);
}

describe("renderMarkdownCached · 按原文缓存（NERE-75 P1-2）", () => {
	it("同一段文本只解析一次，返回同一份节点", () => {
		clearMarkdownCache();
		const first = renderMarkdownCached("你好 **世界**");
		const second = renderMarkdownCached("你好 **世界**");
		expect(second).toBe(first);
		expect(markdownCacheStats.parses).toBe(1);
		expect(markdownCacheStats.hits).toBe(1);
	});
});

describe("长会话重渲染 · 解析次数（NERE-75 P1-2）", () => {
	it("500 条历史后流式 40 个 delta：Markdown 解析次数 ≤ 2 × delta 数", () => {
		clearMarkdownCache();
		const messages = assistantMessages(500);
		renderConversation(messages); // 首屏：历史各解析一次
		resetMarkdownCacheStats();

		const DELTAS = 40;
		const base = messages[messages.length - 1] as Extract<ChatMessage, { role: "assistant" }>;
		for (let index = 1; index <= DELTAS; index++) {
			messages[messages.length - 1] = { ...base, text: `${base.text}\n\n增量 ${index}` };
			renderConversation(messages);
		}
		// 只有最后一条的文本在变：每次 delta 只解析一次
		expect(markdownCacheStats.parses).toBeLessThanOrEqual(2 * DELTAS);
	});

	it("elapsed 每秒变化不触发已有气泡重新解析", () => {
		clearMarkdownCache();
		const messages = assistantMessages(200);
		renderConversation(messages, 0);
		resetMarkdownCacheStats();

		for (let elapsed = 1; elapsed <= 10; elapsed++) renderConversation(messages, elapsed);
		expect(markdownCacheStats.parses).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { parseEntries } from "../../src/web/lib/entries";

/** 构造一条 pi 条目。 */
function entry(id: number, kind: string, model: unknown) {
	return { id, kind, model };
}

describe("parseEntries · 顺序", () => {
	it("后端倒序（新→旧）会被反转成正常对话顺序", () => {
		const raw = [
			entry(3, "pi.assistant", [{ content: [{ type: "text", text: "答" }] }]),
			entry(2, "pi.user", [{ role: "user", content: "问" }]),
		];
		const messages = parseEntries(raw);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({ text: "问" });
		expect(messages[1]).toMatchObject({ text: "答" });
	});

	it("已是正序时不反转", () => {
		const raw = [
			entry(1, "pi.user", [{ role: "user", content: "问" }]),
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "答" }] }]),
		];
		const messages = parseEntries(raw);
		expect(messages[0]).toMatchObject({ text: "问" });
	});
});

describe("parseEntries · 思考过程", () => {
	it("提取 thinking 内容块", () => {
		const raw = [
			entry(1, "pi.assistant", [
				{ content: [{ type: "thinking", thinking: "先想一下" }, { type: "text", text: "结论" }] },
			]),
		];
		const [msg] = parseEntries(raw);
		expect(msg).toMatchObject({ role: "assistant", text: "结论", thinking: "先想一下" });
	});
});

describe("parseEntries · 工具与产出", () => {
	it("工具结果挂到紧随其后的助手消息上", () => {
		const raw = [
			entry(3, "pi.assistant", [{ content: [{ type: "text", text: "完成" }] }]),
			entry(2, "pi.tool-result", [{ toolName: "now", content: [{ type: "text", text: "2026-10-19" }] }]),
			entry(1, "pi.user", [{ role: "user", content: "现在几点" }]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toMatchObject({ text: "完成" });
		expect((assistant as { tools?: { name: string }[] }).tools?.[0]?.name).toBe("now");
	});

	it("dispatch_tasks 结果反解出子任务标题", () => {
		const raw = [
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "汇总完毕" }] }]),
			entry(1, "pi.tool-result", [
				{
					toolName: "dispatch_tasks",
					content: [{ type: "text", text: "已并行完成 2/2 个子任务：\n1. 查 Deno 版本 — 完成 · 2.8s\n2. 查 Bun 版本 — 完成 · 17.0s\n\n## 子任务 1：查 Deno 版本" }],
				},
			]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant") as {
			tools?: { name: string; args?: { tasks?: { title: string }[] } }[];
		};
		expect(assistant.tools?.[0]?.args?.tasks?.map((t) => t.title)).toEqual(["查 Deno 版本", "查 Bun 版本"]);
	});

	it("write_file 结果生成文件产出", () => {
		const raw = [
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "已写入" }] }]),
			entry(1, "pi.tool-result", [{ toolName: "write_file", content: [{ type: "text", text: "已写入 report.md（1234 字符）。" }] }]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant") as { files?: { name: string; size?: number }[] };
		expect(assistant.files).toEqual([{ name: "report.md", size: 1234 }]);
	});
});

describe("parseEntries · 容错", () => {
	it("空输入返回空数组", () => {
		expect(parseEntries(null)).toEqual([]);
		expect(parseEntries([])).toEqual([]);
	});

	it("未知 kind 被跳过而不抛错", () => {
		const raw = [entry(1, "pi.unknown", [{ content: "x" }]), entry(2, "pi.user", [{ role: "user", content: "问" }])];
		const messages = parseEntries(raw);
		expect(messages.length).toBe(1);
		expect(messages[0]).toMatchObject({ role: "user" });
	});
});

import type { ChatMessage, ToolCallInfo } from "../types";

/** 工具活动条摘要的最大长度（字）。 */
export const TOOL_SUMMARY_MAX = 60;

/** 压缩空白并把字符串截断到 max 字（超出加省略号）。 */
export function truncateOneLine(text: string, max: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s;
}

/**
 * 宽容提取任意条目里的文本：
 * - string 原样返回
 * - 数组：递归拼接各部分（pi 的 content 常是 [{type:"text",text:"..."}]）
 * - 对象：优先 text / content / output / result 字段
 */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => textOf(part)).join("");
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		for (const key of ["text", "content", "output", "result", "summary", "message"]) {
			if (o[key] !== undefined && o[key] !== null) return textOf(o[key]);
		}
	}
	return "";
}

function pickString(o: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/**
 * 把 GET /api/entries 的历史条目宽容解析为消息列表。
 * - user：取 content 文本 → 右侧气泡
 * - assistant：取文本 → 左侧气泡；此前累积的 tool-result 作为其上方的工具活动条
 * - tool-result：显示为一行摘要（🔧 名称 · 摘要，截断 60 字）
 * - 未知 kind：跳过
 */
export function parseEntries(entries: unknown): ChatMessage[] {
	const list = Array.isArray(entries) ? entries : [];
	const messages: ChatMessage[] = [];
	let pendingTools: ToolCallInfo[] = [];
	let seq = 0;

	const flushStandaloneTools = () => {
		if (pendingTools.length === 0) return;
		messages.push({ id: `t${seq++}`, role: "tool", tools: pendingTools });
		pendingTools = [];
	};

	for (const raw of list) {
		if (raw === null || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const kind = pickString(entry, ["kind", "type"]);

		if (kind === "user") {
			const text = textOf(entry.content ?? entry.text).trim();
			if (!text) continue;
			flushStandaloneTools();
			messages.push({ id: `u${seq++}`, role: "user", text });
		} else if (kind === "assistant") {
			const text = textOf(entry.content ?? entry.text).trim();
			const tools = pendingTools;
			pendingTools = [];
			if (!text && tools.length === 0) continue;
			messages.push({ id: `a${seq++}`, role: "assistant", text, tools: tools.length ? tools : undefined });
		} else if (kind === "tool-result" || kind === "tool_result" || kind === "toolResult") {
			const name = pickString(entry, ["name", "toolName", "tool", "tool_name"]) || "工具";
			const rawSummary = textOf(entry.summary ?? entry.output ?? entry.content ?? entry.result ?? entry.text);
			const failed = entry.isError === true || entry.is_error === true || entry.error === true;
			const prefix = failed ? "失败：" : "";
			const summary = truncateOneLine(rawSummary, TOOL_SUMMARY_MAX);
			// Keep the untruncated original so the pill can expand to the full output
			pendingTools.push({ name, summary: prefix + summary, full: prefix + rawSummary });
		}
		// 其他 kind：宽容跳过
	}
	flushStandaloneTools();
	return messages;
}

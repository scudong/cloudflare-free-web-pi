import type { ChatMessage, ShareLinkInfo, ToolCallInfo } from "../types";

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
	if (Array.isArray(value)) {
		return value
			.filter((part) => !(part && typeof part === "object" && (part as { type?: unknown }).type === "image"))
			.map((part) => textOf(part))
			.join("");
	}
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		for (const key of ["text", "content", "output", "result", "summary", "message"]) {
			if (o[key] !== undefined && o[key] !== null) return textOf(o[key]);
		}
	}
	return "";
}

/** 从条目内容块里收集图片，转成可直接渲染的 data URL。 */
function imagesOf(value: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		if (o.type === "image" && typeof o.data === "string") {
			found.push(`data:${typeof o.mimeType === "string" ? o.mimeType : "image/png"};base64,${o.data}`);
			return;
		}
		for (const key of ["content", "model", "message", "parts"]) {
			if (o[key] !== undefined) walk(o[key]);
		}
	};
	walk(value);
	return found;
}

/** 从条目内容块里收集思考过程（v0.22.0）：pi-ai 的 {type:"thinking", thinking:"..."}。 */
function thinkingOf(value: unknown): string {
	const parts: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		if (o.type === "thinking" && typeof o.thinking === "string") {
			parts.push(o.thinking);
			return;
		}
		for (const key of ["content", "model", "message", "parts"]) {
			if (o[key] !== undefined) walk(o[key]);
		}
	};
	walk(value);
	return parts.join("");
}

/** 从 write_file 的工具结果文本里提取产出文件名与大小（v0.22.0）。 */
function artifactsOf(toolName: string, text: string): { name: string; size?: number }[] {
	if (toolName !== "write_file") return [];
	const m = /已写入\s+(.+?)（(\d+)\s*字符）/.exec(text);
	if (!m) return [];
	const size = Number(m[2]);
	return [{ name: m[1]!.trim(), ...(Number.isFinite(size) ? { size } : {}) }];
}

const SHARE_TOOL_NAMES = new Set(["share_file", "share_conversation"]);

/**
 * 从分享工具的返回文本里解析链接卡（v0.55.0）。
 * 后端格式固定为：`已生成分享链接：<url>\n<title> · 有效期至 <yyyy-MM-dd HH:mm>`（或「长期有效」）。
 */
export function parseShareResult(toolName: string, text: string): ShareLinkInfo | null {
	if (!SHARE_TOOL_NAMES.has(toolName)) return null;
	const url = /https?:\/\/[^\s<>"')]+\/s\/[A-Za-z0-9._-]+/.exec(text)?.[0];
	if (!url) return null;
	const after = text.slice(text.indexOf(url) + url.length).trim();
	const line = (after.split("\n")[0] ?? "").trim();
	const [titleRaw, ...rest] = line.split("·");
	const title = (titleRaw ?? "").trim() || (toolName === "share_file" ? "文件" : "对话");
	return {
		url,
		title,
		expiresLabel: rest.join("·").trim() || "有效期未知",
		kind: toolName === "share_file" ? "file" : "conversation",
	};
}

function pickString(o: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/**
 * 判断条目是否按 id 倒序（后端 /api/entries 的返回顺序）。
 * 只看首尾两个带数字 id 的条目，缺失/相等时按正序处理。
 */
function isDescending(list: unknown[]): boolean {
	const ids: number[] = [];
	for (const item of list) {
		if (item && typeof item === "object") {
			const id = (item as { id?: unknown }).id;
			if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
		}
		if (ids.length >= 2) break;
	}
	if (ids.length < 2) return false;
	// 取最后一个 id 对比（列表可能有尾部空项）
	for (let i = list.length - 1; i >= 0; i--) {
		const item = list[i];
		if (!item || typeof item !== "object") continue;
		const id = (item as { id?: unknown }).id;
		if (typeof id === "number" && Number.isFinite(id)) return ids[0]! > id;
	}
	return false;
}

/**
 * 把 GET /api/entries 的历史条目宽容解析为消息列表。
 * - user：取 content 文本 → 右侧气泡
 * - assistant：取文本 → 左侧气泡；此前累积的 tool-result 作为其上方的工具活动条
 * - tool-result：显示为一行摘要（🔧 名称 · 摘要，截断 60 字）
 * - 未知 kind：跳过
 */
export function parseEntries(entries: unknown): ChatMessage[] {
	const raw = Array.isArray(entries) ? entries : [];
	// 后端按 id 倒序返回（新→旧），聊天要按时间正序显示；顺带修正工具结果归属。
	const list = isDescending(raw) ? [...raw].reverse() : raw;
	const messages: ChatMessage[] = [];
	let pendingTools: ToolCallInfo[] = [];
	/** 待挂到下一条助手消息的文件产出。 */
	let pendingFiles: { name: string; size?: number }[] = [];
	/** 待挂到下一条助手消息的分享链接（v0.55.0）。 */
	let pendingShares: ShareLinkInfo[] = [];
	let seq = 0;

	const flushStandaloneTools = () => {
		if (pendingTools.length === 0) return;
		messages.push({ id: `t${seq++}`, role: "tool", tools: pendingTools });
		pendingTools = [];
	};

	for (const raw of list) {
		if (raw === null || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		// 后端条目 kind 形如 pi.user / pi.assistant / pi.tool-result，这里统一去掉前缀。
		const kind = pickString(entry, ["kind", "type"]).replace(/^pi\./, "");

		if (kind === "user") {
			const body = entry.model ?? entry.content ?? entry.text;
			const text = textOf(body).trim();
			const images = imagesOf(body);
			if (!text && images.length === 0) continue;
			flushStandaloneTools();
			// 上一轮没有落助手消息的分享结果不再挂到下一轮
			pendingShares = [];
			const entryId = typeof entry.id === "number" ? entry.id : undefined;
			messages.push({
				id: `u${seq++}`,
				role: "user",
				text: text || "（图片）",
				...(images.length ? { images } : {}),
				// 分支（v0.32.0）：保留真实条目 id，供「从这里分支」使用
				...(entryId !== undefined ? { entryId } : {}),
			});
		} else if (kind === "assistant") {
			const text = textOf(entry.model ?? entry.content ?? entry.text).trim();
			const thinking = thinkingOf(entry.model ?? entry.content ?? entry.text).trim();
			const tools = pendingTools;
			pendingTools = [];
			if (!text && tools.length === 0 && !thinking) continue;
			const files = pendingFiles;
			pendingFiles = [];
			const shares = pendingShares;
			pendingShares = [];
			messages.push({
				id: `a${seq++}`,
				role: "assistant",
				text,
				tools: tools.length ? tools : undefined,
				thinking: thinking || undefined,
				files: files.length ? files : undefined,
				shares: shares.length ? shares : undefined,
			});
		} else if (kind === "compaction") {
			// pi.compaction：早期对话被摘要成一条记录（v0.31.0），聊天里显示为一条系统提示
			flushStandaloneTools();
			messages.push({ id: `c${seq++}`, role: "notice", text: "上下文已压缩：更早的对话被摘要为一条记录，最近的内容保持原文。" });
		} else if (kind === "tool-result" || kind === "tool_result" || kind === "toolResult") {
			// 后端把工具结果放在 model[0]：{ toolName, content: [{type:"text",text}] }
			const firstModel = Array.isArray(entry.model) ? (entry.model[0] as Record<string, unknown> | undefined) : undefined;
			const name =
				pickString(entry, ["name", "toolName", "tool", "tool_name"]) ||
				(firstModel ? pickString(firstModel, ["toolName", "name"]) : "") ||
				"工具";
			const rawSummary = textOf(
				entry.summary ??
					entry.output ??
					entry.content ??
					entry.result ??
					entry.text ??
					firstModel?.content ??
					firstModel?.output,
			);
			const failed = entry.isError === true || entry.is_error === true || entry.error === true;
			const prefix = failed ? "失败：" : "";
			const summary = truncateOneLine(rawSummary, TOOL_SUMMARY_MAX);
			// dispatch_tasks：历史回放时没有 args，从结果首部的「1. 标题 — 完成 · 2.8s」反解子任务
			let args: unknown;
			if (name === "dispatch_tasks") {
				const titles = [...rawSummary.matchAll(/^\d+\.\s+(.+?)\s+—\s+/gm)].map((m) => ({ title: m[1] ?? "" }));
				if (titles.length) args = { tasks: titles };
			}
			// Keep the untruncated original so the pill can expand to the full output
			pendingTools.push({ name, summary: prefix + summary, full: prefix + rawSummary, ...(args ? { args } : {}) });
			// 文件产出：留到下一条助手消息一起渲染（v0.25.2 修正归属）
			pendingFiles.push(...artifactsOf(name, rawSummary));
			// 分享链接卡：同样挂到下一条助手消息（v0.55.0），同一 URL 只保留一张
			const share = parseShareResult(name, rawSummary);
			if (share && !pendingShares.some((item) => item.url === share.url)) pendingShares.push(share);
		}
		// 其他 kind：宽容跳过
	}
	flushStandaloneTools();
	return messages;
}

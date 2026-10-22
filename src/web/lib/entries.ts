import type { ChatMessage, KbRef, ShareLink, ToolCallInfo } from "../types";

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

/** 从 share_file / share_conversation 的 details（优先）或结果文本里提取链接卡数据（v0.55.0）。 */
function shareOf(toolName: string, details: unknown, text: string): ShareLink | null {
	if (toolName !== "share_file" && toolName !== "share_conversation") return null;
	if (details && typeof details === "object" && "share" in details) {
		const share = details.share;
		if (share && typeof share === "object" && "url" in share && typeof share.url === "string") {
			const kind = "kind" in share && share.kind === "conversation" ? "conversation" : "file";
			const name = "name" in share && typeof share.name === "string" ? share.name : "";
			return {
				url: share.url,
				title: name || (kind === "conversation" ? "对话分享" : "文件分享"),
				kind,
				expiresAt: "expiresAt" in share && typeof share.expiresAt === "number" ? share.expiresAt : 0,
				createdAt: "createdAt" in share && typeof share.createdAt === "string" ? share.createdAt : undefined,
				reused: "reused" in share && share.reused === true,
			};
		}
	}
	// 旧记录/裁剪后的详情：退回从「分享链接：<url>」里取
	const m = /分享链接：([^\s（）]+)/.exec(text);
	if (!m) return null;
	const kind = toolName === "share_conversation" ? "conversation" : "file";
	return {
		url: m[1]!,
		title: kind === "conversation" ? "对话分享" : "文件分享",
		kind,
		expiresAt: 0,
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
 * 宽容解析 entry.kbRefs：缺省/非数组 → []；丢弃 docId 非法的项；
 * 按 docId:chunkId 去重并保持原序（NERE-40 / NERE-41）。
 */
export function parseKbRefs(value: unknown): KbRef[] {
	if (!Array.isArray(value)) return [];
	const refs: KbRef[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		if (typeof o.docId !== "number" || !Number.isFinite(o.docId)) continue;
		const chunkId = typeof o.chunkId === "number" && Number.isFinite(o.chunkId) ? o.chunkId : 0;
		const key = `${o.docId}:${chunkId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const source = pickString(o, ["source"]);
		refs.push({
			docId: o.docId,
			chunkId,
			chunkSeq: typeof o.chunkSeq === "number" && Number.isFinite(o.chunkSeq) ? o.chunkSeq : 0,
			title: pickString(o, ["title"]) || "未命名文档",
			...(source ? { source } : {}),
		});
	}
	return refs;
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
	/** 待挂到下一条助手消息的分享链接。 */
	let pendingShares: ShareLink[] = [];
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
			const kbRefs = parseKbRefs(entry.kbRefs);
			messages.push({
				id: `a${seq++}`,
				role: "assistant",
				text,
				tools: tools.length ? tools : undefined,
				thinking: thinking || undefined,
				files: files.length ? files : undefined,
				shares: shares.length ? shares : undefined,
				...(kbRefs.length ? { kbRefs } : {}),
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
			// 分享链接：details 优先，缺 details 时从文本取（v0.55.0）
			const details = firstModel?.details;
			const share = shareOf(name, details, rawSummary);
			if (share) pendingShares.push(share);
		}
		// 其他 kind：宽容跳过
	}
	flushStandaloneTools();
	return messages;
}

/**
 * `/export` 的 Markdown 渲染（ADR-0001 §5.6 共享纯函数）：输入条目，输出与旧
 * `SpikeAgent.exportMarkdown` 逐字一致的文本。
 */
export type ExportEntry = Record<string, unknown>;
export type ExportSnapshot = { sessionId: string; title: string; entries: readonly ExportEntry[] };

function textOf(model: unknown): string {
	const blocks = Array.isArray(model) ? (model as { content?: unknown }[]) : [];
	for (const block of blocks) {
		const content = block?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text ?? "") : ""))
				.join("");
			if (text) return text;
		}
	}
	return "";
}

export function renderExportMarkdown(snapshot: ExportSnapshot, exportedAt = new Date().toISOString()): {
	markdown: string;
	title: string;
	sessionId: string;
} {
	const { sessionId, title } = snapshot;
	const lines: string[] = [`# ${title}`, "", `> 导出时间：${exportedAt}　·　会话 #${sessionId}`, ""];
	// 条目按 id 倒序返回，导出时按时间正序。
	for (const entry of [...snapshot.entries].reverse()) {
		const kind = String(entry.kind ?? "");
		const text = textOf(entry.model);
		if (kind === "pi.user" && text.trim()) {
			lines.push(`## 用户`, "", text.trim(), "");
		} else if (kind === "pi.assistant" && text.trim()) {
			lines.push(`## 助手`, "", text.trim(), "");
		} else if (kind === "pi.tool-result") {
			const blocks = Array.isArray(entry.model)
				? (entry.model as { toolName?: string; content?: { text?: string }[] }[])
				: [];
			const first = blocks[0];
			const summary = (first?.content ?? []).map((c) => c.text ?? "").join("").trim().slice(0, 200);
			if (first?.toolName) lines.push(`> 🔧 ${first.toolName}${summary ? `：${summary}` : ""}`, "");
		}
	}
	return { markdown: lines.join("\n"), title, sessionId };
}

/**
 * Harness entry 的只读取值纯函数（ADR-0001 §5 规则 6）。
 * entry 形状来自 pi-durable 的 `model` 字段：分享页与会话上下文估算共用。
 */

/** 从 entry.model 里取纯文本（用户 / 助手 / 工具结果通用）。 */
export function entryText(model: unknown): string {
	const blocks = Array.isArray(model) ? (model as { content?: unknown }[]) : [];
	for (const block of blocks) {
		const content = block?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: unknown }).text ?? "") : "")).join("");
		}
	}
	return "";
}

/** 从 assistant entry 里取本次请求的 token 用量（input + output）。 */
export function entryUsage(model: unknown): number | null {
	const blocks = Array.isArray(model) ? (model as { usage?: unknown }[]) : [];
	for (const block of blocks) {
		const usage = block?.usage as { input?: unknown; output?: unknown } | undefined;
		if (usage && typeof usage === "object") {
			return (Number(usage.input) || 0) + (Number(usage.output) || 0);
		}
	}
	return null;
}

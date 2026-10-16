import type { ReactNode } from "react";

/**
 * 极简富文本渲染（不引库）：换行由容器的 whitespace-pre-wrap 承担，
 * 这里只处理 **加粗**。其余字符按纯文本输出（React 自动转义，安全）。
 */
export function renderRichText(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /\*\*([^*]+)\*\*/g;
	let last = 0;
	let key = 0;
	let match: RegExpExecArray | null;

	while ((match = re.exec(text)) !== null) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		nodes.push(
			<strong key={key++} className="font-semibold text-white">
				{match[1] ?? ""}
			</strong>,
		);
		last = match.index + match[0].length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

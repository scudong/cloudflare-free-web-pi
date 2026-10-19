import type { ReactNode } from "react";
import { isValidElement } from "react";

/** 把 React 元素树（renderMarkdown 的返回值）拍平成纯文本，便于断言。 */
export function textOf(node: unknown): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode };
		return textOf(props.children);
	}
	// findAll 返回的是 { type, props } 包装对象
	if (typeof node === "object" && node !== null && "props" in node) {
		return textOf((node as { props?: { children?: ReactNode } }).props?.children);
	}
	return "";
}

/** 递归收集满足条件的元素。 */
export function findAll(node: ReactNode, predicate: (el: { type: unknown; props: Record<string, unknown> }) => boolean): { type: unknown; props: Record<string, unknown> }[] {
	const out: { type: unknown; props: Record<string, unknown> }[] = [];
	const walk = (n: ReactNode) => {
		if (Array.isArray(n)) {
			n.forEach(walk);
			return;
		}
		if (!isValidElement(n)) return;
		const el = { type: n.type, props: n.props as Record<string, unknown> };
		if (predicate(el)) out.push(el);
		walk((n.props as { children?: ReactNode }).children);
	};
	walk(node);
	return out;
}

/** 收集某种标签名（如 "h2"、"table"）的元素。 */
export function tags(node: ReactNode, type: string) {
	return findAll(node, (el) => el.type === type);
}

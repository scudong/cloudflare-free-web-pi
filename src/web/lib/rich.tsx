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

/**
 * Minimal markdown rendering for the workbench file preview (no library):
 * supports # / ## / ### headings, "- " bullet lists, **bold** and blank-line paragraph breaks.
 * Lines are rendered as block elements, so the container must NOT use whitespace-pre-wrap.
 */
export function renderMarkdown(text: string): ReactNode[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const nodes: ReactNode[] = [];
	let bullets: string[] = [];
	let key = 0;

	const flushBullets = () => {
		if (bullets.length === 0) return;
		const items = bullets;
		bullets = [];
		nodes.push(
			<ul key={key++} className="my-1 list-disc space-y-0.5 pl-5 marker:text-slate-500">
				{items.map((item, index) => (
					<li key={index}>{renderRichText(item)}</li>
				))}
			</ul>,
		);
	};

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();

		if (!line.trim()) {
			flushBullets();
			continue;
		}

		const heading = /^(#{1,3})\s+(.+)$/.exec(line);
		if (heading) {
			flushBullets();
			const level = heading[1]?.length ?? 1;
			const content = heading[2] ?? "";
			const cls =
				level === 1
					? "mb-1 mt-3 text-base font-semibold text-white first:mt-0"
					: level === 2
						? "mb-1 mt-2.5 text-[15px] font-semibold text-slate-100 first:mt-0"
						: "mt-2 text-sm font-semibold text-slate-200 first:mt-0";
			nodes.push(
				<div key={key++} className={cls}>
					{renderRichText(content)}
				</div>,
			);
			continue;
		}

		const bullet = /^[-*]\s+(.+)$/.exec(line);
		if (bullet) {
			bullets.push(bullet[1] ?? "");
			continue;
		}

		flushBullets();
		nodes.push(
			<p key={key++} className="my-0.5">
				{renderRichText(line)}
			</p>,
		);
	}
	flushBullets();
	return nodes;
}

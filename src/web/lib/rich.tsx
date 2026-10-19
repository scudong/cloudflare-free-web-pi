import type { ReactNode } from "react";

/**
 * 极简富文本渲染（不引库）：换行由容器的 whitespace-pre-wrap 承担，
 * 这里只处理 **加粗**。其余字符按纯文本输出（React 自动转义，安全）。
 */
export function renderRichText(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	// 行内：**加粗**、`代码`、[文字](链接)
	const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
	let last = 0;
	let key = 0;
	let match: RegExpExecArray | null;

	while ((match = re.exec(text)) !== null) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		if (match[2] !== undefined) {
			nodes.push(
				<strong key={key++} className="font-semibold text-white">
					{match[2]}
				</strong>,
			);
		} else if (match[4] !== undefined) {
			nodes.push(
				<code key={key++} className="rounded bg-slate-950/70 px-1 py-0.5 font-mono text-[0.92em] text-slate-200">
					{match[4]}
				</code>,
			);
		} else if (match[6] !== undefined) {
			const href = match[7] ?? "#";
			const safe = /^https?:\/\//.test(href) || href.startsWith("/") || href.startsWith("#");
			nodes.push(
				safe ? (
					<a key={key++} href={href} target="_blank" rel="noreferrer noopener" className="text-sky-400 underline">
						{match[6]}
					</a>
				) : (
					<span key={key++}>{match[6]}</span>
				),
			);
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

/**
 * 轻量 Markdown 渲染（v0.15.0 增强）：标题 1–6、有序/无序列表、代码块、引用、分隔线、
 * 管道表格、行内代码/加粗/链接。刻意不引第三方库，避免体积与 XSS 面。
 */
export function renderMarkdown(text: string): ReactNode[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const nodes: ReactNode[] = [];
	let bullets: string[] = [];
	let ordered: string[] = [];
	let table: string[] = [];
	let quote: string[] = [];
	let key = 0;

	const flushBullets = () => {
		if (!bullets.length) return;
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
	const flushOrdered = () => {
		if (!ordered.length) return;
		const items = ordered;
		ordered = [];
		nodes.push(
			<ol key={key++} className="my-1 list-decimal space-y-0.5 pl-5 marker:text-slate-500">
				{items.map((item, index) => (
					<li key={index}>{renderRichText(item)}</li>
				))}
			</ol>,
		);
	};
	const flushQuote = () => {
		if (!quote.length) return;
		const items = quote;
		quote = [];
		nodes.push(
			<blockquote key={key++} className="my-1.5 border-l-2 border-slate-600 pl-3 text-slate-400">
				{items.map((item, index) => (
					<p key={index} className="my-0.5">
						{renderRichText(item)}
					</p>
				))}
			</blockquote>,
		);
	};
	const flushTable = () => {
		if (!table.length) return;
		const rows = table.map((row) =>
			row
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
		table = [];
		const header = rows[0] ?? [];
		const body = rows.filter((row, index) => index > 0 && !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
		nodes.push(
			<div key={key++} className="my-2 overflow-x-auto">
				<table className="w-full border-collapse text-[13px]">
					<thead>
						<tr>
							{header.map((cell, index) => (
								<th key={index} className="border border-slate-700 bg-slate-800/60 px-2 py-1 text-left font-medium">
									{renderRichText(cell)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.map((row, rIndex) => (
							<tr key={rIndex}>
								{row.map((cell, cIndex) => (
									<td key={cIndex} className="border border-slate-700 px-2 py-1">
										{renderRichText(cell)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>,
		);
	};
	const flushAll = () => {
		flushBullets();
		flushOrdered();
		flushQuote();
		flushTable();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trimEnd();

		// 代码块
		const fence = /^```(\w+)?\s*$/.exec(line.trim());
		if (fence) {
			flushAll();
			const lang = fence[1] ?? "";
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
				body.push(lines[i]!);
				i++;
			}
			nodes.push(
				<pre key={key++} className="my-2 overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-[12.5px] leading-relaxed">
					<code className="font-mono text-slate-200" data-lang={lang}>
						{body.join("\n")}
					</code>
				</pre>,
			);
			continue;
		}

		if (!line.trim()) {
			flushAll();
			continue;
		}

		// 分隔线
		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
			flushAll();
			nodes.push(<hr key={key++} className="my-3 border-slate-700" />);
			continue;
		}

		// 标题 1–6
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			flushAll();
			const level = heading[1]?.length ?? 1;
			const content = heading[2] ?? "";
			const cls =
				level === 1
					? "mb-1.5 mt-3 text-lg font-semibold text-white first:mt-0"
					: level === 2
						? "mb-1 mt-2.5 text-base font-semibold text-slate-100 first:mt-0"
						: level === 3
							? "mb-1 mt-2 text-[15px] font-semibold text-slate-200 first:mt-0"
							: "mt-2 text-sm font-semibold text-slate-300 first:mt-0";
			nodes.push(
				<div key={key++} className={cls}>
					{renderRichText(content)}
				</div>,
			);
			continue;
		}

		// 管道表格
		if (/^\s*\|.*\|\s*$/.test(line)) {
			flushBullets();
			flushOrdered();
			flushQuote();
			table.push(line);
			continue;
		}
		flushTable();

		// 引用
		const quoteLine = /^>\s?(.*)$/.exec(line);
		if (quoteLine) {
			flushBullets();
			flushOrdered();
			quote.push(quoteLine[1] ?? "");
			continue;
		}
		flushQuote();

		// 列表
		const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
		if (bullet) {
			flushOrdered();
			bullets.push(bullet[1] ?? "");
			continue;
		}
		const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
		if (numbered) {
			flushBullets();
			ordered.push(numbered[1] ?? "");
			continue;
		}

		flushBullets();
		flushOrdered();
		nodes.push(
			<p key={key++} className="my-0.5">
				{renderRichText(line)}
			</p>,
		);
	}
	flushAll();
	return nodes;
}

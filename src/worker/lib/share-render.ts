/**
 * 分享页渲染纯函数（ADR-0001 §1/§5 规则 6）：只做字符串拼接。
 * 不读 SQL、不碰 Harness、不构造 Response；SQL 在 repo/shares-repo.ts，编排在 services/share-service.ts。
 */

export type SharePage = { status: number; contentType: string; body: string; headers?: Record<string, string> };

/** HTML 转义。 */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 极简 Markdown → HTML（只用于公开分享页）。
 * 支持标题、列表（含任务项）、代码块、引用、分隔线、管道表格与常用行内样式。
 * 原文一律转义，不解释原始 HTML，因此没有 XSS 面。
 * 传入 headings 时收集 h1–h4 并生成锚点 id（分享页目录，v0.41.0）。
 */
export interface ShareHeading {
	level: number;
	text: string;
	id: string;
}

/** 标题纯文本：去掉行内标记，供目录显示。 */
export function headingPlainText(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[*_~]/g, "")
		.trim();
}

/** 标题锚点：保留中英文数字，其余压成 -，重复的加序号。 */
export function headingSlug(text: string, used: Set<string>): string {
	const base =
		headingPlainText(text)
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s-]/gu, "")
			.trim()
			.replace(/\s+/g, "-") || "section";
	let id = base;
	let n = 2;
	while (used.has(id)) id = `${base}-${n++}`;
	used.add(id);
	return id;
}

export function markdownToHtml(
	source: string,
	opts?: { headings?: ShareHeading[]; usedIds?: Set<string> },
): string {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const used = opts?.usedIds ?? new Set<string>();
	const safeHref = /^(https?:\/\/|mailto:|\/|#)/i;
	const safeSrc = /^(https?:\/\/|data:image\/)/i;

	const inline = (raw: string): string => {
		// 行内代码先抽出来，避免里面的 * _ ~ 被当成强调
		const codes: string[] = [];
		let text = raw.replace(/`([^`\n]+)`/g, (_, code: string) => {
			codes.push(`<code>${escapeHtml(code)}</code>`);
			return `\u0000${codes.length - 1}\u0000`;
		});
		text = escapeHtml(text)
			.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, src: string) =>
				safeSrc.test(src) ? `<img src="${src}" alt="${alt}" loading="lazy">` : match,
			)
			.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) =>
				safeHref.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label,
			)
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
			.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
			.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
		return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)] ?? "");
	};
	const isBlockStart = (line: string): boolean =>
		/^\s*#{1,6}\s+/.test(line) ||
		/^\s*(```|~~~)/.test(line) ||
		/^\s*>/.test(line) ||
		/^\s*([-*+]|\d+\.)\s+/.test(line) ||
		/^\s*(---+|\*\*\*+|___+)\s*$/.test(line) ||
		/^\s*\|/.test(line);

	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}

		// 代码块
		const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
		if (fence) {
			const closer = new RegExp(`^\\s*${fence[1]}\\s*$`);
			const code: string[] = [];
			i++;
			while (i < lines.length && !closer.test(lines[i])) {
				code.push(lines[i]);
				i++;
			}
			i++; // 跳过结束围栏
			out.push(`<pre><code${fence[2] ? ` class="lang-${escapeHtml(fence[2])}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}

		// 标题
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const raw = heading[2].trim();
			if (opts?.headings && level <= 4) {
				const id = headingSlug(raw, used);
				out.push(`<h${level} id="${id}">${inline(raw)}</h${level}>`);
				opts.headings.push({ level, text: headingPlainText(raw), id });
			} else {
				out.push(`<h${level}>${inline(raw)}</h${level}>`);
			}
			i++;
			continue;
		}

		// 分隔线
		if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		// 引用：整段递归解析
		if (/^\s*>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quoted.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			out.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
			continue;
		}

		// 列表
		const listItem = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
		if (listItem) {
			const ordered = /^\d+\.$/.test(listItem[1]);
			const items: string[] = [];
			while (i < lines.length) {
				const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
				if (!item) break;
				const task = /^\[([ xX])\]\s+(.*)$/.exec(item[2]);
				items.push(
					`<li>${task ? `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> ` : ""}${inline(task ? task[2] : item[2])}</li>`,
				);
				i++;
			}
			out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
			continue;
		}

		// 管道表格
		if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
			const cells = (row: string): string[] =>
				row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
			const aligns = cells(lines[i + 1]).map((cell) => {
				const left = cell.startsWith(":");
				const right = cell.endsWith(":");
				return left && right ? "center" : right ? "right" : left ? "left" : "";
			});
			const head = cells(line);
			i += 2;
			const body: string[] = [];
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
				const row = cells(lines[i]);
				body.push(
					`<tr>${row
						.map((cell, index) => `<td${aligns[index] ? ` style="text-align:${aligns[index]}"` : ""}>${inline(cell)}</td>`)
						.join("")}</tr>`,
				);
				i++;
			}
			out.push(
				`<table><thead><tr>${head
					.map((cell, index) => `<th${aligns[index] ? ` style="text-align:${aligns[index]}"` : ""}>${inline(cell)}</th>`)
					.join("")}</tr></thead><tbody>${body.join("")}</tbody></table>`,
			);
			continue;
		}

		// 普通段落：连续行用 <br> 连接
		const paragraph: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
			paragraph.push(lines[i]);
			i++;
		}
		out.push(`<p>${paragraph.map((part) => inline(part)).join("<br>")}</p>`);
	}
	return out.join("\n");
}

/** 目录（v0.41.0）：少于两个标题不显示；最多 60 条。 */
export function shareToc(headings: ShareHeading[]): string {
	if (headings.length < 2) return "";
	const items = headings.slice(0, 60).map(
		(h) => `<li><a class="l${Math.min(h.level, 4)}" href="#${h.id}">${escapeHtml(h.text)}</a></li>`,
	);
	return `<nav class="toc" aria-label="目录"><div class="toc-title">目录</div><ul>${items.join("")}</ul></nav>`;
}

/* ---- 分享页主题（v0.39.1）：与客户端四套主题一一对应 ---- */

export type ShareThemeId = "dark" | "light" | "sepia" | "midnight";

export interface SharePalette {
	scheme: "dark" | "light";
	bg: string;
	panel: string;
	panelAlt: string;
	border: string;
	fg: string;
	muted: string;
	accent: string;
	accentSoft: string;
	accentBorder: string;
	userBg: string;
	userBorder: string;
}

/** 色值取自 web/styles/index.css 的 Arco 主题变量。 */
export const SHARE_PALETTES: Record<ShareThemeId, SharePalette> = {
	dark: {
		scheme: "dark",
		bg: "#17171a",
		panel: "#232324",
		panelAlt: "#2a2a2b",
		border: "#3a3a3c",
		fg: "#f2f3f5",
		muted: "#86909c",
		accent: "#6aa1ff",
		accentSoft: "rgba(64,128,255,.14)",
		accentBorder: "rgba(64,128,255,.35)",
		userBg: "rgba(64,128,255,.12)",
		userBorder: "rgba(64,128,255,.3)",
	},
	light: {
		scheme: "light",
		bg: "#f7f8fa",
		panel: "#ffffff",
		panelAlt: "#f2f3f5",
		border: "#e5e6eb",
		fg: "#1d2129",
		muted: "#86909c",
		accent: "#165dff",
		accentSoft: "rgba(22,93,255,.08)",
		accentBorder: "rgba(22,93,255,.25)",
		userBg: "rgba(22,93,255,.07)",
		userBorder: "rgba(22,93,255,.2)",
	},
	sepia: {
		scheme: "light",
		bg: "#fcf8ec",
		panel: "#fffdf6",
		panelAlt: "#f7efd9",
		border: "#ebdcbc",
		fg: "#2e2415",
		muted: "#a08c68",
		accent: "#b37a00",
		accentSoft: "rgba(217,152,0,.12)",
		accentBorder: "rgba(179,122,0,.35)",
		userBg: "rgba(217,152,0,.1)",
		userBorder: "rgba(179,122,0,.25)",
	},
	midnight: {
		scheme: "dark",
		bg: "#0b1220",
		panel: "#121a2e",
		panelAlt: "#1a2440",
		border: "#263454",
		fg: "#eaf0fa",
		muted: "#6b80a8",
		accent: "#6aa1ff",
		accentSoft: "rgba(64,128,255,.14)",
		accentBorder: "rgba(64,128,255,.35)",
		userBg: "rgba(64,128,255,.1)",
		userBorder: "rgba(64,128,255,.3)",
	},
};

export function isShareTheme(value: unknown): value is ShareThemeId {
	return typeof value === "string" && value in SHARE_PALETTES;
}

/** 分享页与过期页共用的样式（按主题生成 CSS 变量）。 */
export function shareCss(theme: ShareThemeId): string {
	const p = SHARE_PALETTES[theme];
	return `
:root{color-scheme:${p.scheme};--bg:${p.bg};--panel:${p.panel};--panel-alt:${p.panelAlt};--border:${p.border};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--accent-soft:${p.accentSoft};--accent-border:${p.accentBorder};--user-bg:${p.userBg};--user-border:${p.userBorder}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:.6rem;padding:.9rem 1.2rem;background:var(--panel);border-bottom:1px solid var(--border)}
header .badge{font-size:12px;color:var(--accent);border:1px solid var(--accent-border);background:var(--accent-soft);padding:2px 8px;border-radius:6px;white-space:nowrap}
header h1{font-size:14px;margin:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{max-width:860px;margin:0 auto;padding:1.5rem 1.2rem 4rem}
main.with-toc{max-width:1180px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:1.75rem;align-items:start}
html{scroll-behavior:smooth}
.toc{position:sticky;top:4.6rem;max-height:calc(100vh - 6rem);overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:.9rem .8rem}
.toc-title{font-size:11px;letter-spacing:.08em;color:var(--muted);margin:0 0 .45rem;padding-left:.4rem}
.toc ul{list-style:none;margin:0;padding:0}
.toc li{margin:.1rem 0}
.toc a{display:block;padding:.24rem .4rem;border-radius:6px;color:var(--muted);text-decoration:none;font-size:12.5px;line-height:1.45;border-left:2px solid transparent}
.toc a:hover{color:var(--fg);background:var(--accent-soft)}
.toc a.l2{padding-left:1rem}
.toc a.l3{padding-left:1.8rem}
.toc a.l4{padding-left:2.6rem}
@media (max-width:900px){main.with-toc{grid-template-columns:minmax(0,1fr);gap:.9rem}.toc{position:static;max-height:40vh}.demo-note{margin:1rem .9rem 0}}
article.article{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:1.4rem 1.6rem}
article.article>*:first-child{margin-top:0}
h1,h2,h3,h4{line-height:1.35;color:var(--fg);scroll-margin-top:4.5rem}
h1{font-size:1.6rem;margin:1.4rem 0 .7rem;border-bottom:1px solid var(--border);padding-bottom:.4rem}
h2{font-size:1.3rem;margin:1.3rem 0 .6rem}
h3{font-size:1.1rem;margin:1.1rem 0 .5rem}
p{margin:.7rem 0}
a{color:var(--accent)}
code{background:var(--panel-alt);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--panel-alt);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;overflow:auto}
pre code{background:none;border:0;padding:0;font-size:.86rem;white-space:pre}
blockquote{margin:.9rem 0;padding:.3rem 1rem;border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--fg);border-radius:0 8px 8px 0}
ul,ol{margin:.6rem 0;padding-left:1.5rem}
li{margin:.25rem 0}
li input{margin-right:.4rem;accent-color:var(--accent)}
hr{border:0;border-top:1px solid var(--border);margin:1.4rem 0}
table{border-collapse:collapse;width:100%;margin:.9rem 0;font-size:.92em;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:.45rem .7rem;text-align:left}
th{background:var(--panel-alt);color:var(--fg)}
tr:nth-child(even) td{background:var(--panel-alt)}
img{max-width:100%;border-radius:8px}
.msg{margin:1.1rem 0;padding:.9rem 1rem;border-radius:14px}
.msg.user{background:var(--user-bg);border:1px solid var(--user-border)}
.msg.bot{background:var(--panel);border:1px solid var(--border)}
.who{font-size:11px;color:var(--muted);margin-bottom:.35rem}
.md{word-break:break-word}
.md>*:first-child{margin-top:0}
.md>*:last-child{margin-bottom:0}
.empty{color:var(--muted);text-align:center}
.thread{min-width:0}
.fcard{display:flex;align-items:center;gap:.7rem;margin:1rem 0;padding:.7rem .9rem;background:var(--panel);border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--fg)}
a.fcard:hover{border-color:var(--accent-border);background:var(--accent-soft)}
.fcard-icon{font-size:1.15rem;line-height:1}
.fcard-text{display:flex;flex-direction:column;min-width:0}
.fcard-name{font-weight:600;font-size:.92rem;word-break:break-all}
.fcard-meta{color:var(--muted);font-size:12px}
.fcard-action{margin-left:auto;color:var(--accent);font-size:12px;white-space:nowrap}
footer{text-align:center;color:var(--muted);font-size:12px;padding:1.4rem 1rem 2rem}
/* 出口（NERE-46）：页脚一行跳到仓库 Deploy 段；演示页顶部说明这是只读样例 */
.share-cta{margin-top:.5rem}
.share-cta a{color:var(--accent);text-decoration:none;font-weight:600}
.share-cta a:hover{text-decoration:underline}
.demo-note{max-width:1180px;margin:1rem auto 0;padding:.6rem 1rem;background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:10px;font-size:13px;color:var(--fg)}
.demo-note strong{color:var(--accent)}
.expired{max-width:520px;margin:14vh auto;text-align:center;padding:2rem}
.expired h1{font-size:1.3rem;margin:0 0 .6rem;border:0}
.expired p{color:var(--muted)}
.print-btn{margin-left:auto;flex:none;font:inherit;font-size:12px;line-height:1.4;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:6px;padding:3px 10px;cursor:pointer;white-space:nowrap}
.print-btn:hover{background:var(--accent);color:var(--panel);border-color:var(--accent)}
/* 打印 / 存为 PDF（NERE-39）：只在打印时改写版式，屏幕样式保持原样 */
@media print{
@page{margin:14mm 12mm}
:root{color-scheme:light;--bg:#fff;--panel:#fff;--panel-alt:#f5f6f7;--border:#c9cdd4;--fg:#1d2129;--muted:#4e5969;--accent:#165dff;--accent-soft:#f2f6ff;--accent-border:#bed0f7;--user-bg:#f7f8fa;--user-border:#e5e6eb}
html{scroll-behavior:auto}
body{background:#fff;color:var(--fg);font-size:12pt}
header{position:static;display:block;padding:0 0 .6rem;background:transparent}
header .badge{display:none}
header h1{font-size:15pt;overflow:visible;white-space:normal;text-overflow:clip}
.print-btn{display:none}
main,main.with-toc{display:block;max-width:none;margin:0;padding:0}
.toc{position:static;max-height:none;overflow:visible;margin:1rem 0 1.2rem;padding:.6rem .8rem;border-radius:8px;break-inside:avoid;page-break-inside:avoid}
.toc a{color:var(--fg)}
article.article{background:transparent;border:0;border-radius:0;padding:0}
.msg{background:transparent;border:0;border-radius:0;margin:.8rem 0;padding:.2rem 0}
.msg.user{border-left:3px solid var(--border);padding-left:.9rem}
a{color:var(--fg);text-decoration:underline}
h1,h2,h3,h4{break-after:avoid;page-break-after:avoid}
p,blockquote,ul,ol,pre{break-inside:avoid;page-break-inside:avoid}
blockquote{background:transparent;border-left:2px solid var(--border)}
table{display:table;width:100%;overflow:visible;break-inside:avoid;page-break-inside:avoid}
thead{display:table-header-group}
tr,th,td{break-inside:avoid;page-break-inside:avoid}
th{background:#f2f3f5!important;color:var(--fg)!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
tr:nth-child(even) td{background:transparent}
pre{white-space:pre-wrap;word-break:break-word}
img{break-inside:avoid;page-break-inside:avoid}
footer{break-inside:avoid;page-break-inside:avoid;border-top:1px solid var(--border);padding:.8rem 0 0}
/* 出口与演示横条只服务屏幕浏览：打印 / 存 PDF 时不出现（NERE-46） */
.share-cta,.demo-note{display:none}
}
`;
}

/** 从 write_file 的工具结果里取出文件名与字符数（「已写入 x.md（123 字符）。」）。 */
export function writeFileResult(text: string): { name: string; size: number } | null {
	const match = /^已写入 (.+?)（(\d+) 字符）。/.exec(text.trim());
	if (!match) return null;
	const name = match[1].trim();
	return name ? { name, size: Number(match[2]) } : null;
}

/** 工作台文件卡：有文件分享链接时整卡可点，否则只展示文件名与大小。 */
export function shareFileCard(name: string, size: number, href?: string): string {
	const inner =
		`<span class="fcard-icon" aria-hidden="true">📄</span>` +
		`<span class="fcard-text"><span class="fcard-name">${escapeHtml(name)}</span>` +
		`<span class="fcard-meta">${size} 字符</span></span>` +
		(href ? `<span class="fcard-action">打开 →</span>` : "");
	return href
		? `<a class="fcard" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
		: `<div class="fcard">${inner}</div>`;
}

/** 分享页外壳（只读、noindex）。页脚显示署名与生成时间；expiresAt > 0 时再显示有效期。 */
export function sharePage(
	title: string,
	body: string,
	expiresAt = 0,
	theme: ShareThemeId = "dark",
	toc = "",
	meta: { author: string; createdAt: string } = { author: "π Harness", createdAt: new Date().toISOString() },
	demo = false,
): string {
	const until =
		expiresAt > 0
			? ` · 链接有效期至 ${new Date(expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`
			: "";
	const generated = new Date(meta.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · 分享</title>
<style>${shareCss(theme)}</style></head><body>
<header><span class="badge">只读分享</span><h1>${escapeHtml(title)}</h1><button class="print-btn" type="button" onclick="window.print()">打印 / 存为 PDF</button></header>
${demo ? `<div class="demo-note"><strong>这是只读样例</strong>：内容是一份只读快照，看懂了就自己部署一个。</div>` : ""}
<main class="${toc ? "with-toc" : "single"}">${toc}${body}</main>
<footer>由 ${escapeHtml(meta.author)} 分享 · 生成于 ${escapeHtml(generated)} · 只读视图${escapeHtml(until)}<div class="share-cta"><a href="https://github.com/scudong/cloudflare-free-web-pi?utm_source=share#deploy" target="_blank" rel="noopener noreferrer">用同样的方式做一个 →</a></div></footer>
</body></html>`;
}

/** 过期页（410）。 */
export function expiredSharePage(title: string, expiresAt: number, theme: ShareThemeId = "dark"): SharePage {
	const until = new Date(expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
	const body = `<div class="expired"><h1>分享链接已过期</h1><p>「${escapeHtml(title || "分享内容")}」的链接已于 ${escapeHtml(until)} 失效。</p><p>如需继续分享，请回到 pi-harness 重新生成。</p></div>`;
	return {
		status: 410,
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>分享已过期</title><style>${shareCss(theme)}</style></head><body>${body}</body></html>`,
	};
}

/** 工具文案里的有效期描述。 */
export function shareExpiryLabel(expiresAt: number): string {
	return expiresAt > 0
		? `有效期至 ${new Date(expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`
		: "永久有效";
}

/**
 * 登录页演示链接（NERE-13）：只接受站内 /s/<token> 或 https 绝对地址。
 * 配置写错时宁可不显示入口，也不把登录页变成开放跳转。
 */
export function demoShareUrl(raw: unknown): string {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value || value.length > 300) return "";
	if (/^\/s\/[A-Za-z0-9._~-]+$/.test(value)) return value;
	if (/^https:\/\/[^\s"'<>]+$/.test(value)) return value;
	return "";
}

/**
 * 演示分享的 token（NERE-46）：DEMO_SHARE_URL 指向的那条 /s/<token> 在分享页顶部
 * 加「这是只读样例」横条。配置是绝对地址时取 pathname，取不到就不加横幅。
 */
export function demoShareToken(raw: unknown): string {
	const value = demoShareUrl(raw);
	if (!value) return "";
	try {
		const parts = new URL(value, "https://demo.invalid").pathname.split("/");
		return parts.length === 3 && parts[1] === "s" ? decodeURIComponent(parts[2]) : "";
	} catch {
		return "";
	}
}

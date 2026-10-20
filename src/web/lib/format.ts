/** 工作台与设置共用的格式化函数。 */

export function formatSize(size: number): string {
	if (!Number.isFinite(size) || size <= 0) return "—";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 分享链接归一化：只保留路径，域名换成当前页面的 origin。
 * pages.dev 反代到 Worker 时，服务端 request.url 是 workers.dev 地址，
 * 直接使用它拼链接在国内打不开（v0.38.1）。
 */
/**
 * 分享链接归一化：只保留路径，域名换成当前页面的 origin。
 * pages.dev 反代到 Worker 时，服务端 request.url 是 workers.dev 地址，
 * 直接使用它拼链接在国内打不开（v0.38.1）。
 * 传 theme 时追加 ?theme=，让文档打开就是当前配色（v0.44.1）。
 */
export function shareUrlFor(raw: string, origin: string, theme?: string): string {
	try {
		const url = new URL(raw, origin);
		if (theme) url.searchParams.set("theme", theme);
		return `${origin}${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}

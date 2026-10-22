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
 * 分享链接的剩余有效期（NERE-43）：0 = 永久；已过期 → 「已过期」；其余按天 / 小时取整。
 * 只此一份文案实现，组件不得另写 toLocaleString 拼接。
 */
export function formatExpiry(expiresAt: number, now: number = Date.now()): string {
	if (!Number.isFinite(expiresAt) || expiresAt === 0) return "永久";
	const remaining = expiresAt - now;
	if (remaining <= 0) return "已过期";
	const hour = 3_600_000;
	if (remaining < 24 * hour) return `剩余 ${Math.ceil(remaining / hour)} 小时`;
	return `剩余 ${Math.ceil(remaining / (24 * hour))} 天`;
}

/** 最近一次打开时间（NERE-43）：0 = 从未打开；其余复用 formatTime。 */
export function formatOpenedAt(lastOpenedAt: number): string {
	if (!Number.isFinite(lastOpenedAt) || lastOpenedAt <= 0) return "从未打开";
	return formatTime(new Date(lastOpenedAt).toISOString());
}

/**
 * 定时任务的下次执行时间（NERE-65）：0 / 非法值不显示。
 * 列表与 PATCH 返回值共用，避免两处 toLocaleString 文案漂移。
 */
export function formatNextRunAt(next: number | undefined): string | undefined {
	if (typeof next !== "number" || !Number.isFinite(next) || next <= 0) return undefined;
	return new Date(next).toLocaleString("zh-CN", { hour12: false });
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

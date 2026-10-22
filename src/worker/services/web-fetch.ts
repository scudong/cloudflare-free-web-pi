import type { WebFetchResult } from "./kb-service";

/**
 * DeepSeek Fetch API 适配器（ADR-0001 §5 的外部适配器例外）：
 * `web_fetch_page`、`kb_ingest` 与链接导入共用，不截断（调用方决定长度）。
 */
export type WebFetchDeps = {
	apiKey: string | null;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
};

export function createWebFetch({ apiKey, baseUrl = "", fetchImpl = fetch }: WebFetchDeps) {
	const base = baseUrl.trim().replace(/\/+$/, "") || "https://api.deepseek.com";
	return async (url: string): Promise<WebFetchResult> => {
		if (!/^https?:\/\//i.test(url)) return { ok: false, kind: "error", message: "URL 必须以 http(s):// 开头。" };
		if (!apiKey) return { ok: false, kind: "error", message: "未配置 DEEPSEEK_API_KEY，无法抓取网页。" };
		try {
			const resp = await fetchImpl(`${base}/v1/tools/fetch`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ url }),
			});
			const data = (await resp.json().catch(() => null)) as {
				title?: string;
				content?: string;
				error?: { message?: string };
			} | null;
			if (!resp.ok) {
				const msg = data?.error?.message ?? `HTTP ${resp.status}`;
				return { ok: false, kind: "error", message: `抓取失败：${msg}` };
			}
			const title = String(data?.title ?? "").trim();
			const content = String(data?.content ?? "").trim();
			if (!content) return { ok: false, kind: "empty", message: "页面没有可提取的正文。" };
			return { ok: true, title, content };
		} catch (e) {
			return { ok: false, kind: "error", message: "抓取失败：" + String(e).slice(0, 200) };
		}
	};
}

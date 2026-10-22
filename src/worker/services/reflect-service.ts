import * as memoryRepo from "../repo/memory-repo";
import type { SqlHandle } from "../db/migrations";

/**
 * reflect：把一段对话里值得长期记住的事实抽出来入库（对齐本地 pi memory 插件的 reflect）。
 * 用一次低成本模型调用；解析失败就跳过，绝不阻塞主流程。
 *
 * 外部 HTTP 适配器在 Service 层（ADR-0001 §5 允许例外的外部适配器），SQL 走 repo。
 */
export type ReflectDeps = {
	sql: SqlHandle;
	apiKey: string | null;
	/** 可注入的 fetch（测试用）；默认全局 fetch。 */
	fetchImpl?: typeof fetch;
	/** 可注入时钟；默认当前 ISO 时间。 */
	now?: () => string;
};

export async function reflectConversation(
	{ sql, apiKey, fetchImpl = fetch, now = () => new Date().toISOString() }: ReflectDeps,
	conversationId: string,
	transcript: string,
): Promise<number> {
	if (!apiKey || transcript.trim().length < 40) return 0;
	try {
		const resp = await fetchImpl("https://api.deepseek.com/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: "deepseek-flash",
				temperature: 0.1,
				max_tokens: 400,
				messages: [
					{
						role: "system",
						content:
							"你是记忆抽取器。从对话中抽取值得长期记住的事实（用户身份/偏好/项目/约定），忽略寒暄与临时内容。只输出 JSON 数组，每项是一句中文事实，最多 3 条；没有就输出 []。",
					},
					{ role: "user", content: transcript.slice(-6000) },
				],
			}),
		});
		if (!resp.ok) return 0;
		const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
		const raw = data.choices?.[0]?.message?.content ?? "";
		const match = raw.match(/\[[\s\S]*\]/);
		if (!match) return 0;
		const facts = JSON.parse(match[0]) as unknown;
		if (!Array.isArray(facts)) return 0;
		let saved = 0;
		// 去重：规范化（去空白与标点）后，新事实与已有记忆互为子串即视为重复。
		const norm = (t: string) => t.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
		const existing = memoryRepo
			.listRecentContents(sql)
			.map(norm)
			.filter((t) => t.length >= 6);
		for (const fact of facts) {
			const content = String(fact ?? "").trim().slice(0, 300);
			if (!content) continue;
			const n = norm(content);
			if (n.length < 6) continue;
			if (existing.some((e) => e.includes(n) || n.includes(e))) continue;
			memoryRepo.insertFromReflect(sql, content, now());
			existing.push(n);
			saved++;
		}
		if (saved) console.log(`reflect: ${saved} 条入库（会话 ${conversationId}）`);
		return saved;
	} catch (err) {
		console.warn("reflect skipped", err);
		return 0;
	}
}

// Spike: pi-durable harness inside a Cloudflare Durable Object (MemoryStorage round).
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

const ctx = BACKGROUND_CONTEXT;

/** DO 实例的 SQL 门面，open() 时注入（工具在模块级定义，无法用 this）。 */
let sqlFacade: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } } | null = null;
const memTable = (sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } }) => {
	sql.exec(`CREATE TABLE IF NOT EXISTS pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
};

const stripHtml = (html: string) =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 6000);

const spikeExtension = defineExtension({
	name: "spike",
	tools: [
		defineTool({
			name: "now",
			description: "获取当前服务器时间（UTC）",
			parameters: Type.Object({}),
			execute: async () => ({ output: [{ type: "text", text: "服务器当前时间：" + new Date().toISOString() }] }),
		}),
		defineTool({
			name: "remember",
			description: "把一条需要长期记住的事实/偏好保存到记忆库（用户明确说「记住…」时调用）",
			parameters: Type.Object({ content: Type.String({ description: "要记住的事实，一句话" }) }),
			execute: async (args) => {
				const content = String((args as { content?: unknown }).content ?? "").trim();
				if (!content) return { output: [{ type: "text", text: "内容为空，未保存。" }] };
				sqlFacade!.exec("INSERT INTO pi_mem (content, created_at) VALUES (?, ?)", content, new Date().toISOString());
				return { output: [{ type: "text", text: "已保存到记忆库。" }] };
			},
		}),
		defineTool({
			name: "recall",
			description: "按关键词检索记忆库",
			parameters: Type.Object({ query: Type.String({ description: "关键词（空格分隔多个）" }) }),
			execute: async (args) => {
				const q = String((args as { query?: unknown }).query ?? "").trim();
				const rows = sqlFacade!.exec("SELECT content FROM pi_mem ORDER BY id DESC LIMIT 500").toArray() as { content: string }[];
				const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
				const scored = rows
					.map((r) => ({ r, s: terms.reduce((n, t) => n + (r.content.toLowerCase().includes(t) ? 1 : 0), 0) }))
					.filter((x) => x.s > 0)
					.sort((a, b) => b.s - a.s)
					.slice(0, 8);
				const text = scored.length
					? scored.map((x) => "· " + x.r.content).join("\n")
					: rows.length
						? "没有匹配的记忆。最近几条：\n" + rows.slice(0, 5).map((r) => "· " + r.content).join("\n")
						: "记忆库还是空的。";
				return { output: [{ type: "text", text }] };
			},
		}),
		defineTool({
			name: "http_fetch",
			description: "抓取一个网页并返回其正文文本（已去除标签，截断至 6000 字）",
			parameters: Type.Object({ url: Type.String({ description: "完整的 http(s) URL" }) }),
			execute: async (args) => {
				const url = String((args as { url?: unknown }).url ?? "");
				if (!/^https?:\/\//.test(url)) return { output: [{ type: "text", text: "URL 必须以 http(s):// 开头。" }] };
				try {
					const resp = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (pi-harness)" }, redirect: "follow" });
					if (!resp.ok) return { output: [{ type: "text", text: `HTTP ${resp.status}` }] };
					return { output: [{ type: "text", text: stripHtml(await resp.text()) || "(空页面)" }] };
				} catch (e) {
					return { output: [{ type: "text", text: "抓取失败：" + String(e).slice(0, 200) }] };
				}
			},
		}),
	],
});
export class SpikeAgent extends DurableObject {

	private harness: Harness | null = null;

	private async open(): Promise<Harness> {
		if (!this.harness) {
			const models = createModels();
			models.setProvider(deepseekProvider()); // reads DEEPSEEK_API_KEY
			const registry = createRegistry();
			registry.install(spikeExtension);
			// Durable Object SQLite: conversations survive DO restarts and redeploys.
			const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
			memTable(this.ctx.storage.sql);
			sqlFacade = this.ctx.storage.sql;
			this.harness = await Harness.open(storage, { models, registry }, ctx);
			this.harness.resume();
		}
		return this.harness;
	}

	async chat(message: string): Promise<{ answer: string; tools: { name: string; summary: string }[] }> {
		const harness = await this.open();
		const root = await harness.root(ctx, {
			agent: { model: { provider: "deepseek", modelId: "deepseek-flash" }, extensions: [spikeExtension] },
		});
		const submission = await root.submit({ type: "input", content: message }, ctx);
		const settled = await submission.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input") {
			throw new Error(`run failed: ${JSON.stringify(settled).slice(0, 300)}`);
		}
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const c = answer?.model?.[0]?.content;
		const text = typeof c === "string" ? c : Array.isArray(c)
			? c.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("")
			: "";
		const page2 = await root.entries({}, 60, undefined, ctx);
		const tools: { name: string; summary: string }[] = [];
		for (const e of page2.items as unknown as Record<string, unknown>[]) {
			if ((e as { kind?: unknown }).kind !== "pi.tool-result") continue;
			const model = (e as { model?: { toolName?: string; content?: { type: string; text?: string }[] }[] }).model;
			const first = model?.[0];
			const text = (first?.content ?? []).map((b) => b.text ?? "").join("");
			if (first) tools.push({ name: first.toolName ?? "tool", summary: text.slice(0, 80) });
		}
		return { answer: text || "(empty)", tools: tools.slice(-6) };
	}

	async entries(): Promise<unknown> {
		const harness = await this.open();
		const root = await harness.root(ctx);
		const page = await root.entries({}, 200, undefined, ctx);
		return page.items;
	}

	async reset(): Promise<{ ok: true }> {
		if (this.harness) {
			await this.harness.close(ctx);
			this.harness = null;
		}
		const sql = this.ctx.storage.sql;
		const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray() as { name: string }[];
		for (const t of tables) sql.exec(`DELETE FROM ${JSON.stringify(t.name).replace(/"/g, '"')}`);
		memTable(sql);
		return { ok: true };
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/chat") {
				const { message } = (await request.json()) as { message: string };
				return Response.json(await this.chat(message));
			}
			if (request.method === "GET" && url.pathname === "/entries") {
				return Response.json(await this.entries());
			}
			if (request.method === "POST" && url.pathname === "/reset") {
				return Response.json(await this.reset());
			}
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (e) {
			return Response.json({ error: String(e).slice(0, 500) }, { status: 500 });
		}
	}
}

export default {
	fetch(request: Request, env: { SpikeAgent: DurableObjectNamespace }): Response | Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/agent/")) {
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName("spike"));
			const inner = new URL(request.url);
			inner.pathname = url.pathname.replace(/^\/agent/, "") || "/";
			return stub.fetch(new Request(inner, request));
		}
		return Response.json({ ok: true, name: "pi-harness-spike" });
	},
};

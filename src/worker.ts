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
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

const ctx = BACKGROUND_CONTEXT;

/** DO 实例的 SQL 门面，open() 时注入（工具在模块级定义，无法用 this）。 */
let sqlFacade: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } } | null = null;
const ensureTables = (sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } }) => {
	sql.exec(`CREATE TABLE IF NOT EXISTS pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS vfs_files (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
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
		defineTool({
			name: "write_file",
			description: "把内容写入工作台文件（覆盖同名）；适合报告、笔记、代码、数据。文件会出现在右侧工作台面板",
			parameters: Type.Object({
				name: Type.String({ description: "文件名，如 report.md / notes.txt / main.js" }),
				content: Type.String({ description: "完整文件内容" }),
			}),
			execute: async (args) => {
				const a = args as { name?: unknown; content?: unknown };
				const name = String(a.name ?? "").trim().replace(/^[/.]+/, "").slice(0, 120);
				if (!name) return { output: [{ type: "text", text: "文件名不能为空。" }] };
				const content = String(a.content ?? "");
				sqlFacade!.exec("INSERT INTO vfs_files (name, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", name, content, new Date().toISOString());
				return { output: [{ type: "text", text: `已写入 ${name}（${content.length} 字符）。` }] };
			},
		}),
		defineTool({
			name: "read_file",
			description: "读取工作台文件内容",
			parameters: Type.Object({ name: Type.String({ description: "文件名" }) }),
			execute: async (args) => {
				const name = String((args as { name?: unknown }).name ?? "").replace(/^[/.]+/, "");
				const rows = sqlFacade!.exec("SELECT content FROM vfs_files WHERE name = ?", name).toArray() as { content: string }[];
				return { output: [{ type: "text", text: rows[0]?.content ?? `文件 ${name} 不存在。` }] };
			},
		}),
		defineTool({
			name: "list_files",
			description: "列出工作台全部文件",
			parameters: Type.Object({}),
			execute: async () => {
				const rows = sqlFacade!.exec("SELECT name, length(content) AS size, updated_at FROM vfs_files ORDER BY updated_at DESC").toArray() as { name: string; size: number; updated_at: string }[];
				const text = rows.length ? rows.map((r) => `${r.name} · ${r.size} 字符 · ${r.updated_at.slice(0, 16).replace("T", " ")}`).join("\n") : "工作台还没有文件。";
				return { output: [{ type: "text", text }] };
			},
		}),
	],
});
/** Code mode 扩展：单例即可（沙箱无状态，脚本每次执行新建 VM）。 */
const codemodeExtension = createCodemodeExtension({
	sandbox: createInlineCodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }),
	models: false,
});

export class SpikeAgent extends DurableObject {
	/** pi-durable 的存储句柄，用来枚举会话（Harness 本身不提供列表 API）。 */
	private storageRef: { scanConversations(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> } | null = null;

	private harness: Harness | null = null;

	private async open(): Promise<Harness> {
		if (!this.harness) {
			const models = createModels();
			models.setProvider(deepseekProvider()); // reads DEEPSEEK_API_KEY
			const registry = createRegistry();
			registry.install(spikeExtension);
			// Code mode：模型写 JS 调 tools.<name>()，QuickJS WASM 沙箱内执行（workerd 原生支持）。
			registry.install(codemodeExtension);
			// Durable Object SQLite: conversations survive DO restarts and redeploys.
			const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
			ensureTables(this.ctx.storage.sql);
			sqlFacade = this.ctx.storage.sql;
			this.storageRef = storage;
			this.harness = await Harness.open(storage, { models, registry }, ctx);
			this.harness.resume();
		}
		return this.harness;
	}

	async chat(message: string, sessionId?: string): Promise<{ answer: string; tools: { name: string; summary: string }[] }> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		// 会话首次创建后 agent 选择会固化在 pi.agent 文档里；幂等重设，保证新扩展开关对老会话也生效。
		await root.configure(
			{
				extensions: [spikeExtension, codemodeExtension],
				instructions:
					"凡是需要计算、批量处理、解析或转换数据时，必须调用 codemode 工具写 JavaScript 执行（脚本内可用 await tools.<name>(args) 调用其它工具），不要心算或声称没有该工具。",
			},
			ctx,
		);
		// 记录本轮起点：之后只把新增条目里的工具结果算作本轮工具活动。
		const before = await root.entries({}, 1, undefined, ctx);
		const beforeId = (before.items[0] as unknown as { id?: number } | undefined)?.id ?? 0;
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
		// 会话标题：首轮用消息前 24 字，之后只更新时间。
		try {
			const id = String(root.id);
			const now = new Date().toISOString();
			const meta = sqlFacade!.exec("SELECT title FROM sessions_meta WHERE id = ?", id).toArray() as { title: string }[];
			const title = meta[0]?.title;
			if (!title || title === "新会话" || /^会话 \d+$/.test(title)) {
				sqlFacade!.exec(
					"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
					id, message.slice(0, 24), now, now,
				);
			} else {
				sqlFacade!.exec("UPDATE sessions_meta SET updated_at = ? WHERE id = ?", now, id);
			}
		} catch (e) {
			console.warn("session meta update failed", e);
		}
		const page2 = await root.entries({}, 60, undefined, ctx);
		const tools: { name: string; summary: string }[] = [];
		for (const e of page2.items as unknown as Record<string, unknown>[]) {
			if ((e as { kind?: unknown }).kind !== "pi.tool-result") continue;
			if (Number((e as { id?: unknown }).id ?? 0) <= beforeId) continue;
			const model = (e as { model?: { toolName?: string; content?: { type: string; text?: string }[] }[] }).model;
			const first = model?.[0];
			const text = (first?.content ?? []).map((b) => b.text ?? "").join("");
			if (first) tools.push({ name: first.toolName ?? "tool", summary: text.slice(0, 80) });
		}
		return { answer: text || "(empty)", tools: tools.slice(-6) };
	}

	async entries(sessionId?: string): Promise<unknown> {
		const harness = await this.open();
		const conversation = await this.conversationFor(harness, sessionId);
		const page = await conversation.entries({}, 200, undefined, ctx);
		return page.items;
	}

	/** 取会话：有 id 用 id（不存在则退根会话），无 id 用根会话；并维护 sessions_meta。 */
	private async conversationFor(harness: Awaited<ReturnType<typeof this.open>>, sessionId?: string) {
		const agentChange = {
			model: { provider: "deepseek", modelId: "deepseek-flash" },
			extensions: [spikeExtension, codemodeExtension],
		};
		if (sessionId) {
			const numeric = Number(sessionId);
			if (Number.isFinite(numeric) && numeric > 0) {
				const existing = await harness.conversation(numeric as never, ctx);
				if (existing) return existing;
			}
		}
		return harness.root(ctx, { agent: agentChange });
	}

	/** 新建会话，返回 id。 */
	async newSession(): Promise<{ id: string; title: string }> {
		const harness = await this.open();
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "deepseek", modelId: "deepseek-flash" }, extensions: [spikeExtension, codemodeExtension] },
			},
			ctx,
		);
		const now = new Date().toISOString();
		sqlFacade!.exec(
			"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
			String(conversation.id), "新会话", now, now,
		);
		return { id: String(conversation.id), title: "新会话" };
	}

	/** 会话列表：元数据表为准，缺失的从存储枚举补齐（含根会话）。 */
	async listSessions(): Promise<{ sessions: { id: string; title: string; created_at: string; updated_at: string }[] }> {
		ensureTables(sqlFacade!);
		const harness = await this.open();
		const root = await harness.root(ctx);
		const rows = sqlFacade!.exec("SELECT id, title, created_at, updated_at FROM sessions_meta ORDER BY updated_at DESC").toArray() as {
			id: string; title: string; created_at: string; updated_at: string;
		}[];
		const known = new Set(rows.map((r) => r.id));
		// 存储里存在但元数据缺失的会话（例如根会话）补一条。
		const scan = (await this.storageRef!.scanConversations({}, 100, undefined, ctx)) as { items: readonly { id: unknown }[] };
		const now = new Date().toISOString();
		for (const c of scan.items) {
			const id = String(c.id);
			if (known.has(id)) continue;
			sqlFacade!.exec(
				"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
				id, id === String(root.id) ? "默认会话" : `会话 ${id}`, now, now,
			);
			rows.push({ id, title: id === String(root.id) ? "默认会话" : `会话 ${id}`, created_at: now, updated_at: now });
		}
		return { sessions: rows };
	}

	/** 重置一个会话的转录（工作台文件与记忆库保留）。 */
	async reset(sessionId?: string): Promise<{ ok: true }> {
		const harness = await this.open();
		const conversation = await this.conversationFor(harness, sessionId);
		await conversation.reset(undefined, ctx);
		if (sessionId) {
			sqlFacade!.exec("UPDATE sessions_meta SET title = ?, updated_at = ? WHERE id = ?", "新会话", new Date().toISOString(), sessionId);
		}
		return { ok: true };
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			// 所有路由都先确保 DO 初始化（sqlFacade/表/Harness 就绪），幂等。
			if (url.pathname !== "/") await this.open();
			if (request.method === "POST" && url.pathname === "/chat") {
				const { message, sessionId } = (await request.json()) as { message: string; sessionId?: string };
				return Response.json(await this.chat(message, sessionId));
			}
			if (request.method === "GET" && url.pathname === "/debug/agent") {
				const harness = await this.open();
				const root = await harness.root(ctx);
				const agent = await root.agent(ctx);
				const a = agent as unknown as {
					tools?: readonly { name?: string }[];
					callable?: readonly { name?: string }[];
					deferred?: readonly { name?: string }[];
					extensions?: readonly { name?: string }[];
					sections?: readonly { key?: string }[];
				};
				const names = (x?: readonly { name?: string }[]) => (x ?? []).map((t) => t.name);
				return Response.json({
					tools: names(a.tools),
					callable: names(a.callable),
					deferred: names(a.deferred),
					extensions: names(a.extensions),
					sections: (a.sections ?? []).map((x) => x.key),
				});
			}
			if (request.method === "GET" && url.pathname === "/sessions") {
				return Response.json(await this.listSessions());
			}
			if (request.method === "POST" && url.pathname === "/sessions") {
				return Response.json(await this.newSession());
			}
			if (url.pathname === "/files" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!.exec("SELECT name, length(content) AS size, updated_at FROM vfs_files ORDER BY updated_at DESC").toArray();
				return Response.json({ files: rows });
			}
			if (url.pathname === "/files/content" && request.method === "GET") {
				const name = url.searchParams.get("name") ?? "";
				const rows = sqlFacade!.exec("SELECT name, content FROM vfs_files WHERE name = ?", name).toArray() as { name: string; content: string }[];
				if (!rows[0]) return Response.json({ error: "文件不存在" }, { status: 404 });
				return Response.json(rows[0]);
			}
			if (url.pathname === "/files" && request.method === "DELETE") {
				sqlFacade!.exec("DELETE FROM vfs_files WHERE name = ?", url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			if (url.pathname === "/memories" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!.exec("SELECT id, content, created_at FROM pi_mem ORDER BY id DESC LIMIT 200").toArray();
				return Response.json({ memories: rows });
			}
			if (url.pathname === "/memories" && request.method === "DELETE") {
				sqlFacade!.exec("DELETE FROM pi_mem WHERE id = ?", Number(url.searchParams.get("id") ?? 0));
				return Response.json({ ok: true });
			}
			if (request.method === "GET" && url.pathname === "/session") {
				return Response.json({ ok: true, name: "pi-harness-spike" });
			}
			if (request.method === "GET" && url.pathname === "/entries") {
				return Response.json(await this.entries(url.searchParams.get("sessionId") ?? undefined));
			}
			if (request.method === "POST" && url.pathname === "/reset") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
				return Response.json(await this.reset(body.sessionId));
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
		if (url.pathname.startsWith("/agent/") || url.pathname.startsWith("/api/")) {
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName("spike"));
			const inner = new URL(request.url);
			inner.pathname = url.pathname.replace(/^\/(agent|api)/, "") || "/";
			return stub.fetch(new Request(inner, request));
		}
		return Response.json({ ok: true, name: "pi-harness-spike" });
	},
};

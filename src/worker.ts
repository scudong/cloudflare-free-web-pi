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
import { watchEvents } from "@earendil-works/pi-durable";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

const ctx = BACKGROUND_CONTEXT;

/** DO 实例的 SQL 门面，open() 时注入（工具在模块级定义，无法用 this）。 */
let sqlFacade: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } } | null = null;
const ensureTables = (sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } }) => {
	sql.exec(`CREATE TABLE IF NOT EXISTS pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS vfs_v2 (conversation_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, name))`);
	// 旧版全局文件表 → 迁到 v2 的根会话（'1'），然后丢弃旧表。
	try {
		const legacy = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='vfs_files'").toArray() as { name: string }[];
		if (legacy.length) {
			sql.exec(`INSERT OR IGNORE INTO vfs_v2 (conversation_id, name, content, updated_at) SELECT '1', name, content, updated_at FROM vfs_files`);
			sql.exec(`DROP TABLE vfs_files`);
		}
	} catch (err) {
		console.warn("vfs migration skipped", err);
	}
	try {
		sql.exec(`ALTER TABLE sessions_meta ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
	} catch {
		// 列已存在
	}
	sql.exec(`CREATE TABLE IF NOT EXISTS sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS reflect_state (conversation_id TEXT PRIMARY KEY, last_entry_id INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
	// pi_mem.source: manual（用户/工具显式保存）或 reflect（会话末自动抽取）。老库补列。
	try {
		sql.exec(`ALTER TABLE pi_mem ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
	} catch {
		// 列已存在
	}
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
			execute: async (args, api) => {
				const a = args as { name?: unknown; content?: unknown };
				const name = String(a.name ?? "").trim().replace(/^[/.]+/, "").slice(0, 120);
				if (!name) return { output: [{ type: "text", text: "文件名不能为空。" }] };
				const content = String(a.content ?? "");
				sqlFacade!.exec("INSERT INTO vfs_v2 (conversation_id, name, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", String(api.conversationId), name, content, new Date().toISOString());
				return { output: [{ type: "text", text: `已写入 ${name}（${content.length} 字符）。` }] };
			},
		}),
		defineTool({
			name: "read_file",
			description: "读取工作台文件内容",
			parameters: Type.Object({ name: Type.String({ description: "文件名" }) }),
			execute: async (args, api) => {
				const name = String((args as { name?: unknown }).name ?? "").replace(/^[/.]+/, "");
				const rows = sqlFacade!.exec("SELECT content FROM vfs_v2 WHERE conversation_id = ? AND name = ?", String(api.conversationId), name).toArray() as { content: string }[];
				return { output: [{ type: "text", text: rows[0]?.content ?? `文件 ${name} 不存在。` }] };
			},
		}),
		defineTool({
			name: "list_files",
			description: "列出工作台全部文件",
			parameters: Type.Object({}),
			execute: async (_args, api) => {
				const rows = sqlFacade!.exec("SELECT name, length(content) AS size, updated_at FROM vfs_v2 WHERE conversation_id = ? ORDER BY updated_at DESC", String(api.conversationId)).toArray() as { name: string; size: number; updated_at: string }[];
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

/** 已连接的 MCP 客户端缓存：同一 DO 实例内复用，配置变更时清空。 */
const mcpCache = new Map<string, { client: McpClient; tools: { name: string; description?: string; inputSchema?: unknown }[] }>();

/** 读取配置的 MCP 服务器，连接并包装成 pi-durable 工具（惰性、失败静默）。 */
async function buildMcpExtension(sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } }) {
	const servers = sql.exec("SELECT id, name, url, headers FROM mcp_servers ORDER BY created_at ASC").toArray() as {
		id: string;
		name: string;
		url: string;
		headers: string;
	}[];
	if (!servers.length) return null;
	const tools = [];
	for (const server of servers) {
		try {
			let entry = mcpCache.get(server.id);
			if (!entry) {
				const client = new McpClient({ name: "pi-harness", version: "1.0.0" });
				const headers = JSON.parse(server.headers || "{}") as Record<string, string>;
				await client.connect(new StreamableHttpTransport({ url: server.url, headers }));
				const listed = await client.listTools();
				entry = { client, tools: listed as never };
				mcpCache.set(server.id, entry);
			}
			for (const tool of entry.tools) {
				const jsName = `mcp__${server.id}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
				tools.push(
					defineTool({
						name: jsName,
						description: `[${server.name}] ${tool.description ?? tool.name}`.slice(0, 400),
						parameters: Type.Unsafe((tool.inputSchema as object) ?? { type: "object", properties: {} }),
						execute: async (args: unknown) => {
							const res = await entry!.client.callTool(tool.name, (args ?? {}) as Record<string, unknown>);
							const content = toLlmContent(res as never) as { type: string; text?: string }[];
							const text = content.map((c) => c.text ?? "").join("\n").slice(0, 8000);
							return { output: [{ type: "text", text: text || "(空结果)" }] };
						},
					}),
				);
			}
		} catch (err) {
			console.warn(`MCP server ${server.name} unavailable`, String(err));
		}
	}
	// 每个会话每次只用一个扩展名，内部工具数量随配置变化。
	return defineExtension({ name: "mcp", tools });
}

export class SpikeAgent extends DurableObject {
	/** pi-durable 的存储句柄，用来枚举会话（Harness 本身不提供列表 API）。 */
	/** MCP 扩展：构建一次后常驻，避免每轮重连造成工具列表抖动。 */
	private mcpExt: { name: string; tools?: unknown[] } | null = null;
	/** 注册表引用：MCP 扩展在运行时安装（install 按名替换）。 */
	private registryRef: { install(ext: unknown): void; snapshot(): { installed(): readonly { name: string }[] } } | null = null;
	private storageRef: { scanConversations(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> } | null = null;

	private harness: Harness | null = null;

	private async open(): Promise<Harness> {
		if (!this.harness) {
			const models = createModels();
			models.setProvider(deepseekProvider()); // reads DEEPSEEK_API_KEY
			const registry = createRegistry();
			this.registryRef = registry as unknown as typeof this.registryRef;
			registry.install(spikeExtension);
			// Code mode：模型写 JS 调 tools.<name>()，QuickJS WASM 沙箱内执行（workerd 原生支持）。
			registry.install(codemodeExtension);
			// Durable Object SQLite: conversations survive DO restarts and redeploys.
			const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
			ensureTables(this.ctx.storage.sql);
			sqlFacade = this.ctx.storage.sql;
			this.storageRef = storage;
			// MCP 扩展在表就绪后构建并安装；之后由 /api/mcp 变更时重建。
			this.mcpExt = (await buildMcpExtension(sqlFacade)) as never;
				if (this.mcpExt) registry.install(this.mcpExt);
			this.harness = await Harness.open(storage, { models, registry }, ctx);
			this.harness.resume();
		}
		return this.harness;
	}

	async chat(message: string, sessionId?: string): Promise<{ answer: string; tools: { name: string; summary: string }[] }> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		// 会话首次创建后 agent 选择会固化在 pi.agent 文档里；幂等重设，保证新扩展开关对老会话也生效。
		const mcpExt = this.mcpExt as { name: string; tools?: unknown[] } | null;
		await root.configure(
			{
				extensions: mcpExt && (mcpExt.tools?.length ?? 0) > 0 ? [spikeExtension, codemodeExtension, mcpExt as never] : [spikeExtension, codemodeExtension],
				instructions:
					"凡是需要计算、批量处理、解析或转换数据时，必须调用 codemode 工具写 JavaScript 执行（脚本内可用 await tools.<name>(args) 调用其它工具），不要心算或声称没有该工具。",
			},
			ctx,
		);
		const dbgAgent = await root.agent(ctx);
		console.log("CHAT_TOOLS", JSON.stringify(dbgAgent.tools.map((t) => (t as { name?: string }).name)));
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
		const lastId = Number((page2.items[0] as unknown as { id?: number } | undefined)?.id ?? 0);
		this.ctx.waitUntil(this.maybeReflect(root as never, lastId));
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
		const rows = sqlFacade!.exec("SELECT id, title, created_at, updated_at FROM sessions_meta WHERE deleted = 0 ORDER BY updated_at DESC").toArray() as {
			id: string; title: string; created_at: string; updated_at: string;
		}[];
		const known = new Set(rows.map((r) => r.id));
		// 存储里存在但元数据缺失的会话（例如根会话）补一条。
		const scan = (await this.storageRef!.scanConversations({}, 100, undefined, ctx)) as { items: readonly { id: unknown }[] };
		const now = new Date().toISOString();
		for (const c of scan.items) {
			const id = String(c.id);
			if (known.has(id)) continue;
			// 已删除的会话不重新出现（元数据表里仍留一行 deleted=1）。
			const tomb = sqlFacade!.exec("SELECT id FROM sessions_meta WHERE id = ?", id).toArray();
			if (tomb.length) continue;
			sqlFacade!.exec(
				"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
				id, id === String(root.id) ? "默认会话" : `会话 ${id}`, now, now,
			);
			rows.push({ id, title: id === String(root.id) ? "默认会话" : `会话 ${id}`, created_at: now, updated_at: now });
		}
		return { sessions: rows };
	}

	/** 重置一个会话的转录（工作台文件与记忆库保留）。 */
	/**
	 * reflect：把一段对话里值得长期记住的事实抽出来入库（对齐本地 pi memory 插件的 reflect）。
	 * 用一次低成本模型调用；解析失败就跳过，绝不阻塞主流程。
	 */
	private async reflect(conversationId: string, transcript: string): Promise<number> {
		const apiKey = (this.env as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY;
		if (!apiKey || transcript.trim().length < 40) return 0;
		try {
			const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
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
			const existing = (sqlFacade!.exec("SELECT content FROM pi_mem ORDER BY id DESC LIMIT 300").toArray() as { content: string }[])
				.map((r) => norm(r.content))
				.filter((t) => t.length >= 6);
			for (const fact of facts) {
				const content = String(fact ?? "").trim().slice(0, 300);
				if (!content) continue;
				const n = norm(content);
				if (n.length < 6) continue;
				if (existing.some((e) => e.includes(n) || n.includes(e))) continue;
				sqlFacade!.exec(
					"INSERT INTO pi_mem (content, created_at, source) VALUES (?, ?, 'reflect')",
					content, new Date().toISOString(),
				);
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

	/** 达到阈值才跑 reflect：默认每 6 个新条目一次，避免每轮都花 token。 */
	private async maybeReflect(root: { id: unknown; entries(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> }, uptoId: number): Promise<number> {
		try {
			const convId = String(root.id);
			const state = sqlFacade!.exec("SELECT last_entry_id FROM reflect_state WHERE conversation_id = ?", convId).toArray() as { last_entry_id: number }[];
			const since = state[0]?.last_entry_id ?? 0;
			if (uptoId - since < 6) return 0;
			const page = (await root.entries({ order: "descending" }, 40, undefined, ctx)) as { items: readonly Record<string, unknown>[] };
			const lines: string[] = [];
			for (const e of [...page.items].reverse()) {
				const kind = String(e.kind ?? "");
				const text = JSON.stringify(e.model ?? e.data ?? "").slice(0, 800);
				if (kind === "pi.user") lines.push(`用户：${text}`);
				else if (kind === "pi.assistant") lines.push(`助手：${text}`);
			}
			const saved = await this.reflect(convId, lines.join("\n"));
			sqlFacade!.exec(
				"INSERT INTO reflect_state (conversation_id, last_entry_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET last_entry_id = excluded.last_entry_id, updated_at = excluded.updated_at",
				convId, uptoId, new Date().toISOString(),
			);
			return saved;
		} catch (err) {
			console.warn("maybeReflect skipped", err);
			return 0;
		}
	}

	/** 流式聊天：SSE 推送 text delta / 工具开始结束 / 最终 done。 */
	async chatStream(message: string, sessionId?: string): Promise<Response> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		const mcpExt = this.mcpExt as { name: string; tools?: unknown[] } | null;
		await root.configure(
			{
				extensions: mcpExt && (mcpExt.tools?.length ?? 0) > 0 ? [spikeExtension, codemodeExtension, mcpExt as never] : [spikeExtension, codemodeExtension],
				instructions:
					"凡是需要计算、批量处理、解析或转换数据时，必须调用 codemode 工具写 JavaScript 执行（脚本内可用 await tools.<name>(args) 调用其它工具），不要心算或声称没有该工具。",
			},
			ctx,
		);
		const before = await root.entries({}, 1, undefined, ctx);
		const beforeId = (before.items[0] as unknown as { id?: number } | undefined)?.id ?? 0;

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		let closed = false;
		const send = async (event: string, data: unknown) => {
			if (closed) return;
			try {
				await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			} catch {
				closed = true;
			}
		};

		const pump = (async () => {
			const stream = await watchEvents(harness, root.id, ctx);
			stream.start(async (events) => {
				for (const e of events) {
					if (e.type === "message_update") {
						for (const change of e.changes) {
							if (change.type === "text_delta" && change.delta) await send("text", { delta: change.delta });
						}
					} else if (e.type === "tool_execution_start") {
						const call = e as unknown as { toolName?: string; args?: unknown };
						await send("tool_start", { name: call.toolName ?? "tool" });
					} else if (e.type === "tool_execution_end") {
						const call = e as unknown as { toolName?: string };
						await send("tool_end", { name: call.toolName ?? "tool" });
					}
				}
			});
			try {
				const submission = await root.submit({ type: "input", content: message }, ctx);
				const settled = await submission.wait(ctx);
				const page2 = await root.entries({}, 60, undefined, ctx);
				const lastId = Number((page2.items[0] as unknown as { id?: number } | undefined)?.id ?? 0);
				const tools: { name: string; summary: string }[] = [];
				for (const e of page2.items as unknown as Record<string, unknown>[]) {
					if ((e as { kind?: unknown }).kind !== "pi.tool-result") continue;
					if (Number((e as { id?: unknown }).id ?? 0) <= beforeId) continue;
					const model = (e as { model?: { toolName?: string; content?: { type: string; text?: string }[] }[] }).model;
					const first = model?.[0];
					const text = (first?.content ?? []).map((b) => b.text ?? "").join("");
					if (first) tools.push({ name: first.toolName ?? "tool", summary: text.slice(0, 80) });
				}
				let answer = "";
				if (settled.status === "done" && settled.type === "input") {
					const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
					const c = entry?.model?.[0]?.content;
					answer =
						typeof c === "string"
							? c
							: Array.isArray(c)
								? c.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("")
								: "";
				} else {
					await send("error", { message: `运行未完成：${JSON.stringify(settled).slice(0, 200)}` });
				}
				// 标题/时间维护
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
				} catch (err) {
					console.warn("session meta update failed", err);
				}
				await send("done", { answer, tools });
				this.ctx.waitUntil(this.maybeReflect(root as never, lastId));
			} catch (err) {
				await send("error", { message: String(err).slice(0, 300) });
			} finally {
				await stream.stop().catch(() => {});
				closed = true;
				await writer.close().catch(() => {});
			}
		})();
		this.ctx.waitUntil(pump);

		return new Response(readable, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	}

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
			if (request.method === "POST" && url.pathname === "/chat/stream") {
				const { message, sessionId } = (await request.json()) as { message: string; sessionId?: string };
				return await this.chatStream(message, sessionId);
			}
			if (request.method === "POST" && url.pathname === "/chat") {
				const { message, sessionId } = (await request.json()) as { message: string; sessionId?: string };
				return Response.json(await this.chat(message, sessionId));
			}
			if (request.method === "GET" && url.pathname === "/debug/agent") {
				const harness = await this.open();
				const root = await harness.root(ctx);
				const mcpExtDbg = await buildMcpExtension(sqlFacade!);
				if (mcpExtDbg && this.registryRef) this.registryRef.install(mcpExtDbg);
				await root.configure({ extensions: mcpExtDbg ? [spikeExtension, codemodeExtension, mcpExtDbg] : [spikeExtension, codemodeExtension] }, ctx);
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
					mcpToolCount: mcpExtDbg ? (mcpExtDbg.tools?.length ?? 0) : 0,
					installed: this.registryRef?.snapshot().installed().map((e) => e.name) ?? null,
				});
			}
			if (request.method === "GET" && url.pathname === "/sessions") {
				return Response.json(await this.listSessions());
			}
			if (request.method === "POST" && url.pathname === "/sessions") {
				return Response.json(await this.newSession());
			}
			if (request.method === "PATCH" && url.pathname === "/sessions") {
				const { id, title } = (await request.json()) as { id?: string; title?: string };
				if (!id || !title?.trim()) return Response.json({ error: "缺少 id 或标题" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec("UPDATE sessions_meta SET title = ?, updated_at = ? WHERE id = ?", title.trim().slice(0, 60), new Date().toISOString(), id);
				return Response.json({ ok: true });
			}
			if (request.method === "DELETE" && url.pathname === "/sessions") {
				const id = url.searchParams.get("id") ?? "";
				if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec("UPDATE sessions_meta SET deleted = 1, updated_at = ? WHERE id = ?", new Date().toISOString(), id);
				sqlFacade!.exec("DELETE FROM vfs_v2 WHERE conversation_id = ?", id);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/files" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const sid = url.searchParams.get("sessionId") ?? "1";
				const rows = sqlFacade!.exec("SELECT name, length(content) AS size, updated_at FROM vfs_v2 WHERE conversation_id = ? ORDER BY updated_at DESC", sid).toArray();
				return Response.json({ files: rows });
			}
			if (url.pathname === "/files/content" && request.method === "GET") {
				const name = url.searchParams.get("name") ?? "";
				const sid = url.searchParams.get("sessionId") ?? "1";
				const rows = sqlFacade!.exec("SELECT name, content FROM vfs_v2 WHERE conversation_id = ? AND name = ?", sid, name).toArray() as { name: string; content: string }[];
				if (!rows[0]) return Response.json({ error: "文件不存在" }, { status: 404 });
				return Response.json(rows[0]);
			}
			if (url.pathname === "/files" && request.method === "DELETE") {
				const sid = url.searchParams.get("sessionId") ?? "1";
				sqlFacade!.exec("DELETE FROM vfs_v2 WHERE conversation_id = ? AND name = ?", sid, url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			if (url.pathname === "/mcp" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!.exec("SELECT id, name, url, created_at FROM mcp_servers ORDER BY created_at ASC").toArray();
				return Response.json({ servers: rows });
			}
			if (url.pathname === "/mcp" && request.method === "POST") {
				const body = (await request.json()) as { name?: string; url?: string; headers?: Record<string, string> };
				const name = (body.name ?? "").trim();
				const serverUrl = (body.url ?? "").trim();
				if (!name || !/^https?:\/\//.test(serverUrl)) {
					return Response.json({ error: "需要名称与 http(s) 服务器地址" }, { status: 400 });
				}
				ensureTables(sqlFacade!);
				const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `s${Date.now()}`;
				sqlFacade!.exec(
					"INSERT INTO mcp_servers (id, name, url, headers, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, headers = excluded.headers",
					id, name, serverUrl, JSON.stringify(body.headers ?? {}), new Date().toISOString(),
				);
				mcpCache.clear();
				const rebuilt = await buildMcpExtension(sqlFacade!);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
				return Response.json({ ok: true, id, tools: rebuilt?.tools?.length ?? 0 });
			}
			if (url.pathname === "/mcp" && request.method === "DELETE") {
				sqlFacade!.exec("DELETE FROM mcp_servers WHERE id = ?", url.searchParams.get("id") ?? "");
				mcpCache.clear();
				const rebuilt = await buildMcpExtension(sqlFacade!);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
				return Response.json({ ok: true, tools: rebuilt?.tools?.length ?? 0 });
			}
			if (url.pathname === "/reflect" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, body.sessionId);
				const page = (await conversation.entries({}, 1, undefined, ctx)) as { items: readonly { id?: number }[] };
				const saved = await this.maybeReflect(conversation as never, Number(page.items[0]?.id ?? 0));
				return Response.json({ ok: true, saved });
			}
			if (url.pathname === "/memories" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!.exec("SELECT id, content, created_at, source FROM pi_mem ORDER BY id DESC LIMIT 200").toArray();
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

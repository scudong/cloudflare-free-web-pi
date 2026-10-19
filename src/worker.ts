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
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
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
	try {
		sql.exec(`ALTER TABLE sessions_meta ADD COLUMN model TEXT NOT NULL DEFAULT 'deepseek-flash'`);
	} catch {
		// 列已存在
	}
	sql.exec(`CREATE TABLE IF NOT EXISTS sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)`);
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
/** 把 data URL 解析成 pi-ai 的图片块；不合法的丢弃。 */
function toImageBlocks(images: string[] | undefined): { type: "image"; data: string; mimeType: string }[] {
	if (!images?.length) return [];
	const blocks: { type: "image"; data: string; mimeType: string }[] = [];
	for (const url of images.slice(0, 4)) {
		const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(url);
		if (!match) continue;
		blocks.push({ type: "image", data: match[2]!, mimeType: match[1]! });
	}
	return blocks;
}

/** 用户输入：有图片时用内容块数组，否则纯文本。 */
function userContent(message: string, images: string[] | undefined): string | { type: string; [key: string]: unknown }[] {
	const blocks = toImageBlocks(images);
	if (!blocks.length) return message;
	return [{ type: "text", text: message || "（图片）" }, ...blocks];
}

/** 工具搜索扩展：模型先搜再加载被延迟的工具（v0.13.0）。 */
const toolSearchExtension = createToolSearchExtension();
/** MCP 工具总数达到该阈值时改为延迟披露，避免工具列表撑爆上下文。 */
const DEFER_MCP_THRESHOLD = 6;

/** 可选模型（pi-ai deepseek provider 的目录）。 */
const AVAILABLE_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const DEFAULT_MODEL_ID = "deepseek-flash";

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

	// 第一遍：连接所有服务器并拿到工具清单（已缓存的直接复用）。
	const connected: { server: { id: string; name: string }; entry: { client: McpClient; tools: { name: string; description?: string; inputSchema?: unknown }[] } }[] = [];
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
			connected.push({ server, entry });
		} catch (err) {
			console.warn(`MCP server ${server.name} unavailable`, String(err));
		}
	}
	const total = connected.reduce((n, item) => n + item.entry.tools.length, 0);
	// 工具多时改为延迟披露：模型先用 tool_search 搜索，再按需加载。
	const defer = total >= DEFER_MCP_THRESHOLD;

	const tools = [];
	for (const { server, entry } of connected) {
		for (const tool of entry.tools) {
			const jsName = `mcp__${server.id}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
			tools.push(
				defineTool({
					name: jsName,
					...(defer ? { deferred: true as const } : {}),
					description: `[${server.name}] ${tool.description ?? tool.name}`.slice(0, 400),
					parameters: Type.Unsafe((tool.inputSchema as object) ?? { type: "object", properties: {} }),
					execute: async (args: unknown) => {
						const res = await entry.client.callTool(tool.name, (args ?? {}) as Record<string, unknown>);
						const content = toLlmContent(res as never) as { type: string; text?: string }[];
						const text = content.map((c) => c.text ?? "").join("\n").slice(0, 8000);
						return { output: [{ type: "text", text: text || "(空结果)" }] };
					},
				}),
			);
		}
	}
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
			registry.install(toolSearchExtension);
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

	async chat(
		message: string,
		sessionId?: string,
		images?: string[],
	): Promise<{ answer: string; tools: { name: string; summary: string }[] }> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		// 会话首次创建后 agent 选择会固化在 pi.agent 文档里；幂等重设，保证新扩展开关对老会话也生效。
		const mcpExt = this.mcpExt as { name: string; tools?: unknown[] } | null;
		await root.configure(
			{
				model: { provider: "deepseek", modelId: this.modelFor(sessionId) },
				extensions: mcpExt && (mcpExt.tools?.length ?? 0) > 0
					? [spikeExtension, codemodeExtension, toolSearchExtension, mcpExt as never]
					: [spikeExtension, codemodeExtension, toolSearchExtension],
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
		const submission = await root.submit({ type: "input", content: userContent(message, images) as never }, ctx);
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
	/** 会话当前模型（未设置时用默认）。 */
	private modelFor(sessionId?: string): string {
		if (!sessionId) return DEFAULT_MODEL_ID;
		try {
			const row = sqlFacade!.exec("SELECT model FROM sessions_meta WHERE id = ?", sessionId).toArray() as { model?: string }[];
			const model = row[0]?.model;
			return model && AVAILABLE_MODELS.includes(model) ? model : DEFAULT_MODEL_ID;
		} catch {
			return DEFAULT_MODEL_ID;
		}
	}

	private async conversationFor(harness: Awaited<ReturnType<typeof this.open>>, sessionId?: string) {
		const agentChange = {
			model: { provider: "deepseek", modelId: this.modelFor(sessionId) },
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
				agent: { model: { provider: "deepseek", modelId: DEFAULT_MODEL_ID }, extensions: [spikeExtension, codemodeExtension] },
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
		const rows = sqlFacade!.exec("SELECT id, title, created_at, updated_at, model FROM sessions_meta WHERE deleted = 0 ORDER BY updated_at DESC").toArray() as {
			id: string; title: string; created_at: string; updated_at: string; model?: string;
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

	/** 下一次闹钟时间：所有启用的定时任务里最早的一个。 */
	private async scheduleNextAlarm(): Promise<void> {
		try {
			const rows = sqlFacade!.exec("SELECT MIN(next_run_at) AS next FROM automations WHERE enabled = 1").toArray() as { next: number | null }[];
			const next = rows[0]?.next;
			if (typeof next === "number" && Number.isFinite(next)) {
				const at = Math.max(Date.now() + 5_000, next);
				await this.ctx.storage.setAlarm(at);
			} else {
				await this.ctx.storage.deleteAlarm();
			}
		} catch (err) {
			console.warn("scheduleNextAlarm failed", err);
		}
	}

	/** 计算下一次执行时间（毫秒）。 */
	private nextRunAt(schedule: { kind: string; time?: string; minutes?: number }, now = Date.now()): number {
		if (schedule.kind === "interval") {
			const minutes = Math.max(1, Math.floor(Number(schedule.minutes ?? 60)));
			return now + minutes * 60_000;
		}
		// daily：按 UTC+8 的 HH:MM 计算下一次
		const [hh, mm] = String(schedule.time ?? "09:00").split(":").map((v) => Number(v) || 0);
		const offsetMs = 8 * 3600_000;
		const local = new Date(now + offsetMs);
		const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm, 0));
		let at = target.getTime() - offsetMs;
		if (at <= now) at += 24 * 3600_000;
		return at;
	}

	/** DO alarm：执行到点的定时任务。 */
	async alarm(): Promise<void> {
		try {
			await this.open();
			const now = Date.now();
			const due = sqlFacade!.exec(
				"SELECT id, prompt, session_id, schedule FROM automations WHERE enabled = 1 AND next_run_at <= ?",
				now,
			).toArray() as { id: string; prompt: string; session_id: string; schedule: string }[];
			for (const job of due) {
				try {
					await this.chat(job.prompt, job.session_id || undefined);
				} catch (err) {
					console.warn(`automation ${job.id} failed`, err);
				}
				let schedule: { kind: string; time?: string; minutes?: number } = { kind: "daily", time: "09:00" };
				try {
					schedule = JSON.parse(job.schedule) as typeof schedule;
				} catch {
					// 保持默认
				}
				sqlFacade!.exec(
					"UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?",
					now, this.nextRunAt(schedule, Date.now()), job.id,
				);
			}
			if (due.length) sqlFacade!.exec("UPDATE automations SET next_run_at = ? WHERE enabled = 1 AND next_run_at <= ?", now + 60_000, now);
		} catch (err) {
			console.warn("alarm failed", err);
		}
		await this.scheduleNextAlarm();
	}

	/** 全量备份：记忆、文件、定时任务、MCP 配置、会话元数据（不含对话正文，正文走 /api/export）。 */
	async backup(): Promise<{ version: number; exportedAt: string; data: Record<string, unknown> }> {
		await this.open();
		const q = (sql: string) => sqlFacade!.exec(sql).toArray();
		return {
			version: 1,
			exportedAt: new Date().toISOString(),
			data: {
				memories: q("SELECT id, content, created_at, source FROM pi_mem ORDER BY id"),
				files: q("SELECT conversation_id, name, content, updated_at FROM vfs_v2 ORDER BY conversation_id, name"),
				automations: q("SELECT id, name, prompt, session_id, schedule, enabled, next_run_at FROM automations"),
				mcpServers: q("SELECT id, name, url, headers FROM mcp_servers"),
				sessions: q("SELECT id, title, created_at, updated_at, model FROM sessions_meta WHERE deleted = 0"),
				shares: q("SELECT token, kind, session_id, name, created_at FROM shares"),
			},
		};
	}

	/** 从备份恢复：按主键 upsert，不删除现有数据。返回各类写入条数。 */
	async restore(payload: unknown): Promise<Record<string, number>> {
		await this.open();
		const data = (payload as { data?: Record<string, unknown[]> })?.data;
		if (!data || typeof data !== "object") throw new Error("备份格式不正确");
		const counts: Record<string, number> = {};
		const rows = (key: string) => (Array.isArray(data[key]) ? (data[key] as Record<string, unknown>[]) : []);
		const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
		const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

		for (const m of rows("memories")) {
			const content = str(m.content).trim();
			if (!content) continue;
			const dup = sqlFacade!.exec("SELECT id FROM pi_mem WHERE content = ?", content).toArray();
			if (dup.length) continue;
			sqlFacade!.exec(
				"INSERT INTO pi_mem (content, created_at, source) VALUES (?, ?, ?)",
				content, str(m.created_at) || new Date().toISOString(), str(m.source) || "manual",
			);
			counts.memories = (counts.memories ?? 0) + 1;
		}
		for (const f of rows("files")) {
			const name = str(f.name).trim();
			if (!name) continue;
			sqlFacade!.exec(
				"INSERT INTO vfs_v2 (conversation_id, name, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
				str(f.conversation_id) || "1", name, str(f.content), str(f.updated_at) || new Date().toISOString(),
			);
			counts.files = (counts.files ?? 0) + 1;
		}
		for (const a of rows("automations")) {
			const id = str(a.id);
			if (!id) continue;
			sqlFacade!.exec(
				"INSERT INTO automations (id, name, prompt, session_id, schedule, enabled, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, schedule = excluded.schedule, enabled = excluded.enabled",
				id, str(a.name), str(a.prompt), str(a.session_id), str(a.schedule) || '{"kind":"daily","time":"09:00"}',
				num(a.enabled) ? 1 : 0, new Date().toISOString(), num(a.next_run_at) || Date.now() + 60_000,
			);
			counts.automations = (counts.automations ?? 0) + 1;
		}
		for (const s of rows("mcpServers")) {
			const id = str(s.id);
			if (!id) continue;
			sqlFacade!.exec(
				"INSERT INTO mcp_servers (id, name, url, headers, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, headers = excluded.headers",
				id, str(s.name), str(s.url), str(s.headers) || "{}", new Date().toISOString(),
			);
			counts.mcpServers = (counts.mcpServers ?? 0) + 1;
		}
		mcpCache.clear();
		const rebuilt = await buildMcpExtension(sqlFacade!);
		if (rebuilt) {
			this.mcpExt = rebuilt as never;
			if (this.registryRef) this.registryRef.install(rebuilt);
		}
		for (const s of rows("sessions")) {
			const id = str(s.id);
			if (!id) continue;
			sqlFacade!.exec(
				"INSERT INTO sessions_meta (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, model = excluded.model",
				id, str(s.title) || `会话 ${id}`, str(s.created_at) || new Date().toISOString(), str(s.updated_at) || new Date().toISOString(), str(s.model) || "deepseek-flash",
			);
			counts.sessions = (counts.sessions ?? 0) + 1;
		}
		return counts;
	}

	/** 生成分享链接（只读）。token 为随机串，记录在 shares 表。 */
	async createShare(sessionId: string | undefined, kind: "conversation" | "file", name?: string): Promise<{ token: string }> {
		await this.open();
		const conversation = await this.conversationFor(await this.open(), sessionId);
		const bytes = crypto.getRandomValues(new Uint8Array(12));
		const token = [...bytes].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
		sqlFacade!.exec(
			"INSERT INTO shares (token, kind, session_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
			token, kind, String(conversation.id), name ?? "", new Date().toISOString(),
		);
		return { token };
	}

	/** 分享页 HTML（服务端渲染，只读）。 */
	async renderShare(token: string): Promise<string | null> {
		await this.open();
		const rows = sqlFacade!.exec("SELECT kind, session_id, name FROM shares WHERE token = ?", token).toArray() as {
			kind: string;
			session_id: string;
			name: string;
		}[];
		const share = rows[0];
		if (!share) return null;
		const escape = (t: string) =>
			t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const inline = (t: string) =>
			escape(t)
				.replace(/`([^`]+)`/g, "<code>$1</code>")
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				.replace(/(^|\n)#{1,3} (.+)/g, "$1<strong>$2</strong>");
		let title = "分享内容";
		let body = "";
		if (share.kind === "file") {
			const file = sqlFacade!.exec("SELECT content FROM vfs_v2 WHERE conversation_id = ? AND name = ?", share.session_id, share.name).toArray() as { content: string }[];
			title = share.name || "文件";
			body = `<article class="md">${inline(file[0]?.content ?? "（文件已删除）")}</article>`;
		} else {
			const conversation = await (await this.open()).conversation(Number(share.session_id) as never, ctx);
			const page = conversation ? ((await conversation.entries({}, 500, undefined, ctx)) as { items: readonly Record<string, unknown>[] }) : { items: [] };
			const meta = sqlFacade!.exec("SELECT title FROM sessions_meta WHERE id = ?", share.session_id).toArray() as { title: string }[];
			title = meta[0]?.title ?? "对话";
			const textOf = (model: unknown): string => {
				const blocks = Array.isArray(model) ? (model as { content?: unknown }[]) : [];
				for (const block of blocks) {
					const content = block?.content;
					if (typeof content === "string") return content;
					if (Array.isArray(content)) {
						return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: unknown }).text ?? "") : "")).join("");
					}
				}
				return "";
			};
			const parts: string[] = [];
			for (const entry of [...page.items].reverse()) {
				const kind = String(entry.kind ?? "");
				const text = textOf(entry.model).trim();
				if (!text) continue;
				if (kind === "pi.user") parts.push(`<div class="msg user"><div class="who">用户</div><div class="md">${inline(text)}</div></div>`);
				else if (kind === "pi.assistant") parts.push(`<div class="msg bot"><div class="who">助手</div><div class="md">${inline(text)}</div></div>`);
			}
			body = parts.join("") || "<p class='empty'>（暂无内容）</p>";
		}
		return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · 分享</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b1120;color:#e2e8f0;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;display:flex;align-items:center;gap:.6rem;padding:.9rem 1.2rem;background:rgba(15,23,42,.9);border-bottom:1px solid #1e293b;backdrop-filter:blur(8px)}
header .badge{font-size:12px;color:#7dd3fc;border:1px solid rgba(125,211,252,.3);background:rgba(125,211,252,.1);padding:2px 8px;border-radius:6px}
header h1{font-size:14px;margin:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{max-width:820px;margin:0 auto;padding:1.5rem 1.2rem 4rem}
.msg{margin:1.1rem 0;padding:.9rem 1rem;border-radius:14px}
.msg.user{background:#0c4a6e33;border:1px solid #0c4a6e}
.msg.bot{background:#1e293b66;border:1px solid #1e293b}
.who{font-size:11px;color:#94a3b8;margin-bottom:.35rem}
.md{white-space:pre-wrap;word-break:break-word}
.md code{background:#0f172a;border:1px solid #1e293b;border-radius:4px;padding:1px 5px;font-size:.9em}
.empty{color:#64748b;text-align:center}
footer{text-align:center;color:#475569;font-size:12px;padding:1rem}
article.md{background:#111c31;border:1px solid #1e293b;border-radius:14px;padding:1.2rem}
</style></head><body>
<header><span class="badge">只读分享</span><h1>${escape(title)}</h1></header>
<main>${body}</main>
<footer>由 π Harness 生成 · 只读视图</footer>
</body></html>`;
	}

	/** 导出会话为 Markdown（含工具调用摘要）。 */
	async exportMarkdown(sessionId?: string): Promise<{ markdown: string; title: string; sessionId: string }> {
		const harness = await this.open();
		const conversation = await this.conversationFor(harness, sessionId);
		const page = (await conversation.entries({}, 1000, undefined, ctx)) as { items: readonly Record<string, unknown>[] };
		const id = String(conversation.id);
		let title = `会话 ${id}`;
		try {
			const row = sqlFacade!.exec("SELECT title FROM sessions_meta WHERE id = ?", id).toArray() as { title: string }[];
			if (row[0]?.title) title = row[0].title;
		} catch {
			// 元数据缺失时用默认标题
		}
		const lines: string[] = [`# ${title}`, "", `> 导出时间：${new Date().toISOString()}　·　会话 #${id}`, ""];
		const textOf = (model: unknown): string => {
			const blocks = Array.isArray(model) ? (model as { content?: unknown }[]) : [];
			for (const block of blocks) {
				const content = block?.content;
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					const text = content
						.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: unknown }).text ?? "") : ""))
						.join("");
					if (text) return text;
				}
			}
			return "";
		};
		// 条目按 id 倒序返回，导出时按时间正序。
		for (const entry of [...page.items].reverse()) {
			const kind = String(entry.kind ?? "");
			const text = textOf(entry.model);
			if (kind === "pi.user" && text.trim()) {
				lines.push(`## 用户`, "", text.trim(), "");
			} else if (kind === "pi.assistant" && text.trim()) {
				lines.push(`## 助手`, "", text.trim(), "");
			} else if (kind === "pi.tool-result") {
				const blocks = Array.isArray(entry.model) ? (entry.model as { toolName?: string; content?: { text?: string }[] }[]) : [];
				const first = blocks[0];
				const summary = (first?.content ?? []).map((c) => c.text ?? "").join("").trim().slice(0, 200);
				if (first?.toolName) lines.push(`> 🔧 ${first.toolName}${summary ? `：${summary}` : ""}`, "");
			}
		}
		return { markdown: lines.join("\n"), title, sessionId: id };
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
	async chatStream(message: string, sessionId?: string, images?: string[]): Promise<Response> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		const mcpExt = this.mcpExt as { name: string; tools?: unknown[] } | null;
		await root.configure(
			{
				model: { provider: "deepseek", modelId: this.modelFor(sessionId) },
				extensions: mcpExt && (mcpExt.tools?.length ?? 0) > 0
					? [spikeExtension, codemodeExtension, toolSearchExtension, mcpExt as never]
					: [spikeExtension, codemodeExtension, toolSearchExtension],
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
				const submission = await root.submit({ type: "input", content: userContent(message, images) as never }, ctx);
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
				const { message, sessionId, images } = (await request.json()) as {
					message: string;
					sessionId?: string;
					images?: string[];
				};
				return await this.chatStream(message, sessionId, images);
			}
			if (request.method === "POST" && url.pathname === "/chat") {
				const { message, sessionId, images } = (await request.json()) as {
					message: string;
					sessionId?: string;
					images?: string[];
				};
				return Response.json(await this.chat(message, sessionId, images));
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
			if (url.pathname === "/backup" && request.method === "GET") {
				return Response.json(await this.backup());
			}
			if (url.pathname === "/restore" && request.method === "POST") {
				try {
					return Response.json({ ok: true, counts: await this.restore(await request.json()) });
				} catch (err) {
					return Response.json({ error: String(err).slice(0, 200) }, { status: 400 });
				}
			}
			if (url.pathname === "/share" && request.method === "POST") {
				const body = (await request.json()) as { sessionId?: string; kind?: "conversation" | "file"; name?: string };
				const { token } = await this.createShare(body.sessionId, body.kind === "file" ? "file" : "conversation", body.name);
				return Response.json({ ok: true, token, url: `/s/${token}` });
			}
			if (url.pathname.startsWith("/s/") && request.method === "GET") {
				const html = await this.renderShare(url.pathname.slice(3));
				if (!html) return new Response("分享链接不存在或已失效", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
				return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
			}
			if (url.pathname === "/automations" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!.exec(
					"SELECT id, name, prompt, session_id, schedule, enabled, last_run_at, next_run_at FROM automations ORDER BY created_at DESC",
				).toArray();
				return Response.json({ automations: rows });
			}
			if (url.pathname === "/automations" && request.method === "POST") {
				const body = (await request.json()) as {
					name?: string;
					prompt?: string;
					sessionId?: string;
					schedule?: { kind?: string; time?: string; minutes?: number };
				};
				const name = (body.name ?? "").trim().slice(0, 40);
				const prompt = (body.prompt ?? "").trim().slice(0, 2000);
				if (!name || !prompt) return Response.json({ error: "需要名称与提示词" }, { status: 400 });
				const schedule = body.schedule?.kind === "interval"
					? { kind: "interval", minutes: Math.max(1, Math.floor(Number(body.schedule.minutes ?? 60))) }
					: { kind: "daily", time: /^\d{1,2}:\d{2}$/.test(body.schedule?.time ?? "") ? body.schedule!.time! : "09:00" };
				ensureTables(sqlFacade!);
				const id = `a${Date.now().toString(36)}`;
				sqlFacade!.exec(
					"INSERT INTO automations (id, name, prompt, session_id, schedule, enabled, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
					id, name, prompt, body.sessionId ?? "", JSON.stringify(schedule), new Date().toISOString(), this.nextRunAt(schedule),
				);
				await this.scheduleNextAlarm();
				return Response.json({ ok: true, id, nextRunAt: this.nextRunAt(schedule) });
			}
			if (url.pathname === "/automations" && request.method === "PATCH") {
				const body = (await request.json()) as { id?: string; enabled?: boolean };
				if (!body.id) return Response.json({ error: "缺少 id" }, { status: 400 });
				const enabled = body.enabled ? 1 : 0;
				ensureTables(sqlFacade!);
				sqlFacade!.exec(
					"UPDATE automations SET enabled = ?, next_run_at = CASE WHEN ? = 1 THEN ? ELSE next_run_at END WHERE id = ?",
					enabled, enabled, Date.now() + 60_000, body.id,
				);
				await this.scheduleNextAlarm();
				return Response.json({ ok: true });
			}
			if (url.pathname === "/automations" && request.method === "DELETE") {
				ensureTables(sqlFacade!);
				sqlFacade!.exec("DELETE FROM automations WHERE id = ?", url.searchParams.get("id") ?? "");
				await this.scheduleNextAlarm();
				return Response.json({ ok: true });
			}
			if (url.pathname === "/export" && request.method === "GET") {
				const data = await this.exportMarkdown(url.searchParams.get("sessionId") ?? undefined);
				if (url.searchParams.get("format") === "md") {
					return new Response(data.markdown, {
						headers: {
							"content-type": "text/markdown; charset=utf-8",
							"content-disposition": `attachment; filename="session-${data.sessionId}.md"; filename*=UTF-8''${encodeURIComponent(data.title)}.md`,
						},
					});
				}
				return Response.json(data);
			}
			if (url.pathname === "/models" && request.method === "GET") {
				return Response.json({ models: AVAILABLE_MODELS, default: DEFAULT_MODEL_ID });
			}
			if (url.pathname === "/model" && request.method === "POST") {
				const body = (await request.json()) as { sessionId?: string; modelId?: string };
				const modelId = body.modelId ?? "";
				if (!AVAILABLE_MODELS.includes(modelId)) {
					return Response.json({ error: "不支持的模型" }, { status: 400 });
				}
				if (!body.sessionId) return Response.json({ error: "缺少 sessionId" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec(
					"INSERT INTO sessions_meta (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model",
					body.sessionId, "新会话", new Date().toISOString(), new Date().toISOString(), modelId,
				);
				return Response.json({ ok: true, modelId });
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
			if (request.method === "GET" && url.pathname === "/version") {
				return Response.json({ build: (this.env as { BUILD?: string }).BUILD ?? "dev", images: true, search: true });
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

/* ---------------- 访问控制（v0.10.0） ---------------- */

const SESSION_COOKIE = "pi_access";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/** 会话令牌 = HMAC(ACCESS_PASSWORD, 固定串)，改密码即全体失效。 */
async function accessToken(password: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("pi-harness-access-v1")));
	return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function cookieValue(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

async function isAuthorized(request: Request, password: string): Promise<boolean> {
	const token = cookieValue(request, SESSION_COOKIE);
	if (!token) return false;
	return timingSafeEqualStr(token, await accessToken(password));
}

export default {
	async fetch(request: Request, env: { SpikeAgent: DurableObjectNamespace; ACCESS_PASSWORD?: string }): Promise<Response> {
		const url = new URL(request.url);
		const password = env.ACCESS_PASSWORD ?? "";
		const protect = Boolean(password);

		// 登录/登出/状态：不需要已登录。
		if (url.pathname === "/api/auth" && request.method === "GET") {
			return Response.json({ required: protect, authenticated: protect ? await isAuthorized(request, password) : true });
		}
		if (url.pathname === "/api/login" && request.method === "POST") {
			if (!protect) return Response.json({ ok: true, required: false });
			const body = (await request.json().catch(() => ({}))) as { password?: string };
			if (!timingSafeEqualStr(String(body.password ?? ""), password)) {
				return Response.json({ error: "密码不正确" }, { status: 401 });
			}
			const token = await accessToken(password);
			return new Response(JSON.stringify({ ok: true }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
				},
			});
		}
		if (url.pathname === "/api/logout" && request.method === "POST") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
				},
			});
		}

		// 分享页保持公开：只读、只含被打包的内容。
		const isShare = url.pathname.startsWith("/s/");
		if (protect && url.pathname.startsWith("/api/") && !isShare && !(await isAuthorized(request, password))) {
			return Response.json({ error: "未登录" }, { status: 401 });
		}

		if (url.pathname.startsWith("/agent/") || url.pathname.startsWith("/api/") || isShare) {
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName("spike"));
			const inner = new URL(request.url);
			inner.pathname = url.pathname.replace(/^\/(agent|api)/, "") || "/";
			return stub.fetch(new Request(inner, request));
		}
		return Response.json({ ok: true, name: "pi-harness-spike" });
	},
};

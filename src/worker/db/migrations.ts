// 版本化迁移器（ADR-0001 §9.4）：DDL 只在 DO 首次 open()/alarm() 时执行一次，
// 请求路径不再调用 ensureTables。每条迁移必须自身幂等——SqlHandle 没有事务入口。
export type SqlHandle = { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } };

export type Migration = { version: number; name: string; up(sql: SqlHandle): void };

/**
 * ALTER TABLE ... ADD COLUMN 的幂等包装：只吞 `duplicate column name`（老库补列），
 * 表不存在等其它错误必须抛出，避免把真正的 schema 缺陷静默掉。
 */
export function ensureColumn(sql: SqlHandle, table: string, definition: string): void {
	try {
		sql.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	} catch (err) {
		if (!/duplicate column name/i.test(String(err))) throw err;
	}
}

/** v1：现行 20 张业务表。先 CREATE 后 ALTER，空库首启一次得到完整 schema。 */
const initialSchema: Migration = {
	version: 1,
	name: "initial-schema",
	up(sql) {
		sql.exec(`CREATE TABLE IF NOT EXISTS pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS vfs_v2 (conversation_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, name))`);
		sql.exec(`CREATE TABLE IF NOT EXISTS sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)`);
		// 只读分享（v0.9.0）；v0.38.0 起支持过期时间，v0.39.1 起记录分享时的主题
		sql.exec(`CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL DEFAULT 0, theme TEXT NOT NULL DEFAULT 'dark', created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS reflect_state (conversation_id TEXT PRIMARY KEY, last_entry_id INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		// 分步计划（update_plan 工具写入）：每个会话一份最新计划（v0.22.0）
		sql.exec(`CREATE TABLE IF NOT EXISTS plans (conversation_id TEXT PRIMARY KEY, steps TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		// 提示模板与规则文件（v0.31.0）：纯数据能力，运行时加载
		sql.exec(`CREATE TABLE IF NOT EXISTS prompts (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS rules (name TEXT PRIMARY KEY, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
		// 用户知识库（v0.45.0）：每个用户一个独立 DO，文档、分块与 FTS5 索引都落在自己的库
		sql.exec(`CREATE TABLE IF NOT EXISTS kb_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id)`);
		// rowid 复用 kb_chunks.id；标题与正文分列，bm25 可分别加权
		sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(title_tokens, body_tokens)`);
		// 目标模式（v0.31.0）：一个会话一个目标，active 时按 token 预算与轮次自动续转
		sql.exec(`CREATE TABLE IF NOT EXISTS goals (session_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', token_budget INTEGER NOT NULL DEFAULT 200000, baseline_tokens INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, max_turns INTEGER NOT NULL DEFAULT 12, summary TEXT NOT NULL DEFAULT '', next_run_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		// 交互式问答（v0.37.0）：ask_user 工具提出的问题，等用户点选后带回模型
		sql.exec(`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, answered_at TEXT)`);
		// 自定义工具（v0.36.0）：用户贴一段 JS，沙箱执行后成为模型可调用的工具
		sql.exec(`CREATE TABLE IF NOT EXISTS custom_tools (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', parameters TEXT NOT NULL DEFAULT '{}', code TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
		// 工具审批（v0.33.0）：待审批请求 + 已授予的放行许可
		sql.exec(`CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool TEXT NOT NULL, category TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS approval_grants (session_id TEXT NOT NULL, tool TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (session_id, tool))`);
		// LLM 供应商（v0.27.0）：CCswitch 式自定义 OpenAI 兼容端点
		sql.exec(`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, models TEXT NOT NULL, created_at TEXT NOT NULL)`);
		// 老库补列：sessions_meta 的五列曾因 ALTER 跑在 CREATE 之前被静默吞掉。
		ensureColumn(sql, "sessions_meta", `deleted INTEGER NOT NULL DEFAULT 0`);
		ensureColumn(sql, "sessions_meta", `model TEXT NOT NULL DEFAULT 'deepseek-flash'`);
		// v0.29.0：子代理会话不出现在侧栏
		ensureColumn(sql, "sessions_meta", `hidden INTEGER NOT NULL DEFAULT 0`);
		// v0.32.0：会话分支——记录分叉来源与分叉点条目
		ensureColumn(sql, "sessions_meta", `parent_id TEXT`);
		ensureColumn(sql, "sessions_meta", `fork_at INTEGER`);
		// 老库补列（SHARES 建表语句已含两列）
		ensureColumn(sql, "shares", `expires_at INTEGER NOT NULL DEFAULT 0`);
		ensureColumn(sql, "shares", `theme TEXT NOT NULL DEFAULT 'dark'`);
		// 向量索引状态（v0.53.0）：1 = 已写入 Vectorize
		ensureColumn(sql, "kb_chunks", `vectorized INTEGER NOT NULL DEFAULT 0`);
		// pi_mem.source: manual（用户/工具显式保存）或 reflect（会话末自动抽取）。老库补列。
		ensureColumn(sql, "pi_mem", `source TEXT NOT NULL DEFAULT 'manual'`);
	},
};

/** v2：旧版全局文件表 → 迁到 v2 的根会话（'1'），然后丢弃旧表。 */
const vfsRootConversation: Migration = {
	version: 2,
	name: "vfs-files-to-root-conversation",
	up(sql) {
		const legacy = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='vfs_files'").toArray() as { name: string }[];
		if (!legacy.length) return;
		sql.exec(`INSERT OR IGNORE INTO vfs_v2 (conversation_id, name, content, updated_at) SELECT '1', name, content, updated_at FROM vfs_files`);
		sql.exec(`DROP TABLE IF EXISTS vfs_files`);
	},
};

export const MIGRATIONS: readonly Migration[] = [initialSchema, vfsRootConversation];

/** 按 version 升序执行未应用的迁移，成功后写账本；返回本次应用条数。 */
export function migrate(sql: SqlHandle, now: () => string = () => new Date().toISOString()): number {
	sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
	const applied = new Set(
		(sql.exec("SELECT version FROM schema_migrations").toArray() as { version: number }[]).map((row) => Number(row.version)),
	);
	let count = 0;
	for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
		if (applied.has(migration.version)) continue;
		migration.up(sql);
		sql.exec(
			"INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
			migration.version,
			migration.name,
			now(),
		);
		count += 1;
	}
	return count;
}

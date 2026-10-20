// Spike: pi-durable harness inside a Cloudflare Durable Object (MemoryStorage round).
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { watchEvents } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
// 构建期注入：内核依赖版本（v0.35.0）
import packageJson from "../package.json";

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
	// v0.29.0：子代理会话不出现在侧栏
	try {
		sql.exec(`ALTER TABLE sessions_meta ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
	} catch {
		// 列已存在
	}
	// v0.32.0：会话分支——记录分叉来源与分叉点条目
	try {
		sql.exec(`ALTER TABLE sessions_meta ADD COLUMN parent_id TEXT`);
	} catch {
		// 列已存在
	}
	try {
		sql.exec(`ALTER TABLE sessions_meta ADD COLUMN fork_at INTEGER`);
	} catch {
		// 列已存在
	}
	sql.exec(`CREATE TABLE IF NOT EXISTS sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS reflect_state (conversation_id TEXT PRIMARY KEY, last_entry_id INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	// 分步计划（update_plan 工具写入）：每个会话一份最新计划（v0.22.0）
	sql.exec(`CREATE TABLE IF NOT EXISTS plans (conversation_id TEXT PRIMARY KEY, steps TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	// 提示模板与规则文件（v0.31.0）：纯数据能力，运行时加载
	sql.exec(`CREATE TABLE IF NOT EXISTS prompts (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS rules (name TEXT PRIMARY KEY, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
	// 目标模式（v0.31.0）：一个会话一个目标，active 时按 token 预算与轮次自动续转
	sql.exec(`CREATE TABLE IF NOT EXISTS goals (session_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', token_budget INTEGER NOT NULL DEFAULT 200000, baseline_tokens INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, max_turns INTEGER NOT NULL DEFAULT 12, summary TEXT NOT NULL DEFAULT '', next_run_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	// 自定义工具（v0.36.0）：用户贴一段 JS，沙箱执行后成为模型可调用的工具
	sql.exec(`CREATE TABLE IF NOT EXISTS custom_tools (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', parameters TEXT NOT NULL DEFAULT '{}', code TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
	// 工具审批（v0.33.0）：待审批请求 + 已授予的放行许可
	sql.exec(`CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool TEXT NOT NULL, category TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS approval_grants (session_id TEXT NOT NULL, tool TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (session_id, tool))`);
	// LLM 供应商（v0.27.0）：CCswitch 式自定义 OpenAI 兼容端点
	sql.exec(`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, models TEXT NOT NULL, created_at TEXT NOT NULL)`);
	// pi_mem.source: manual（用户/工具显式保存）或 reflect（会话末自动抽取）。老库补列。
	try {
		sql.exec(`ALTER TABLE pi_mem ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
	} catch {
		// 列已存在
	}
};

/** DEEPSEEK_API_KEY（open() 时从 env 注入；模块级定义的工具拿不到 this.env）。 */
let apiKeyRef: string | null = null;
/** Harness 全局引用：子代理工具需要它来创建会话（工具在模块级定义，拿不到 this）。 */
let harnessRef: { createConversation(o: unknown, c: unknown): Promise<unknown>; conversation(id: unknown, c: unknown): Promise<unknown> } | null = null;

/** 全局设置读写（app_settings 表）：目前只有网页搜索开关 web_search。 */
function getSetting(key: string, fallback: string): string {
	try {
		const rows = sqlFacade!.exec("SELECT value FROM app_settings WHERE key = ?", key).toArray() as { value: string }[];
		return rows[0]?.value ?? fallback;
	} catch {
		return fallback;
	}
}

function setSetting(key: string, value: string): void {
	sqlFacade!.exec("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

/** 思考档位：off / low / high（deepseek-flash 支持 low/high/max，v4-pro 支持 high/max）。 */
type ThinkingLevel = "off" | "low" | "high";
const currentThinkingLevel = (): ThinkingLevel => {
	const v = getSetting("thinking_level", "low");
	return v === "off" || v === "high" ? v : "low";
};

/** 计划步骤（update_plan 工具）。 */
type PlanStep = { title: string; status: "pending" | "in_progress" | "completed" };

function savePlan(conversationId: string, steps: PlanStep[]): void {
	sqlFacade!.exec(
		"INSERT INTO plans (conversation_id, steps, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at",
		conversationId, JSON.stringify(steps), new Date().toISOString(),
	);
}

const readPlan = (conversationId: string): PlanStep[] => {
	try {
		const rows = sqlFacade!.exec("SELECT steps FROM plans WHERE conversation_id = ?", conversationId).toArray() as { steps: string }[];
		const parsed = rows[0] ? (JSON.parse(rows[0].steps) as unknown) : [];
		return Array.isArray(parsed) ? (parsed as PlanStep[]) : [];
	} catch {
		return [];
	}
};

/* ---------------- 目标模式（v0.31.0） ---------------- */

type GoalStatus = "active" | "done" | "blocked" | "paused" | "exhausted";

type GoalRow = {
	session_id: string;
	objective: string;
	status: GoalStatus;
	token_budget: number;
	baseline_tokens: number;
	tokens_used: number;
	turns: number;
	max_turns: number;
	summary: string;
	next_run_at: number;
	created_at: string;
	updated_at: string;
};

const GOAL_TOKEN_BUDGET_DEFAULT = 200_000;
const GOAL_MAX_TURNS_DEFAULT = 12;
/** 单次请求内最多自动续转几轮；剩下的交给 alarm 跨请求接续。 */
const GOAL_ROUNDS_PER_REQUEST = 3;

function readGoalRow(sessionId: string): GoalRow | null {
	try {
		const rows = sqlFacade!.exec("SELECT * FROM goals WHERE session_id = ?", sessionId).toArray() as GoalRow[];
		return rows[0] ?? null;
	} catch {
		return null;
	}
}

/** 对外（前端 / SSE）的目标视图。 */
function goalInfo(row: GoalRow | null) {
	if (!row) return null;
	return {
		objective: row.objective,
		status: row.status,
		tokenBudget: row.token_budget,
		tokensUsed: row.tokens_used,
		turns: row.turns,
		maxTurns: row.max_turns,
		summary: row.summary || undefined,
		updatedAt: row.updated_at,
	};
}

function writeGoal(
	sessionId: string,
	patch: Partial<Pick<GoalRow, "status" | "tokens_used" | "turns" | "summary" | "next_run_at" | "baseline_tokens">>,
): void {
	const sets: string[] = [];
	const args: unknown[] = [];
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		sets.push(`${key} = ?`);
		args.push(value);
	}
	if (!sets.length) return;
	sets.push("updated_at = ?");
	args.push(new Date().toISOString(), sessionId);
	sqlFacade!.exec(`UPDATE goals SET ${sets.join(", ")} WHERE session_id = ?`, ...args);
}

/** 建立（或替换）一个会话的目标。baseline 是本轮之前的累计 token，用于计算目标消耗。 */
function startGoal(sessionId: string, objective: string, tokenBudget: number, maxTurns: number, baseline: number): void {
	const now = new Date().toISOString();
	sqlFacade!.exec(
		`INSERT INTO goals (session_id, objective, status, token_budget, baseline_tokens, tokens_used, turns, max_turns, summary, next_run_at, created_at, updated_at)
		 VALUES (?, ?, 'active', ?, ?, 0, 0, ?, '', 0, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET objective = excluded.objective, status = 'active', token_budget = excluded.token_budget, baseline_tokens = excluded.baseline_tokens, tokens_used = 0, turns = 0, max_turns = excluded.max_turns, summary = '', next_run_at = 0, updated_at = excluded.updated_at`,
		sessionId, objective, tokenBudget, baseline, maxTurns, now, now,
	);
}

/** 自动续转的提示词：强调「直接做」，避免模型空转。 */
function goalContinuePrompt(row: GoalRow): string {
	return [
		`继续推进目标：${row.objective}`,
		"",
		`进度：已完成 ${row.turns} 轮，已用 ${row.tokens_used} / ${row.token_budget} tokens。`,
		"要求：",
		"- 先看计划和已有产出，不要重复已经做过的工作，直接做下一步。",
		"- 不要只回复「继续」之类的话，这一轮必须有实际进展。",
		"- 全部达成后调用 complete_goal，并给出可核对的验证证据。",
		"- 确实无法推进时调用 report_goal 说明阻塞原因。",
	].join("\n");
}


/* ---------------- 工具审批（v0.33.0） ---------------- */

type ApprovalCategory = "read" | "write" | "exec";
type ApprovalPolicy = "allow" | "ask" | "deny";

/** 已知工具的默认分级。MCP 工具按写操作、未知工具按读取处理。 */
const TOOL_CATEGORY: Record<string, ApprovalCategory> = {
	now: "read",
	recall: "read",
	list_skills: "read",
	load_skill: "read",
	read_file: "read",
	list_files: "read",
	web_search: "read",
	web_fetch_page: "read",
	http_fetch: "read",
	tool_search: "read",
	update_plan: "read",
	set_goal: "read",
	complete_goal: "read",
	report_goal: "read",
	write_file: "write",
	remember: "write",
	codemode: "exec",
	dispatch_tasks: "exec",
};

const APPROVAL_LABEL: Record<ApprovalCategory, string> = { read: "读取", write: "写入", exec: "执行" };

/** 当前已加载的自定义工具名（构建扩展时刷新），统一按 exec 级处理。 */
const customToolNames = new Set<string>();

function toolCategory(name: string): ApprovalCategory {
	const known = TOOL_CATEGORY[name];
	if (known) return known;
	if (customToolNames.has(name)) return "exec";
	if (name.startsWith("mcp__")) return "write";
	return "read";
}

/** 三档策略（供设置页读取）。 */
function approvalSettings(): { read: ApprovalPolicy; write: ApprovalPolicy; exec: ApprovalPolicy } {
	const pick = (level: ApprovalCategory): ApprovalPolicy => {
		const value = getSetting(`approval_${level}`, "allow");
		return value === "ask" || value === "deny" ? value : "allow";
	};
	return { read: pick("read"), write: pick("write"), exec: pick("exec") };
}

/** 生效策略：逐工具覆盖 > 分级策略 > 默认放行。 */
function toolPolicy(name: string): ApprovalPolicy {
	const override = getSetting(`approval_tool_${name}`, "follow");
	if (override === "allow" || override === "ask" || override === "deny") return override;
	const level = getSetting(`approval_${toolCategory(name)}`, "allow");
	return level === "ask" || level === "deny" ? level : "allow";
}

/** 子代理会话在侧栏不可见，没人能点审批：直接放行，避免子任务卡死。 */
function isHiddenSession(sessionId: string): boolean {
	try {
		const rows = sqlFacade!.exec("SELECT hidden FROM sessions_meta WHERE id = ?", sessionId).toArray() as { hidden?: number }[];
		return Number(rows[0]?.hidden ?? 0) === 1;
	} catch {
		return false;
	}
}

/** 消耗一次放行许可（uses = -1 表示始终允许）。 */
function consumeApprovalGrant(sessionId: string, tool: string): boolean {
	try {
		const rows = sqlFacade!.exec("SELECT uses FROM approval_grants WHERE session_id = ? AND tool = ?", sessionId, tool).toArray() as {
			uses: number;
		}[];
		const row = rows[0];
		if (!row) return false;
		if (row.uses < 0) return true;
		if (row.uses <= 1) sqlFacade!.exec("DELETE FROM approval_grants WHERE session_id = ? AND tool = ?", sessionId, tool);
		else sqlFacade!.exec("UPDATE approval_grants SET uses = uses - 1 WHERE session_id = ? AND tool = ?", sessionId, tool);
		return true;
	} catch {
		return false;
	}
}

/** 记录一条待审批；同一会话同一工具已有待审批时不重复插入。 */
function recordApproval(sessionId: string, tool: string, category: ApprovalCategory, args: unknown): number | null {
	try {
		const existing = sqlFacade!
			.exec("SELECT id FROM approvals WHERE session_id = ? AND tool = ? AND status = 'pending' ORDER BY id DESC", sessionId, tool)
			.toArray() as { id: number }[];
		if (existing[0]) return existing[0].id;
		const preview = (() => {
			try {
				return JSON.stringify(args ?? {}).slice(0, 800);
			} catch {
				return "";
			}
		})();
		sqlFacade!.exec(
			"INSERT INTO approvals (session_id, tool, category, args, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
			sessionId, tool, category, preview, new Date().toISOString(),
		);
		const rows = sqlFacade!.exec("SELECT last_insert_rowid() AS id").toArray() as { id: number }[];
		return rows[0]?.id ?? null;
	} catch {
		return null;
	}
}

/** 给工具套上审批闸门：放行 / 询问（无许可时记一条待审批并让模型等待）/ 禁止。 */
function withApproval<T extends { name: string; execute?: (...args: never[]) => unknown }>(tool: T): T {
	const original = tool.execute;
	if (typeof original !== "function") return tool;
	return {
		...tool,
		// 必须把 execute 的全部参数（args, api, context）原样转发：codemode 等工具依赖第三个 context.abortSignal
		execute: async (...rest: never[]) => {
			const policy = toolPolicy(tool.name);
			const run = () => (original as (...a: never[]) => unknown)(...rest);
			const args = rest[0];
			const api = rest[1];
			if (policy === "allow") return run();
			const sid = String((api as unknown as { conversationId?: unknown })?.conversationId ?? "1");
			if (isHiddenSession(sid)) return run();
			const category = toolCategory(tool.name);
			if (policy === "deny") {
				return {
					output: [{
						type: "text",
						text: `「${tool.name}」属于${APPROVAL_LABEL[category]}级操作，当前策略为禁止。请告诉用户：可在 设置 → 工具审批 中调整。`,
					}],
				};
			}
			if (consumeApprovalGrant(sid, tool.name)) return run();
			const id = recordApproval(sid, tool.name, category, args);
			return {
				output: [{
					type: "text",
					text: `「${tool.name}」属于${APPROVAL_LABEL[category]}级操作，需要用户确认后才能执行。已提交待审批${id ? `（#${id}）` : ""}：不要重复调用本工具，等用户批准后再继续。`,
				}],
			};
		},
	} as T;
}


/* ---------------- 自定义工具（v0.36.0）：用户 JS → 沙箱工具 ---------------- */

/** 合法工具名：字母开头，字母数字下划线。 */
const CUSTOM_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{1,40}$/;
/** 保留名：不能覆盖内置工具。 */
const RESERVED_TOOL_NAMES = new Set([
	"now", "remember", "recall", "list_skills", "load_skill", "read_file", "list_files", "write_file",
	"update_plan", "dispatch_tasks", "web_search", "web_fetch_page", "http_fetch", "tool_search",
	"codemode", "set_goal", "complete_goal", "report_goal",
]);
const CUSTOM_TOOL_CODE_MAX = 8000;

/** 共享的 QuickJS 沙箱：每次 execute 起独立 VM，自定义工具之间互不影响。 */
let customSandbox: ReturnType<typeof createInlineCodemodeSandbox> | null = null;
function sandbox(): ReturnType<typeof createInlineCodemodeSandbox> {
	customSandbox ??= createInlineCodemodeSandbox({ memoryLimitBytes: 32 * 1024 * 1024, timeoutMs: 15_000 });
	return customSandbox;
}

type CustomToolRow = { name: string; description: string; parameters: string; code: string };

function listCustomToolRows(): CustomToolRow[] {
	try {
		return sqlFacade!
			.exec("SELECT name, description, parameters, code FROM custom_tools WHERE enabled = 1 ORDER BY name")
			.toArray() as CustomToolRow[];
	} catch {
		return [];
	}
}

/** 把用户代码包成函数体执行：`args` 是入参，返回值即工具结果。 */
async function runCustomTool(code: string, args: unknown): Promise<{ ok: boolean; text: string }> {
	const source = `async function __custom_tool(args) {\n${code}\n}\nreturn await __custom_tool(load("args"));`;
	try {
		const result = await sandbox().execute(source, { store: { args: args ?? {} }, timeoutMs: 15_000 });
		if (!result.ok) {
			const detail = (result.error as { message?: unknown } | undefined)?.message;
			return { ok: false, text: `执行失败：${String(detail ?? JSON.stringify(result.error)).slice(0, 400)}` };
		}
		const value = result.value;
		const text =
			value === undefined || value === null
				? "(无返回值)"
				: typeof value === "string"
					? value
					: JSON.stringify(value);
		return { ok: true, text: text.slice(0, 8000) };
	} catch (err) {
		return { ok: false, text: `执行异常：${String(err).slice(0, 300)}` };
	}
}

/** 从 custom_tools 表构建扩展；没有启用的工具时返回 null。 */
function buildCustomToolsExtension(sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } }) {
	const rows = (() => {
		try {
			return sql.exec("SELECT name, description, parameters, code FROM custom_tools WHERE enabled = 1 ORDER BY name").toArray() as CustomToolRow[];
		} catch {
			return [];
		}
	})();
	customToolNames.clear();
	const tools = rows.map((row) => {
		customToolNames.add(row.name);
		let parameters: object = { type: "object", properties: {} };
		try {
			const parsed = JSON.parse(row.parameters) as { type?: unknown };
			if (parsed && typeof parsed === "object" && parsed.type === "object") parameters = parsed;
		} catch {
			// 保持默认空 schema
		}
		return withApproval(
			defineTool({
				name: row.name,
				description: `${row.description || row.name}\n（自定义工具：在 QuickJS 沙箱里执行用户提供的 JavaScript，入参是 args 对象，返回值即结果）`.slice(0, 400),
				parameters: Type.Unsafe(parameters as never),
				execute: async (args: unknown) => {
					const r = await runCustomTool(row.code, args);
					return { output: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
				},
			}) as never,
		);
	});
	return defineExtension({ name: "custom-tools", tools: tools as never });
}

/* ---------------- 提示模板与规则（v0.31.0） ---------------- */

type RuleRow = { name: string; content: string; enabled: number };

function listRules(): RuleRow[] {
	try {
		return sqlFacade!.exec("SELECT name, content, enabled FROM rules ORDER BY name").toArray() as RuleRow[];
	} catch {
		return [];
	}
}

/** 启用的规则正文，按名称排序后注入 instructions。 */
function enabledRules(): string[] {
	return listRules().filter((r) => r.enabled).map((r) => r.content.trim()).filter(Boolean);
}

function listPrompts(): { name: string; description: string; content: string }[] {
	try {
		return sqlFacade!.exec("SELECT name, description, content FROM prompts ORDER BY name").toArray() as {
			name: string;
			description: string;
			content: string;
		}[];
	} catch {
		return [];
	}
}

/* ---------------- pi 内核版本（v0.35.0） ---------------- */

/** 我们直接 import 的 pi 内核包。升级脚本与自动 PR 都以这份清单为准。 */
const PI_PACKAGES = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-codemode",
];

/** package.json 里声明的版本范围（构建期内联）。 */
function declaredKernelVersions(): Record<string, string> {
	const deps = { ...(packageJson as { dependencies?: Record<string, string> }).dependencies } as Record<string, string>;
	const out: Record<string, string> = {};
	for (const name of PI_PACKAGES) out[name] = deps[name] ?? "(传递依赖)";
	return out;
}

/** 去掉 ^ ~ 等前缀，得到可比较的数字段。 */
function semverParts(v: string): number[] {
	return v
		.replace(/^[^0-9]*/, "")
		.split("-")[0]!
		.split(".")
		.map((n) => Number(n) || 0);
}

/** a 是否比 b 新（只比较主版本号）。 */
function semverGreater(a: string, b: string): boolean {
	const pa = semverParts(a);
	const pb = semverParts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

/** 查 npm 上的最新版本；失败返回 null（不阻塞页面）。 */
async function fetchLatestVersion(name: string): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: unknown };
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
	}
}

/* ---------------- 上下文压缩策略（v0.30.0） ---------------- */

/** 与 pi-durable 内置默认一致，作为设置项的回落值。 */
const DEFAULT_COMPACTION = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 };

function compactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number } {
	const num = (key: string, fallback: number, min: number) => {
		const value = Number(getSetting(key, String(fallback)));
		return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
	};
	return {
		enabled: getSetting("compaction_enabled", "1") === "1",
		reserveTokens: num("compaction_reserve", DEFAULT_COMPACTION.reserveTokens, 1024),
		keepRecentTokens: num("compaction_keep_recent", DEFAULT_COMPACTION.keepRecentTokens, 0),
		backgroundTokens: num("compaction_background", DEFAULT_COMPACTION.backgroundTokens, 0),
	};
}

/* ---------------- LLM 供应商（v0.27.0） ---------------- */

/** 内置默认供应商（DeepSeek 官方，走 DEEPSEEK_API_KEY）。 */
const DEFAULT_PROVIDER = { id: "deepseek", name: "DeepSeek 官方", models: ["deepseek-flash", "deepseek-v4-pro"] };

type ProviderRow = { id: string; name: string; base_url: string; api_key: string; models: string };

function listProviderRows(): ProviderRow[] {
	try {
		return sqlFacade!.exec("SELECT id, name, base_url, api_key, models FROM providers ORDER BY created_at ASC").toArray() as ProviderRow[];
	} catch {
		return [];
	}
}

/** 当前启用的供应商 id；空串 = 默认 DeepSeek。 */
const activeProviderId = (): string => getSetting("active_provider", "");

function splitModels(raw: string): string[] {
	return raw
		.split(/[,，\s]+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 20);
}

/** 当前可用的模型 id 列表。 */
function activeModelIds(): string[] {
	const id = activeProviderId();
	if (!id) return DEFAULT_PROVIDER.models;
	const row = listProviderRows().find((r) => r.id === id);
	const models = row ? splitModels(row.models) : [];
	return models.length ? models : DEFAULT_PROVIDER.models;
}

/** 把一条供应商记录构造成 pi-ai 的 Provider（OpenAI 兼容端点）。 */
function buildCustomProvider(row: ProviderRow): unknown {
	const modelIds = splitModels(row.models);
	return createProvider({
		id: row.id,
		name: row.name,
		baseUrl: row.base_url,
		auth: {
			apiKey: {
				name: `${row.name} API key`,
				resolve: async () => ({ auth: { apiKey: row.api_key }, source: "已保存的密钥" }),
			},
		},
		// 只填最少必要字段：成本置零、上下文按 128k 估、多模态保守关闭
		models: (modelIds.length ? modelIds : DEFAULT_PROVIDER.models).map((mid) => ({
			id: mid,
			name: mid,
			api: "openai-completions",
			provider: row.id,
			baseUrl: row.base_url,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 16_384,
		})),
		api: openAICompletionsApi(),
	} as never);
}

const stripHtml = (html: string) =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 6000);

const baseSpikeExtension = defineExtension({
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
			name: "list_skills",
			description: "列出已安装的技能（名称与用途）",
			parameters: Type.Object({}),
			execute: async () => {
				const rows = sqlFacade!.exec("SELECT name, description FROM skills ORDER BY name").toArray() as {
					name: string;
					description: string;
				}[];
				const text = rows.length ? rows.map((r) => `- ${r.name}：${r.description || "（无描述）"}`).join("\n") : "还没有安装任何技能。";
				return { output: [{ type: "text", text }] };
			},
		}),
		defineTool({
			name: "load_skill",
			description: "读取某个技能的完整说明（步骤/模板/约束），按说明完成任务",
			parameters: Type.Object({ name: Type.String({ description: "技能名称" }) }),
			execute: async (args) => {
				const name = String((args as { name?: unknown }).name ?? "").trim();
				const rows = sqlFacade!.exec("SELECT content FROM skills WHERE name = ?", name).toArray() as { content: string }[];
				return { output: [{ type: "text", text: rows[0]?.content ?? `技能「${name}」不存在，可用 list_skills 查看。` }] };
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
			name: "update_plan",
			description:
				"维护当前任务的分步计划（Codex 式 todo 列表）。多步任务开始前先列出完整步骤（3–7 步），之后每完成一步就再次调用本工具提交**完整的**步骤列表并更新状态。用户能在聊天界面实时看到这份计划，所以只列真正要做的步骤。",
			parameters: Type.Object({
				explanation: Type.Optional(Type.String({ description: "一句话说明为什么更新计划（可选）" })),
				steps: Type.Array(
					Type.Object({
						title: Type.String({ description: "这一步做什么，动词开头，一句话" }),
						status: Type.String({ description: "pending | in_progress | completed" }),
					}),
					{ description: "完整的步骤列表（每次都提交全量，不是增量）" },
				),
			}),
			execute: async (args, api) => {
				const raw = (args as { steps?: unknown }).steps;
				const list = Array.isArray(raw) ? raw : [];
				const steps: PlanStep[] = [];
				for (const item of list.slice(0, 20)) {
					const o = (item ?? {}) as { title?: unknown; status?: unknown };
					const title = String(o.title ?? "").trim().slice(0, 120);
					if (!title) continue;
					const s = String(o.status ?? "pending");
					steps.push({ title, status: s === "completed" || s === "in_progress" ? s : "pending" });
				}
				if (!steps.length) return { output: [{ type: "text", text: "计划为空，未保存。" }] };
				savePlan(String(api.conversationId), steps);
				const done = steps.filter((s) => s.status === "completed").length;
				const current = steps.find((s) => s.status === "in_progress");
				return {
					output: [{
						type: "text",
						text: `计划已更新：${steps.length} 步，完成 ${done} 步${current ? `，当前：${current.title}` : ""}。`,
					}],
				};
			},
		}),
		defineTool({
			name: "set_goal",
			description:
				"为用户的长程目标开启目标模式：绑定目标 + token 预算 + 最大轮次。开启后你会在每轮结束后被自动要求继续推进，直到调用 complete_goal、预算用尽或报告受阻。只在用户给出一个需要多轮才能完成的大目标时使用；普通问题不要用。",
			parameters: Type.Object({
				objective: Type.String({ description: "要达成的目标，一句话，可验收" }),
				tokenBudget: Type.Optional(Type.Number({ description: "token 预算，默认 200000" })),
				maxTurns: Type.Optional(Type.Number({ description: "最多自动续转轮次，默认 12" })),
			}),
			execute: async (args, api) => {
				const a = args as { objective?: unknown; tokenBudget?: unknown; maxTurns?: unknown };
				const objective = String(a.objective ?? "").trim().slice(0, 300);
				if (!objective) return { output: [{ type: "text", text: "目标不能为空。" }] };
				const sid = String(api.conversationId);
				const existing = readGoalRow(sid);
				if (existing?.status === "active") {
					return { output: [{ type: "text", text: `当前会话已有进行中的目标「${existing.objective}」，先完成或停止它。` }] };
				}
				const budget = Math.max(10_000, Math.floor(Number(a.tokenBudget ?? GOAL_TOKEN_BUDGET_DEFAULT) || GOAL_TOKEN_BUDGET_DEFAULT));
				const turns = Math.min(50, Math.max(1, Math.floor(Number(a.maxTurns ?? GOAL_MAX_TURNS_DEFAULT) || GOAL_MAX_TURNS_DEFAULT)));
				// baseline = -1：目标由模型在对话中途建立，真实基线在下一轮同步时以当时累计值为准
				startGoal(sid, objective, budget, turns, -1);
				return {
					output: [{
						type: "text",
						text: `目标已开启：${objective}（预算 ${budget} tokens，最多 ${turns} 轮）。完成后必须调用 complete_goal 并给出验证证据。`,
					}],
				};
			},
		}),
		defineTool({
			name: "complete_goal",
			description:
				"声明当前目标已完成并关闭目标模式。必须给出可核对的完成证据；如果计划里还有未完成步骤会被拒绝。",
			parameters: Type.Object({
				summary: Type.String({ description: "完成情况，一段话" }),
				evidence: Type.String({ description: "完成证据：做了什么、怎么验证的（文件、数值、测试输出、链接）" }),
			}),
			execute: async (args, api) => {
				const a = args as { summary?: unknown; evidence?: unknown };
				const sid = String(api.conversationId);
				const row = readGoalRow(sid);
				if (!row || row.status !== "active") {
					return { output: [{ type: "text", text: "当前会话没有进行中的目标。" }] };
				}
				const evidence = String(a.evidence ?? "").trim();
				if (evidence.length < 10) {
					return { output: [{ type: "text", text: "证据太短（至少 10 字）。请说明你实际做了什么、用什么方式验证的，再调用本工具。" }] };
				}
				// 完成硬校验：计划里不能还有没做完的步骤
				const steps = readPlan(sid);
				const open = steps.filter((s) => s.status !== "completed");
				if (steps.length && open.length) {
					return {
						output: [{
							type: "text",
							text: `计划还有 ${open.length} 步未完成（${open.slice(0, 5).map((s) => s.title).join("；")}）。先完成它们并把计划更新为全部 completed，再调用 complete_goal。`,
						}],
					};
				}
				const summary = String(a.summary ?? "").trim().slice(0, 800);
				writeGoal(sid, { status: "done", summary: `${summary}\n\n证据：${evidence.slice(0, 400)}`, next_run_at: 0 });
				return { output: [{ type: "text", text: `目标已完成并关闭。\n${summary}` }] };
			},
		}),
		defineTool({
			name: "report_goal",
			description: "报告目标推进受阻（缺少权限、信息不足、外部依赖不可用等），并结束自动续转。",
			parameters: Type.Object({
				reason: Type.String({ description: "受阻原因，具体说明缺什么" }),
			}),
			execute: async (args, api) => {
				const sid = String(api.conversationId);
				const row = readGoalRow(sid);
				if (!row || row.status !== "active") return { output: [{ type: "text", text: "当前会话没有进行中的目标。" }] };
				const reason = String((args as { reason?: unknown }).reason ?? "").trim().slice(0, 500) || "未说明";
				writeGoal(sid, { status: "blocked", summary: reason, next_run_at: 0 });
				return { output: [{ type: "text", text: `目标已标记为受阻并停止续转：${reason}` }] };
			},
		}),
		defineTool({
			name: "dispatch_tasks",
			description:
				"把若干**互不依赖**的子任务并行分派给子代理，各自独立完成后汇总。适合「同时调研 N 个对象」「对比 M 个方案」这类可并行的活。每个子代理看不到主对话，prompt 必须自包含。",
			parameters: Type.Object({
				tasks: Type.Array(
					Type.Object({
						title: Type.String({ description: "子任务标题，用于汇总展示（10 字以内）" }),
						prompt: Type.String({ description: "交给子代理的完整指令，自包含，不依赖主对话上下文" }),
					}),
					{ description: "子任务列表，1–4 个", minItems: 1, maxItems: 4 },
				),
			}),
			execute: async (args, api) => {
				const harness = harnessRef as unknown as {
					createConversation(o: unknown, c: unknown): Promise<{
						id: unknown;
						submit(i: unknown, c: unknown): Promise<{ wait(c: unknown): Promise<{ status: string; type?: string; answer?: unknown }> }>;
						entries(q: object, limit: number, cursor: undefined, c: unknown): Promise<{ items: readonly unknown[] }>;
					}>;
					conversation(id: unknown, c: unknown): Promise<{ agent(c: unknown): Promise<{ model?: { provider: string; modelId: string } }> } | null>;
				} | null;
				if (!harness) return { output: [{ type: "text", text: "子代理不可用：harness 未就绪。" }] };

				const list = Array.isArray((args as { tasks?: unknown }).tasks) ? ((args as { tasks: unknown[] }).tasks) : [];
				const tasks = list
					.slice(0, 4)
					.map((t) => {
						const o = (t ?? {}) as { title?: unknown; prompt?: unknown };
						return { title: String(o.title ?? "").trim().slice(0, 40), prompt: String(o.prompt ?? "").trim() };
					})
					.filter((t) => t.prompt);
				if (!tasks.length) return { output: [{ type: "text", text: "没有有效的子任务。" }] };

				// 沿用父会话的模型；取不到就用当前供应商的第一个模型
				let model = { provider: activeProviderId() || DEFAULT_PROVIDER.id, modelId: activeModelIds()[0] ?? DEFAULT_MODEL_ID };
				try {
					const parent = await harness.conversation(api.conversationId, ctx);
					const agent = parent ? await parent.agent(ctx) : null;
					if (agent?.model) model = { provider: agent.model.provider, modelId: agent.model.modelId };
				} catch {
					// 取不到就用默认
				}

				// 子代理只给只读类工具，避免并发写文件/记忆
				const allTools = [
					...((spikeExtension as unknown as { tools?: { name: string }[] }).tools ?? []),
					...((codemodeExtension as unknown as { tools?: { name: string }[] }).tools ?? []),
				];
				const allowedNames = new Set(["now", "recall", "read_file", "list_files", "http_fetch", "web_search", "web_fetch_page", "codemode"]);
				const modelTools = allTools.filter((t) => allowedNames.has(t.name));
				const instructions =
					"你是被主代理分派的子代理，只负责完成分配给你的那一个任务。\n" +
					"- 直接给结果，不要寒暄、不要复述任务。\n" +
					"- 需要检索就用 web_search / web_fetch_page；需要计算就用 codemode。\n" +
					"- 结果控制在 800 字以内，结论先行。\n" +
					"- 完成后不要再调用工具。";

				const runOne = async (task: { title: string; prompt: string }, index: number) => {
					const started = Date.now();
					try {
						const conv = await harness.createConversation(
							{
								ownership: { kind: "ownerless" },
								agent: { model, extensions: [spikeExtension, codemodeExtension], instructions, modelTools },
							},
							ctx,
						);
						// 子代理会话标记为隐藏，不出现在侧栏
						sqlFacade!.exec(
							"INSERT INTO sessions_meta (id, title, created_at, updated_at, hidden) VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING",
							String(conv.id), `子代理 ${index + 1}：${task.title || "未命名"}`, new Date().toISOString(), new Date().toISOString(),
						);
						const submission = await conv.submit({ type: "input", content: task.prompt }, ctx);
						const settled = await submission.wait(ctx);
						if (settled.status !== "done" || settled.type !== "input") {
							return { title: task.title, ok: false, text: `（子任务未完成：${settled.status}）`, ms: Date.now() - started };
						}
						// settled.answer 可能只是这一轮的工具调用消息；改为读会话里最新一条含文本的助手条目
						let text = "";
						try {
							const page = await conv.entries({}, 20, undefined, ctx);
							for (const raw of page.items as Record<string, unknown>[]) {
								if (raw.kind !== "pi.assistant") continue;
								const blocks = (raw.model as { content?: unknown }[] | undefined)?.[0]?.content;
								const joined = Array.isArray(blocks)
									? blocks
											.filter((b): b is { type: string; text?: string } => Boolean(b) && typeof b === "object")
											.filter((b) => b.type === "text")
											.map((b) => b.text ?? "")
											.join("")
											.trim()
									: typeof blocks === "string"
										? blocks.trim()
										: "";
								if (joined) {
									text = joined;
									break;
								}
							}
						} catch {
							// 读条目失败就退回 settled.answer
							const blocks = (settled.answer as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
							text = blocks
								.filter((b) => b.type === "text")
								.map((b) => b.text ?? "")
								.join("")
								.trim();
						}
						return { title: task.title, ok: true, text: text.slice(0, 4000), ms: Date.now() - started };
					} catch (err) {
						return { title: task.title, ok: false, text: `（失败：${String(err).slice(0, 160)}）`, ms: Date.now() - started };
					}
				};

				const results = await Promise.all(tasks.map(runOne));
				const parts = results.map(
					(r, i) => `## 子任务 ${i + 1}：${r.title || "未命名"}${r.ok ? "" : "（失败）"}\n\n${r.text || "（空）"}`,
				);
				const summary = results.map((r, i) => `${i + 1}. ${r.title} — ${r.ok ? "完成" : "失败"} · ${(r.ms / 1000).toFixed(1)}s`).join("\n");
				return {
					output: [{ type: "text", text: `已并行完成 ${results.filter((r) => r.ok).length}/${results.length} 个子任务：\n${summary}\n\n${parts.join("\n\n")}` }],
				};
			},
		}),
		defineTool({
			name: "web_search",
			description:
				"联网搜索（DeepSeek 搜索 API）。返回「标题+链接+摘要」列表；需要实时信息、事实核查、最新动态时使用。结果里的 URL 可再配合 web_fetch_page 抓取正文。",
			parameters: Type.Object({
				query: Type.String({ description: '搜索关键词（1–128 字符），支持 site:、"..."、lang:、after:、before: 等语法' }),
				count: Type.Optional(Type.Number({ description: "返回条数 1–50，默认 8" })),
			}),
			execute: async (args) => {
				const a = args as { query?: unknown; count?: unknown };
				const query = String(a.query ?? "").trim().slice(0, 128);
				if (!query) return { output: [{ type: "text", text: "搜索关键词不能为空。" }] };
				if (getSetting("web_search", "1") !== "1") {
					return { output: [{ type: "text", text: "网页搜索当前未开启。请告诉用户：在 设置 → 网页搜索 中开启后即可联网搜索。" }] };
				}
				if (!apiKeyRef) return { output: [{ type: "text", text: "未配置 DEEPSEEK_API_KEY，无法联网搜索。" }] };
				const count = Math.min(50, Math.max(1, Math.floor(Number(a.count ?? 8) || 8)));
				try {
					const resp = await fetch("https://api.deepseek.com/v1/tools/search", {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${apiKeyRef}` },
						body: JSON.stringify({ query, count, need_content: false }),
					});
					const data = (await resp.json().catch(() => null)) as { results?: unknown; error?: { message?: string } } | null;
					if (!resp.ok) {
						const msg = data?.error?.message ?? `HTTP ${resp.status}`;
						return { output: [{ type: "text", text: `搜索失败：${msg}` }] };
					}
					const results = Array.isArray(data?.results) ? (data!.results as Record<string, unknown>[]) : [];
					if (!results.length) return { output: [{ type: "text", text: "没有搜索结果，试试换关键词。" }] };
					const lines = results.map((r, i) => {
						const title = String(r.title ?? "").trim() || "(无标题)";
						const url2 = String(r.url ?? "");
						const snippet = String(r.summary || r.snippet || "").trim().slice(0, 400);
						const date = typeof r.date === "string" ? ` · ${r.date.slice(0, 10)}` : "";
						return `${i + 1}. ${title}${date}\n   ${url2}\n   ${snippet}`;
					});
					return { output: [{ type: "text", text: lines.join("\n\n") }] };
				} catch (e) {
					return { output: [{ type: "text", text: "搜索失败：" + String(e).slice(0, 200) }] };
				}
			},
		}),
		defineTool({
			name: "web_fetch_page",
			description:
				"抓取网页并返回干净的 Markdown 正文（DeepSeek Fetch API，可处理部分反爬站点）。http_fetch 抓到的是 HTML 乱码或空内容时改用本工具。",
			parameters: Type.Object({ url: Type.String({ description: "完整的 http(s) URL" }) }),
			execute: async (args) => {
				const url = String((args as { url?: unknown }).url ?? "").trim();
				if (!/^https?:\/\//.test(url)) return { output: [{ type: "text", text: "URL 必须以 http(s):// 开头。" }] };
				if (getSetting("web_search", "1") !== "1") {
					return { output: [{ type: "text", text: "网页搜索当前未开启。请告诉用户：在 设置 → 网页搜索 中开启后即可抓取网页。" }] };
				}
				if (!apiKeyRef) return { output: [{ type: "text", text: "未配置 DEEPSEEK_API_KEY，无法抓取网页。" }] };
				try {
					const resp = await fetch("https://api.deepseek.com/v1/tools/fetch", {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${apiKeyRef}` },
						body: JSON.stringify({ url }),
					});
					const data = (await resp.json().catch(() => null)) as { title?: string; content?: string; error?: { message?: string } } | null;
					if (!resp.ok) {
						const msg = data?.error?.message ?? `HTTP ${resp.status}`;
						return { output: [{ type: "text", text: `抓取失败：${msg}` }] };
					}
					const title = String(data?.title ?? "").trim();
					const content = String(data?.content ?? "").trim();
					if (!content) return { output: [{ type: "text", text: "页面没有可提取的正文。" }] };
					return { output: [{ type: "text", text: (title ? `# ${title}\n\n` : "") + content.slice(0, 8000) }] };
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

/** 带审批闸门的扩展（v0.33.0）：工具名与描述不变，只在 execute 外按 read/write/exec 策略判断。 */
const spikeExtension = {
	...baseSpikeExtension,
	tools: (baseSpikeExtension.tools ?? []).map((tool) => withApproval(tool as never)),
};

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

/** 社区技能目录（badlogic/pi-skills）与从 URL 导入的解析逻辑。 */
const COMMUNITY_SKILLS = [
	{ name: "brave-search", description: "通过 Brave Search API 搜索网页与提取正文", needsLocal: false },
	{ name: "youtube-transcript", description: "抓取 YouTube 视频字幕用于总结分析", needsLocal: false },
	{ name: "browser-tools", description: "通过 Chrome DevTools 协议做浏览器自动化", needsLocal: true },
	{ name: "transcribe", description: "本地语音转写（Apple Silicon / ffmpeg）", needsLocal: true },
	{ name: "gdcli", description: "Google Drive 命令行（列目录/上传/下载/分享）", needsLocal: true },
	{ name: "gccli", description: "Google Calendar 命令行（查看/创建事件）", needsLocal: true },
	{ name: "gmcli", description: "Gmail 命令行（搜索/读信/发信）", needsLocal: true },
	{ name: "vscode", description: "VS Code 集成（查看 diff / 比较文件）", needsLocal: true },
];
const COMMUNITY_RAW_BASE = "https://raw.githubusercontent.com/badlogic/pi-skills/main";

/** 把 GitHub 页面链接/目录链接统一成 SKILL.md 的 raw 地址。 */
function normalizeSkillUrl(input: string): string | null {
	const url = input.trim();
	if (!/^https?:\/\//.test(url)) return null;
	let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/.exec(url);
	if (m) {
		const [, owner, repo, branch, path] = m;
		const clean = path!.replace(/\/+$/, "");
		const file = /\.md$/i.test(clean) ? clean : `${clean}/SKILL.md`;
		return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`;
	}
	m = /^https?:\/\/raw\.githubusercontent\.com\/.+$/.exec(url);
	if (m) return /\.[a-z]+$/i.test(url) ? url : `${url.replace(/\/+$/, "")}/SKILL.md`;
	if (/\.md$/i.test(url)) return url;
	return `${url.replace(/\/+$/, "")}/SKILL.md`;
}

/** 解析 SKILL.md 的 YAML frontmatter（只取 name / description）。 */
function parseFrontmatter(text: string): { name: string; description: string; body: string } {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { name: "", description: "", body: text.trim() };
	const header = match[1] ?? "";
	const body = text.slice(match[0].length).trim();
	const read = (key: string) => {
		const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
		const hit = re.exec(header);
		if (!hit) return "";
		return (hit[1] ?? "").trim().replace(/^["']|["']$/g, "");
	};
	return { name: read("name"), description: read("description"), body };
}

/** 工具搜索扩展：模型先搜再加载被延迟的工具（v0.13.0）。 */
const baseToolSearchExtension = createToolSearchExtension();
const toolSearchExtension = {
	...baseToolSearchExtension,
	tools: (baseToolSearchExtension.tools ?? []).map((tool) => withApproval(tool as never)),
};
/** MCP 工具总数达到该阈值时改为延迟披露，避免工具列表撑爆上下文。 */
const DEFER_MCP_THRESHOLD = 12;

/** 可选模型（pi-ai deepseek provider 的目录）。 */
const AVAILABLE_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const DEFAULT_MODEL_ID = "deepseek-flash";

/** Code mode 扩展：单例即可（沙箱无状态，脚本每次执行新建 VM）。 */
const baseCodemodeExtension = createCodemodeExtension({
	sandbox: createInlineCodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }),
	models: false,
});
/** 同样套审批闸门（v0.33.0）：codemode 属 exec 级。 */
const codemodeExtension = {
	...baseCodemodeExtension,
	tools: (baseCodemodeExtension.tools ?? []).map((tool) => withApproval(tool as never)),
};

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
	const defer = total > DEFER_MCP_THRESHOLD;

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
	// MCP 工具默认按写入处理（外部服务可能有副作用），统一套审批闸门（v0.33.0）
	return defineExtension({ name: "mcp", tools: tools.map((tool) => withApproval(tool as never)) });
}

export class SpikeAgent extends DurableObject {
	/** pi-durable 的存储句柄，用来枚举会话（Harness 本身不提供列表 API）。 */
	/** 正在跑对话的会话 id，用于避免定时任务与用户对话并发。 */
	private activeChats = new Set<string>();
	/** MCP 扩展：构建一次后常驻，避免每轮重连造成工具列表抖动。 */
	private mcpExt: { name: string; tools?: unknown[] } | null = null;
	/** 自定义工具扩展（v0.36.0）：增删后重建并重新 install。 */
	private customExt: { name: string; tools?: unknown[] } | null = null;
	/** 注册表引用：MCP 扩展在运行时安装（install 按名替换）。 */
	private registryRef: { install(ext: unknown): void; snapshot(): { installed(): readonly { name: string }[] } } | null = null;
	private storageRef: { scanConversations(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> } | null = null;

	private harness: Harness | null = null;

	private async open(): Promise<Harness> {
		if (!this.harness) {
			const models = createModels();
			// v0.27.0：启用自定义供应商时用它，否则回落到 DeepSeek 官方（env DEEPSEEK_API_KEY）
			const activeId = activeProviderId();
			const providerRow = activeId ? listProviderRows().find((r) => r.id === activeId) : undefined;
			if (providerRow) models.setProvider(buildCustomProvider(providerRow) as never);
			else models.setProvider(deepseekProvider());
			apiKeyRef = (this.env as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY ?? null;
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
			// 自定义工具（v0.36.0）：同样必须在 Harness.open 之前 install
			this.customExt = buildCustomToolsExtension(sqlFacade!) as never;
			if (this.customExt) registry.install(this.customExt as never);
			this.harness = await Harness.open(storage, { models, registry, settings: { compaction: compactionSettings() } }, ctx);
			harnessRef = this.harness as never;
			this.harness.resume();
		}
		return this.harness;
	}

	async chat(
		message: string,
		sessionId?: string,
		images?: string[],
	): Promise<{ answer: string; tools: { name: string; summary: string }[] }> {
		const key = sessionId || "1";
		this.activeChats.add(key);
		try {
			return await this.runChat(message, sessionId, images);
		} catch (err) {
			if (/SessionFailed|storage error/i.test(String(err))) await this.recoverSession();
			throw err;
		} finally {
			this.activeChats.delete(key);
		}
	}

	private async runChat(
		message: string,
		sessionId?: string,
		images?: string[],
	): Promise<{ answer: string; tools: { name: string; summary: string }[] }> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		// 显式技能调用（v0.23.0）：/技能名 命中后把技能正文注入本轮 instructions
		const inv = this.skillInvocation(message);
		const effectiveMessage = inv ? inv.rest || `请按技能「${inv.name}」执行。` : message;
		// 会话首次创建后 agent 选择会固化在 pi.agent 文档里；幂等重设，保证新扩展开关对老会话也生效。
		await root.configure(
			{
				model: { provider: this.providerId(), modelId: this.modelFor(sessionId) },
				// 思考档位（v0.22.0）：off 时不产生 thinking 事件，前端自然不显示思考块。
				thinkingLevel: currentThinkingLevel(),
				extensions: this.agentExtensions() as never,
				instructions: this.buildInstructions(inv, sessionId),
			},
			ctx,
		);
		const dbgAgent = await root.agent(ctx);
		console.log("CHAT_TOOLS", JSON.stringify(dbgAgent.tools.map((t) => (t as { name?: string }).name)));
		// 记录本轮起点：之后只把新增条目里的工具结果算作本轮工具活动。
		const before = await root.entries({}, 1, undefined, ctx);
		const beforeId = (before.items[0] as unknown as { id?: number } | undefined)?.id ?? 0;
		// 转录里保留「/技能名」原文（与气泡一致），技能正文只进本轮 instructions
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
					id, effectiveMessage.slice(0, 24), now, now,
				);
			} else {
				sqlFacade!.exec("UPDATE sessions_meta SET updated_at = ? WHERE id = ?", now, id);
			}
		} catch (e) {
			console.warn("session meta update failed", e);
		}
		const page2 = await root.entries({}, 60, undefined, ctx);		const lastId = Number((page2.items[0] as unknown as { id?: number } | undefined)?.id ?? 0);
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
	private providerId(): string {
		return activeProviderId() || DEFAULT_PROVIDER.id;
	}

	/** 当前供应商的第一个模型。 */
	private defaultModelId(): string {
		return activeModelIds()[0] ?? DEFAULT_MODEL_ID;
	}

	private modelFor(sessionId?: string): string {
		const available = activeModelIds();
		if (!sessionId) return available[0] ?? DEFAULT_MODEL_ID;
		try {
			const row = sqlFacade!.exec("SELECT model FROM sessions_meta WHERE id = ?", sessionId).toArray() as { model?: string }[];
			const model = row[0]?.model;
			return model && available.includes(model) ? model : (available[0] ?? DEFAULT_MODEL_ID);
		} catch {
			return available[0] ?? DEFAULT_MODEL_ID;
		}
	}

	/** 本轮要装的扩展：内置 + MCP + 自定义工具（后两者可为空）。 */
	private agentExtensions(): unknown[] {
		const list: unknown[] = [spikeExtension, codemodeExtension, toolSearchExtension];
		const mcp = this.mcpExt as { tools?: unknown[] } | null;
		if (mcp && (mcp.tools?.length ?? 0) > 0) list.push(mcp);
		const custom = this.customExt as { tools?: unknown[] } | null;
		if (custom && (custom.tools?.length ?? 0) > 0) list.push(custom);
		return list;
	}

	private async conversationFor(harness: Awaited<ReturnType<typeof this.open>>, sessionId?: string) {
		const agentChange = {
			model: { provider: this.providerId(), modelId: this.modelFor(sessionId) },
			extensions: this.agentExtensions() as never,
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
				agent: { model: { provider: this.providerId(), modelId: this.defaultModelId() }, extensions: this.agentExtensions() as never },
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

	/**
	 * 会话分支（v0.32.0）：在指定消息**之前**分叉出一个新会话。
	 * pi-durable 的 fork 共享分叉点之前的历史，之后各自追加，互不影响。
	 * 取「这条消息之前的最新一条」作为分叉点，这样新会话的历史停在上一条，用户可以直接问别的。
	 */
	async forkSession(sessionId: string, entryId: number, title?: string): Promise<{ id: string; title: string }> {
		const harness = await this.open();
		const parent = await this.conversationFor(harness, sessionId);
		const typed = parent as unknown as {
			id: number;
			entries(q: object, limit: number, cursor: undefined, c: unknown): Promise<{ items: readonly { id?: unknown }[] }>;
			fork(at: number, options: { ownership: { kind: string } }, c: unknown): Promise<{ id: unknown }>;
		};
		const before = await typed.entries({ maxEntryId: entryId - 1 }, 1, undefined, ctx);
		const at = Number((before.items[0] as { id?: unknown } | undefined)?.id);
		if (!Number.isFinite(at) || at <= 0) throw new Error("这条消息之前没有历史，无法分叉");
		const fork = await typed.fork(at, { ownership: { kind: "ownerless" } }, ctx);
		const parentRow = sqlFacade!.exec("SELECT title FROM sessions_meta WHERE id = ?", String(typed.id)).toArray() as { title?: string }[];
		const now = new Date().toISOString();
		const fallback = `⑂ ${parentRow[0]?.title || `会话 ${typed.id}`}`;
		const finalTitle = (title ?? "").trim().slice(0, 60) || fallback;
		sqlFacade!.exec(
			`INSERT INTO sessions_meta (id, title, created_at, updated_at, model, parent_id, fork_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET title = excluded.title, parent_id = excluded.parent_id, fork_at = excluded.fork_at, updated_at = excluded.updated_at`,
			String(fork.id), finalTitle, now, now, this.modelFor(sessionId), String(typed.id), at,
		);
		return { id: String(fork.id), title: finalTitle };
	}

	/** 会话列表：元数据表为准，缺失的从存储枚举补齐（含根会话）。 */
	async listSessions(): Promise<{
		sessions: { id: string; title: string; created_at: string; updated_at: string; model?: string; parent_id?: string | null; fork_at?: number | null }[];
	}> {
		ensureTables(sqlFacade!);
		const harness = await this.open();
		const root = await harness.root(ctx);
		const rows = sqlFacade!.exec(
			"SELECT id, title, created_at, updated_at, model, parent_id, fork_at FROM sessions_meta WHERE deleted = 0 AND hidden = 0 ORDER BY updated_at DESC",
		).toArray() as {
			id: string; title: string; created_at: string; updated_at: string; model?: string; parent_id?: string | null; fork_at?: number | null;
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

	/** 识别消息开头的「/技能名」（v0.23.0）：命中已安装技能时返回技能正文与去掉前缀的正文。 */
	private skillInvocation(message: string): { name: string; content: string; rest: string } | null {
		const trimmed = message.trimStart();
		if (!trimmed.startsWith("/")) return null;
		const match = /^\/(\S{1,60})(?:\s+([\s\S]*))?$/.exec(trimmed);
		if (!match) return null;
		try {
			const rows = sqlFacade!.exec("SELECT name, content FROM skills WHERE name = ?", match[1]!).toArray() as {
				name: string;
				content: string;
			}[];
			if (!rows[0]) return null;
			return { name: rows[0].name, content: rows[0].content, rest: (match[2] ?? "").trim() };
		} catch {
			return null;
		}
	}

	/** 组装本轮 instructions：基础规则 + 技能索引 + 可选显式技能正文 + 进行中的目标。 */
	private buildInstructions(inv: { name: string; content: string } | null, sessionId?: string): string {
		const base =
			"你在 pi-harness（GitHub: scudong/pi-harness）里运行：一个部署在 Cloudflare Workers 上的 pi-durable harness。GitHub 上另有同名项目（如 wangmiaozero/pi-harness），被问到本项目时以 scudong/pi-harness 为准，不要混为一谈。\n" +
			"凡是需要计算、批量处理、解析或转换数据时，必须调用 codemode 工具写 JavaScript 执行（脚本内可用 await tools.<name>(args) 调用其它工具），不要心算或声称没有该工具。";
		const withSkills = this.instructionsWithSkills(base);
		const goal = sessionId ? readGoalRow(sessionId) : null;
		const goalBlock =
			goal && goal.status === "active"
				? `\n\n## 目标模式（进行中）\n目标：${goal.objective}\n进度：第 ${goal.turns + 1} 轮，已用 ${goal.tokens_used} / ${goal.token_budget} tokens。\n- 这一轮必须有实际进展，不要只回复「继续」。\n- 全部达成后调用 complete_goal，并附可核对的证据。\n- 确实无法推进时调用 report_goal 说明阻塞原因。`
				: "";
		if (!inv) return withSkills + goalBlock;
		return `${withSkills}${goalBlock}\n\n## 用户显式调用的技能：${inv.name}\n下面是该技能的完整说明，请严格按照它执行，不要声称找不到该技能：\n\n${inv.content}`;
	}

	/** 会话存储出错后重建 Harness（pi-durable 要求 close + reopen）。 */
	async recoverSession(): Promise<void> {
		try {
			if (this.harness) await this.harness.close(ctx).catch(() => {});
		} catch {
			// 关闭失败也继续重建
		}
		this.harness = null;
	}

	/** 下一次闹钟时间：定时任务与待续转目标里最早的一个。 */
	private async scheduleNextAlarm(): Promise<void> {
		try {
			const rows = sqlFacade!
				.exec(
					`SELECT MIN(t) AS next FROM (
						SELECT MIN(next_run_at) AS t FROM automations WHERE enabled = 1 AND next_run_at > 0
						UNION ALL
						SELECT MIN(next_run_at) FROM goals WHERE status = 'active' AND next_run_at > 0
					)`,
				)
				.toArray() as { next: number | null }[];
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
					// 会话正忙时跳过这一轮，避免并发 submit 破坏会话状态（v0.17.1）
					if (this.activeChats.has(job.session_id || "1")) {
						sqlFacade!.exec("UPDATE automations SET next_run_at = ? WHERE id = ?", now + 5 * 60_000, job.id);
						continue;
					}
					await this.chat(job.prompt, job.session_id || undefined);
				} catch (err) {
					console.warn(`automation ${job.id} failed`, String(err).slice(0, 200));
					await this.recoverSession();
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

			// 目标自动续转（v0.31.0）：到点的目标推进一轮
			const dueGoals = sqlFacade!
				.exec("SELECT session_id FROM goals WHERE status = 'active' AND next_run_at > 0 AND next_run_at <= ?", now)
				.toArray() as { session_id: string }[];
			for (const goal of dueGoals) {
				if (this.activeChats.has(goal.session_id)) {
					writeGoal(goal.session_id, { next_run_at: now + 60_000 });
					continue;
				}
				try {
					this.activeChats.add(goal.session_id);
					await this.goalTick(goal.session_id);
				} catch (err) {
					console.warn(`goal ${goal.session_id} tick failed`, String(err).slice(0, 200));
					await this.recoverSession();
					writeGoal(goal.session_id, { next_run_at: now + 60_000 });
				} finally {
					this.activeChats.delete(goal.session_id);
				}
			}
		} catch (err) {
			console.warn("alarm failed", err);
		}
		await this.scheduleNextAlarm();
	}

	/** 已安装技能清单（name + description），供提示词索引与工具使用。 */
	private skillIndex(): { name: string; description: string }[] {
		try {
			return sqlFacade!.exec("SELECT name, description FROM skills ORDER BY name").toArray() as {
				name: string;
				description: string;
			}[];
		} catch {
			return [];
		}
	}

	/** 技能索引注入到 instructions：模型知道有哪些技能，按需 load_skill。 */
	private instructionsWithSkills(base: string): string {
		let out = base;
		const index = this.skillIndex();
		if (index.length) {
			const lines = index.map((s) => `- ${s.name}：${s.description || "（无描述）"}`).join("\n");
			out = `${out}\n\n可用技能（需要时调用 load_skill 读取完整说明后再执行）：\n${lines}`;
		}
		// 网页搜索开启时才在提示词里引导模型使用；关闭时工具会返回开启指引。
		if (getSetting("web_search", "1") === "1") {
			out += "\n需要联网查资料时优先用 web_search 搜索、web_fetch_page 抓取正文（比 http_fetch 更干净）。";
		}
		// 分步计划（v0.22.0）：多步任务先 update_plan，用户在聊天里实时看到清单。
		out +=
			"\n任务需要 3 步以上（多次检索、多文件产出、先计算后写作等）时，先用 update_plan 列出步骤并在每完成一步后更新；单步问题不要调用它。";
		// 规则文件（v0.31.0）：用户维护的项目约定，每轮注入
		const rules = enabledRules();
		if (rules.length) {
			out += "\n\n## 项目规则（必须遵守）\n" + rules.map((r) => `- ${r}`).join("\n");
		}
		// 子代理（v0.29.0）：可并行的独立子任务交给它们
		out +=
			"\n当有 2–4 个**互不依赖**的子任务（如分别调研几个对象再做对比）时，用 dispatch_tasks 并行分派给子代理，比串行逐个做更快；子代理看不到主对话，每个 prompt 要自包含。";
		return out;
	}

	/**
	 * 生成中插话（v0.34.0）：把消息以 steer 方式提交，模型在当前这轮的下一个边界
	 * （通常是下一次工具调用之后）就会看到；会话空闲时等同普通发送。
	 */
	async interject(message: string, sessionId?: string): Promise<{ ok: true; id: string }> {
		const text = message.trim();
		if (!text) throw new Error("插话内容不能为空");
		const harness = await this.open();
		const conversation = await this.conversationFor(harness, sessionId);
		const submission = await (conversation as unknown as {
			submit(draft: unknown, c: unknown): Promise<{ id: unknown }>;
		}).submit({ type: "input", content: userContent(text, undefined), whenBusy: "steer" }, ctx);
		return { ok: true, id: String(submission.id) };
	}

	/** 真正中止服务端生成（v0.19.0）：撤回排队输入并等待会话空闲。 */
	async abort(sessionId?: string): Promise<{ ok: true }> {
		const harness = await this.open();
		const conversation = await this.conversationFor(harness, sessionId);
		await conversation.abort(ctx);
		return { ok: true };
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
				skills: q("SELECT name, description, content FROM skills ORDER BY name"),
				settings: q("SELECT key, value FROM app_settings"),
				plans: q("SELECT conversation_id, steps, updated_at FROM plans"),
				providers: q("SELECT id, name, base_url, api_key, models FROM providers"),
				prompts: q("SELECT name, description, content FROM prompts"),
				rules: q("SELECT name, content, enabled FROM rules"),
				goals: q("SELECT session_id, objective, status, token_budget, baseline_tokens, tokens_used, turns, max_turns, summary, next_run_at, created_at, updated_at FROM goals"),
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
		for (const k of rows("skills")) {
			const name = str(k.name).trim();
			if (!name) continue;
			sqlFacade!.exec(
				"INSERT INTO skills (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
				name, str(k.description), str(k.content), new Date().toISOString(),
			);
			counts.skills = (counts.skills ?? 0) + 1;
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
		for (const s of rows("settings")) {
			const key = str(s.key).trim();
			if (!key) continue;
			setSetting(key, str(s.value));
			counts.settings = (counts.settings ?? 0) + 1;
		}
		for (const pr of rows("prompts")) {
			const name = str(pr.name).trim();
			if (!name) continue;
			sqlFacade!.exec(
				"INSERT INTO prompts (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
				name, str(pr.description), str(pr.content), new Date().toISOString(),
			);
			counts.prompts = (counts.prompts ?? 0) + 1;
		}
		for (const rl of rows("rules")) {
			const name = str(rl.name).trim();
			if (!name) continue;
			sqlFacade!.exec(
				"INSERT INTO rules (name, content, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content, enabled = excluded.enabled",
				name, str(rl.content), num(rl.enabled) ? 1 : 0, new Date().toISOString(),
			);
			counts.rules = (counts.rules ?? 0) + 1;
		}
		for (const g of rows("goals")) {
			const sid = str(g.session_id).trim();
			const objective = str(g.objective).trim();
			if (!sid || !objective) continue;
			sqlFacade!.exec(
				`INSERT INTO goals (session_id, objective, status, token_budget, baseline_tokens, tokens_used, turns, max_turns, summary, next_run_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET objective = excluded.objective, status = excluded.status, token_budget = excluded.token_budget, baseline_tokens = excluded.baseline_tokens, tokens_used = excluded.tokens_used, turns = excluded.turns, max_turns = excluded.max_turns, summary = excluded.summary, next_run_at = excluded.next_run_at`,
				sid, objective, str(g.status) || "paused", num(g.token_budget) || GOAL_TOKEN_BUDGET_DEFAULT,
				num(g.baseline_tokens), num(g.tokens_used), num(g.turns), num(g.max_turns) || GOAL_MAX_TURNS_DEFAULT,
				str(g.summary), num(g.next_run_at), str(g.created_at) || new Date().toISOString(), new Date().toISOString(),
			);
			counts.goals = (counts.goals ?? 0) + 1;
		}
		for (const p of rows("providers")) {
			const pid = str(p.id).trim();
			if (!pid) continue;
			sqlFacade!.exec(
				"INSERT INTO providers (id, name, base_url, api_key, models, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key, models = excluded.models",
				pid, str(p.name), str(p.base_url), str(p.api_key), str(p.models), new Date().toISOString(),
			);
			counts.providers = (counts.providers ?? 0) + 1;
		}
		for (const p of rows("plans")) {
			const cid = str(p.conversation_id);
			if (!cid) continue;
			sqlFacade!.exec(
				"INSERT INTO plans (conversation_id, steps, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET steps = excluded.steps",
				cid, str(p.steps) || "[]", str(p.updated_at) || new Date().toISOString(),
			);
			counts.plans = (counts.plans ?? 0) + 1;
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
		// 恢复后可能带回进行中的目标：重排闹钟
		await this.scheduleNextAlarm();
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

	/** 会话累计 token（pi.usage 的 models + tools 两个桶）。 */
	private async goalTokens(harness: Awaited<ReturnType<typeof this.open>>, conversationId: unknown): Promise<number> {
		try {
			const usage = await (harness as unknown as {
				snapshot(
					token: unknown,
					id: unknown,
					c: unknown,
				): Promise<{ models?: Record<string, { totalTokens?: number }>; tools?: Record<string, { totalTokens?: number }> } | undefined>;
			}).snapshot(UsageDoc, conversationId, ctx);
			let total = 0;
			for (const bucket of [usage?.models, usage?.tools]) {
				if (!bucket) continue;
				for (const u of Object.values(bucket)) total += Number(u?.totalTokens ?? 0);
			}
			return total;
		} catch {
			return 0;
		}
	}

	/**
	 * 同步目标进度（每轮结束后调用）：把会话累计 token 折算成目标消耗，累加轮次，
	 * 到预算/轮次上限就自动收尾（exhausted）。
	 */
	private async syncGoalProgress(
		harness: Awaited<ReturnType<typeof this.open>>,
		conversationId: unknown,
		sessionId: string,
		incrementTurn: boolean,
	): Promise<GoalRow | null> {
		const row = readGoalRow(sessionId);
		if (!row) return null;
		const total = await this.goalTokens(harness, conversationId);
		// baseline = -1 表示目标由模型在对话中途建立：第一次同步以当前累计值为起点，不计之前的花费。
		const baseline = row.baseline_tokens < 0 ? total : row.baseline_tokens;
		const used = total > 0 ? Math.max(0, total - baseline) : row.tokens_used;
		const turns = row.turns + (incrementTurn ? 1 : 0);
		if (row.status !== "active") {
			// 已经结束的目标只补记本轮消耗，不再改变状态
			writeGoal(sessionId, { baseline_tokens: baseline, tokens_used: used, turns });
			return { ...row, baseline_tokens: baseline, tokens_used: used, turns };
		}
		let status: GoalStatus = "active";
		if (used >= row.token_budget || turns >= row.max_turns) status = "exhausted";
		const nextRunAt = status === "active" ? row.next_run_at : 0;
		writeGoal(sessionId, { baseline_tokens: baseline, tokens_used: used, turns, status, next_run_at: nextRunAt });
		return { ...row, baseline_tokens: baseline, tokens_used: used, turns, status, next_run_at: nextRunAt };
	}

	/** alarm 用：为目标推进一轮（跨请求续转）。 */
	private async goalTick(sessionId: string): Promise<void> {
		const row = readGoalRow(sessionId);
		if (!row || row.status !== "active") return;
		writeGoal(sessionId, { next_run_at: 0 });
		const harness = await this.open();
		const conversation = await this.conversationFor(harness, sessionId);
		await this.chat(goalContinuePrompt(row), sessionId);
		const updated = await this.syncGoalProgress(harness, conversation.id, sessionId, true);
		if (updated?.status === "active") {
			writeGoal(sessionId, { next_run_at: Date.now() + 15_000 });
		}
	}

	/** 流式聊天：SSE 推送 text delta / 工具开始结束 / 最终 done。 */
	async chatStream(message: string, sessionId?: string, images?: string[]): Promise<Response> {
		const key = sessionId || "1";
		this.activeChats.add(key);
		try {
			return await this.runChatStream(message, sessionId, images);
		} catch (err) {
			if (/SessionFailed|storage error/i.test(String(err))) await this.recoverSession();
			throw err;
		} finally {
			this.activeChats.delete(key);
		}
	}

	private async runChatStream(message: string, sessionId?: string, images?: string[]): Promise<Response> {
		const harness = await this.open();
		const root = await this.conversationFor(harness, sessionId);
		const inv = this.skillInvocation(message);
		const effectiveMessage = inv ? inv.rest || `请按技能「${inv.name}」执行。` : message;
		await root.configure(
			{
				model: { provider: this.providerId(), modelId: this.modelFor(sessionId) },
				thinkingLevel: currentThinkingLevel(),
				extensions: this.agentExtensions() as never,
				instructions: this.buildInstructions(inv, sessionId),
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
							// 思考过程（v0.22.0）：模型开 reasoning 时逐字推送
							if (change.type === "thinking_delta" && change.delta) await send("thinking", { delta: change.delta });
							else if (change.type === "thinking_start") await send("thinking_start", {});
							else if (change.type === "text_delta" && change.delta) await send("text", { delta: change.delta });
						}
					} else if (e.type === "compaction_start") {
						await send("compaction", { status: "start" });
					} else if (e.type === "compaction_end") {
						await send("compaction", { status: "end" });
					} else if (e.type === "tool_execution_start") {
						const call = e as unknown as { toolName?: string; toolCallId?: string; parentToolCallId?: string; args?: unknown };
						await send("tool_start", {
							name: call.toolName ?? "tool",
							id: call.toolCallId,
							parentId: call.parentToolCallId,
							args: call.args,
						});
					} else if (e.type === "tool_execution_end") {
						const call = e as unknown as {
							toolName?: string;
							toolCallId?: string;
							parentToolCallId?: string;
							result?: { summary?: unknown };
						};
						await send("tool_end", {
							name: call.toolName ?? "tool",
							id: call.toolCallId,
							parentId: call.parentToolCallId,
							summary: typeof call.result?.summary === "string" ? call.result.summary : undefined,
						});
					}
				}
			});
			try {
				const sid = String(root.id);
				let answer = "";
				let prompt = message;
				let promptImages: string[] | undefined = images;
				let round = 0;
				// 目标模式（v0.31.0）：一轮结束且目标仍在进行时自动续转，最多 3 轮/请求，其余交给 alarm。
				for (;;) {
					const submission = await root.submit({ type: "input", content: userContent(prompt, promptImages) as never }, ctx);
					const settled = await submission.wait(ctx);
					if (settled.status !== "done" || settled.type !== "input") {
						await send("error", { message: `运行未完成：${JSON.stringify(settled).slice(0, 200)}` });
						break;
					}
					const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
					const c = entry?.model?.[0]?.content;
					answer =
						typeof c === "string"
							? c
							: Array.isArray(c)
								? c.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("")
								: "";
					round++;
					const goal = readGoalRow(sid);
					if (!goal) break;
					const updated = await this.syncGoalProgress(harness, root.id, sid, true);
					if (!updated) break;
					if (updated.status !== "active") {
						await send("goal", { goal: goalInfo(updated), finished: true });
						break;
					}
					if (round >= GOAL_ROUNDS_PER_REQUEST) {
						writeGoal(sid, { next_run_at: Date.now() + 15_000 });
						await this.scheduleNextAlarm();
						await send("goal", { goal: goalInfo(readGoalRow(sid)), scheduled: true });
						break;
					}
					await send("goal", { goal: goalInfo(updated), continuing: true, round });
					prompt = goalContinuePrompt(updated);
					promptImages = undefined;
				}
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
				// 标题/时间维护
				try {
					const id = String(root.id);
					const now = new Date().toISOString();
					const meta = sqlFacade!.exec("SELECT title FROM sessions_meta WHERE id = ?", id).toArray() as { title: string }[];
					const title = meta[0]?.title;
					if (!title || title === "新会话" || /^会话 \d+$/.test(title)) {
						sqlFacade!.exec(
							"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
							id, effectiveMessage.slice(0, 24), now, now,
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
				if (!this.customExt) this.customExt = buildCustomToolsExtension(sqlFacade!) as never;
				await root.configure({ extensions: this.agentExtensions() as never }, ctx);
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
					customToolCount: (this.customExt as { tools?: unknown[] } | null)?.tools?.length ?? 0,
					installed: this.registryRef?.snapshot().installed().map((e) => e.name) ?? null,
				});
			}
			if (request.method === "GET" && url.pathname === "/sessions") {
				return Response.json(await this.listSessions());
			}
			if (request.method === "POST" && url.pathname === "/sessions") {
				return Response.json(await this.newSession());
			}
			/* ---- 会话分支（v0.32.0）：从某条历史消息分叉 ---- */
			if (request.method === "POST" && url.pathname === "/branches") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string; entryId?: number; title?: string };
				const entryId = Math.floor(Number(body.entryId));
				if (!Number.isFinite(entryId) || entryId <= 0) {
					return Response.json({ error: "缺少有效的 entryId" }, { status: 400 });
				}
				try {
					const created = await this.forkSession(String(body.sessionId ?? "1"), entryId, body.title);
					return Response.json({ ok: true, ...created });
				} catch (err) {
					return Response.json({ error: `分支创建失败：${String(err).slice(0, 200)}` }, { status: 400 });
				}
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
				// 目标随会话一起停止，避免继续消耗 token（v0.31.0）
				try {
					writeGoal(id, { status: "paused", next_run_at: 0 });
				} catch {
					// 没有目标时忽略
				}
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
			if (url.pathname === "/skills/community" && request.method === "GET") {
				return Response.json({
					source: "https://github.com/badlogic/pi-skills",
					skills: COMMUNITY_SKILLS.map((item) => ({ ...item, url: `${COMMUNITY_RAW_BASE}/${item.name}/SKILL.md` })),
				});
			}
			if (url.pathname === "/skills/import" && request.method === "POST") {
				const body = (await request.json()) as { url?: string };
				const target = normalizeSkillUrl(body.url ?? "");
				if (!target) return Response.json({ error: "需要 http(s) 链接" }, { status: 400 });
				let text = "";
				try {
					const resp = await fetch(target, { headers: { "user-agent": "pi-harness-skill-import" } });
					if (!resp.ok) return Response.json({ error: `抓取失败：HTTP ${resp.status}` }, { status: 400 });
					text = await resp.text();
				} catch (err) {
					return Response.json({ error: `抓取失败：${String(err).slice(0, 120)}` }, { status: 400 });
				}
				if (!text.trim()) return Response.json({ error: "内容为空" }, { status: 400 });
				const parsed = parseFrontmatter(text);
				const fallbackName = (target.split("/").slice(-2, -1)[0] ?? "imported-skill").toLowerCase();
				const name = (parsed.name || fallbackName).slice(0, 40);
				const description = parsed.description || "（从社区导入，未提供描述）";
				ensureTables(sqlFacade!);
				sqlFacade!.exec(
					"INSERT INTO skills (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
					name, description.slice(0, 200), (parsed.body || text).slice(0, 200_000), new Date().toISOString(),
				);
				return Response.json({ ok: true, name, description, source: target });
			}
			if (url.pathname === "/skills" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!.exec("SELECT name, description, content, created_at FROM skills ORDER BY name").toArray();
				return Response.json({ skills: rows });
			}
			if (url.pathname === "/skills" && request.method === "POST") {
				const body = (await request.json()) as { name?: string; description?: string; content?: string };
				const name = (body.name ?? "").trim().slice(0, 40);
				const content = (body.content ?? "").trim();
				if (!name || !content) return Response.json({ error: "需要名称与内容" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec(
					"INSERT INTO skills (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
					name, (body.description ?? "").trim().slice(0, 120), content, new Date().toISOString(),
				);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/skills" && request.method === "DELETE") {
				ensureTables(sqlFacade!);
				sqlFacade!.exec("DELETE FROM skills WHERE name = ?", url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			if (url.pathname === "/abort" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
				return Response.json(await this.abort(body.sessionId));
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
			/* ---- 提示模板（v0.31.0） ---- */
			if (url.pathname === "/prompts" && request.method === "GET") {
				ensureTables(sqlFacade!);
				return Response.json({ prompts: listPrompts() });
			}
			if (url.pathname === "/prompts" && request.method === "POST") {
				const body = (await request.json()) as { name?: string; description?: string; content?: string };
				const name = (body.name ?? "").trim().slice(0, 40);
				const content = (body.content ?? "").trim();
				if (!name || !content) return Response.json({ error: "需要名称与内容" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec(
					"INSERT INTO prompts (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
					name, (body.description ?? "").trim().slice(0, 120), content, new Date().toISOString(),
				);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/prompts" && request.method === "DELETE") {
				ensureTables(sqlFacade!);
				sqlFacade!.exec("DELETE FROM prompts WHERE name = ?", url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			/* ---- 规则文件（v0.31.0） ---- */
			if (url.pathname === "/rules" && request.method === "GET") {
				ensureTables(sqlFacade!);
				return Response.json({ rules: listRules().map((r) => ({ ...r, enabled: Boolean(r.enabled) })) });
			}
			if (url.pathname === "/rules" && request.method === "POST") {
				const body = (await request.json()) as { name?: string; content?: string; enabled?: boolean };
				const name = (body.name ?? "").trim().slice(0, 40);
				const content = (body.content ?? "").trim();
				if (!name || !content) return Response.json({ error: "需要名称与内容" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec(
					"INSERT INTO rules (name, content, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content",
					name, content, body.enabled === false ? 0 : 1, new Date().toISOString(),
				);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/rules" && request.method === "PATCH") {
				const body = (await request.json()) as { name?: string; enabled?: boolean };
				if (!body.name) return Response.json({ error: "缺少 name" }, { status: 400 });
				ensureTables(sqlFacade!);
				sqlFacade!.exec("UPDATE rules SET enabled = ? WHERE name = ?", body.enabled ? 1 : 0, body.name);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/rules" && request.method === "DELETE") {
				ensureTables(sqlFacade!);
				sqlFacade!.exec("DELETE FROM rules WHERE name = ?", url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			/* ---- 能力注册表（v0.31.0）：把三类来源汇总成一张表 ---- */
			if (url.pathname === "/capabilities" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const settings = compactionSettings();
				const builtin = [
					{ id: "codemode", name: "Code Mode", description: "QuickJS 沙箱里写 JS 调工具", enabled: true },
					{ id: "tool_search", name: "工具搜索", description: "工具多时按需检索加载", enabled: true },
					{ id: "compaction", name: "上下文压缩", description: "接近上下文上限时自动摘要旧内容", enabled: settings.enabled, detail: `保留 ${settings.keepRecentTokens} tokens / 预留 ${settings.reserveTokens}` },
					{ id: "plan", name: "计划清单", description: "update_plan 维护分步计划", enabled: true },
					{ id: "subagents", name: "子代理", description: "dispatch_tasks 并行分派子任务", enabled: true },
					{ id: "goal", name: "目标模式", description: "目标 + token 预算 + 自动续转 + 完成校验", enabled: true },
					...((): { id: string; name: string; description: string; enabled: boolean; detail?: string }[] => {
						const a = approvalSettings();
						const on = a.read !== "allow" || a.write !== "allow" || a.exec !== "allow";
						return [{
							id: "approval",
							name: "工具审批",
							description: "read/write/exec 三档 + 逐工具覆盖",
							enabled: on,
							detail: `读 ${a.read} / 写 ${a.write} / 执行 ${a.exec}`,
						}];
					})(),
					{ id: "web_search", name: "联网搜索", description: "web_search / web_fetch_page", enabled: getSetting("web_search", "1") === "1" },
				];
				const data = [
					{ id: "skills", name: "技能", description: "SKILL.md 说明书，按需 load_skill", enabled: true, count: this.skillIndex().length },
					{ id: "prompts", name: "提示模板", description: "输入 / 展开的常用指令", enabled: true, count: listPrompts().length },
					{ id: "rules", name: "规则文件", description: "每轮注入的项目约定", enabled: true, count: listRules().filter((r) => r.enabled).length },
				];
				const protocol = [
					{ id: "mcp", name: "MCP 服务器", description: "Streamable HTTP 工具接入", enabled: true, count: sqlFacade!.exec("SELECT COUNT(*) AS n FROM mcp_servers").toArray()[0] ? Number((sqlFacade!.exec("SELECT COUNT(*) AS n FROM mcp_servers").toArray()[0] as { n: number }).n) : 0 },
					{ id: "providers", name: "模型供应商", description: "OpenAI 兼容端点", enabled: true, count: listProviderRows().length },
				];
				return Response.json({
					groups: [
						{ key: "builtin", label: "内置能力", items: builtin },
						{ key: "data", label: "数据能力", items: data },
						{ key: "protocol", label: "协议接入", items: protocol },
					],
				});
			}
			/* ---- 自定义工具（v0.36.0） ---- */
			if (url.pathname === "/custom-tools" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const rows = sqlFacade!
					.exec("SELECT name, description, parameters, code, enabled, created_at FROM custom_tools ORDER BY created_at DESC")
					.toArray();
				return Response.json({ tools: rows });
			}
			if (url.pathname === "/custom-tools" && request.method === "POST") {
				ensureTables(sqlFacade!);
				const body = (await request.json().catch(() => ({}))) as {
					name?: string;
					description?: string;
					parameters?: string;
					code?: string;
				};
				const name = String(body.name ?? "").trim();
				const code = String(body.code ?? "").trim();
				if (!CUSTOM_TOOL_NAME.test(name)) {
					return Response.json({ ok: false, error: "工具名只能字母开头，含字母数字下划线，2–41 字符" }, { status: 400 });
				}
				if (RESERVED_TOOL_NAMES.has(name)) {
					return Response.json({ ok: false, error: `「${name}」是内置工具名，换一个` }, { status: 400 });
				}
				if (!code) return Response.json({ ok: false, error: "代码不能为空" }, { status: 400 });
				if (code.length > CUSTOM_TOOL_CODE_MAX) {
					return Response.json({ ok: false, error: `代码最长 ${CUSTOM_TOOL_CODE_MAX} 字符` }, { status: 400 });
				}
				let parameters = "{\"type\":\"object\",\"properties\":{}}";
				if (body.parameters && String(body.parameters).trim()) {
					try {
						const parsed = JSON.parse(String(body.parameters)) as { type?: unknown };
						if (!parsed || typeof parsed !== "object" || parsed.type !== "object") {
							return Response.json({ ok: false, error: "参数 schema 必须是 {\"type\":\"object\", ...} 的 JSON" }, { status: 400 });
						}
						parameters = JSON.stringify(parsed);
					} catch {
						return Response.json({ ok: false, error: "参数 schema 不是合法 JSON" }, { status: 400 });
					}
				}
				sqlFacade!.exec(
					`INSERT INTO custom_tools (name, description, parameters, code, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)
					 ON CONFLICT(name) DO UPDATE SET description = excluded.description, parameters = excluded.parameters, code = excluded.code, enabled = 1`,
					name, String(body.description ?? "").trim().slice(0, 200), parameters, code, new Date().toISOString(),
				);
				this.customExt = buildCustomToolsExtension(sqlFacade!) as never;
				if (this.registryRef) this.registryRef.install(this.customExt as never);
				return Response.json({ ok: true, name, tools: (this.customExt as { tools?: unknown[] } | null)?.tools?.length ?? 0 });
			}
			if (url.pathname === "/custom-tools" && request.method === "DELETE") {
				ensureTables(sqlFacade!);
				const name = url.searchParams.get("name") ?? "";
				if (!name) return Response.json({ ok: false, error: "缺少 name" }, { status: 400 });
				sqlFacade!.exec("DELETE FROM custom_tools WHERE name = ?", name);
				this.customExt = buildCustomToolsExtension(sqlFacade!) as never;
				if (this.registryRef) this.registryRef.install(this.customExt as never);
				return Response.json({ ok: true, tools: (this.customExt as { tools?: unknown[] } | null)?.tools?.length ?? 0 });
			}
			/* ---- pi 内核版本（v0.35.0）：当前声明版本 + npm 最新版本（缓存 6 小时） ---- */
			if (url.pathname === "/kernel" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const current = declaredKernelVersions();
				const refresh = url.searchParams.get("refresh") === "1";
				const cachedAt = getSetting("kernel_checked_at", "");
				const fresh = cachedAt !== "" && Date.now() - new Date(cachedAt).getTime() < 6 * 3600_000;
				let latest: Record<string, string> = {};
				try {
					latest = JSON.parse(getSetting("kernel_latest", "{}")) as Record<string, string>;
				} catch {
					latest = {};
				}
				let checkedAt = cachedAt;
				if (refresh || !fresh) {
					const results = await Promise.all(PI_PACKAGES.map(async (name) => [name, await fetchLatestVersion(name)] as const));
					latest = {};
					for (const [name, version] of results) if (version) latest[name] = version;
					checkedAt = new Date().toISOString();
					if (Object.keys(latest).length) {
						setSetting("kernel_latest", JSON.stringify(latest));
						setSetting("kernel_checked_at", checkedAt);
					}
				}
				// 只比较声明了版本的包；传递依赖不计入「可升级」
				const outdated = PI_PACKAGES.filter(
					(name) => latest[name] && /\d/.test(current[name] ?? "") && semverGreater(latest[name]!, current[name]!),
				);
				return Response.json({
					current,
					latest,
					checkedAt,
					updateAvailable: outdated.length > 0,
					outdated,
					upgrade: {
						manual: "npm run upgrade:pi",
						auto: "每周一 09:00 UTC 自动检查并开 PR（.github/workflows/pi-upgrade.yml），也可在 Actions 里手动触发",
					},
				});
			}
			/* ---- 生成中插话（v0.34.0） ---- */
			if (url.pathname === "/interject" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string; message?: string };
				const message = String(body.message ?? "").trim();
				if (!message) return Response.json({ ok: false, error: "插话内容不能为空" }, { status: 400 });
				try {
					return Response.json(await this.interject(message, body.sessionId));
				} catch (err) {
					return Response.json({ ok: false, error: String(err).slice(0, 200) }, { status: 500 });
				}
			}
			/* ---- 工具审批（v0.33.0） ---- */
			if (url.pathname === "/approvals" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const sid = url.searchParams.get("sessionId") ?? "1";
				const rows = sqlFacade!
					.exec(
						"SELECT id, tool, category, args, created_at FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 20",
						sid,
					)
					.toArray() as { id: number; tool: string; category: string; args: string; created_at: string }[];
				return Response.json({ approvals: rows });
			}
			if (url.pathname === "/approvals" && request.method === "POST") {
				ensureTables(sqlFacade!);
				const body = (await request.json().catch(() => ({}))) as { id?: number; action?: string };
				const id = Math.floor(Number(body.id));
				const action = body.action;
				if (!Number.isFinite(id) || id <= 0) return Response.json({ ok: false, error: "缺少待审批 id" }, { status: 400 });
				if (action !== "once" && action !== "always" && action !== "deny") {
					return Response.json({ ok: false, error: "action 必须是 once / always / deny" }, { status: 400 });
				}
				const rows = sqlFacade!.exec("SELECT id, session_id, tool, status FROM approvals WHERE id = ?", id).toArray() as {
					id: number; session_id: string; tool: string; status: string;
				}[];
				const row = rows[0];
				if (!row) return Response.json({ ok: false, error: "待审批不存在" }, { status: 404 });
				if (row.status === "pending") {
					const now = new Date().toISOString();
					if (action === "deny") {
						sqlFacade!.exec("UPDATE approvals SET status = 'denied', decided_at = ? WHERE id = ?", now, id);
						sqlFacade!.exec("DELETE FROM approval_grants WHERE session_id = ? AND tool = ?", row.session_id, row.tool);
					} else {
						sqlFacade!.exec("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?", now, id);
						sqlFacade!.exec(
							`INSERT INTO approval_grants (session_id, tool, uses, created_at) VALUES (?, ?, ?, ?)
							 ON CONFLICT(session_id, tool) DO UPDATE SET uses = CASE WHEN approval_grants.uses < 0 THEN -1 ELSE excluded.uses END`,
							row.session_id, row.tool, action === "always" ? -1 : 1, now,
						);
					}
				}
				const resume =
					action === "deny"
						? `用户拒绝了对工具「${row.tool}」的调用，请不要再用它，改换方案或向用户说明。`
						: `已批准工具「${row.tool}」（${action === "always" ? "以后允许" : "本次"}），请继续刚才的操作。`;
				return Response.json({ ok: true, id, action, tool: row.tool, resume });
			}
			if (url.pathname === "/tools" && request.method === "GET") {
				await this.open();
				ensureTables(sqlFacade!);
				const names = new Set<string>();
				// 内置扩展（spike / codemode / tool-search）+ 已连接的 MCP 工具
				for (const ext of [spikeExtension, codemodeExtension, toolSearchExtension, this.mcpExt, this.customExt] as unknown as {
					tools?: { name?: string }[];
				}[]) {
					for (const tool of ext?.tools ?? []) if (tool.name) names.add(tool.name);
				}
				return Response.json({
					approval: approvalSettings(),
					tools: [...names].sort().map((name) => ({
						name,
						category: toolCategory(name),
						policy: toolPolicy(name),
						override: getSetting(`approval_tool_${name}`, "follow"),
					})),
				});
			}
			if (url.pathname === "/settings" && request.method === "GET") {
				ensureTables(sqlFacade!);
				return Response.json({
					webSearch: getSetting("web_search", "1") === "1",
					thinkingLevel: currentThinkingLevel(),
					compaction: compactionSettings(),
					approval: approvalSettings(),
				});
			}
			if (url.pathname === "/settings" && request.method === "POST") {
				const body = (await request.json()) as { webSearch?: boolean; thinkingLevel?: string };
				if (typeof body.webSearch === "boolean") setSetting("web_search", body.webSearch ? "1" : "0");
				if (body.thinkingLevel === "off" || body.thinkingLevel === "low" || body.thinkingLevel === "high") {
					setSetting("thinking_level", body.thinkingLevel);
				}
				// 工具审批（v0.33.0）：三档策略 + 逐工具覆盖
				const ap = (body as { approval?: Record<string, unknown> }).approval;
				if (ap && typeof ap === "object") {
					for (const level of ["read", "write", "exec"] as const) {
						const value = ap[level];
						if (value === "allow" || value === "ask" || value === "deny") setSetting(`approval_${level}`, value);
					}
				}
				const apTools = (body as { approvalTools?: Record<string, unknown> }).approvalTools;
				if (apTools && typeof apTools === "object") {
					for (const [name, value] of Object.entries(apTools)) {
						if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) continue;
						if (value === "follow" || value === "allow" || value === "ask" || value === "deny") {
							setSetting(`approval_tool_${name}`, value);
						}
					}
				}
				const c = (body as { compaction?: Record<string, unknown> }).compaction;
				let compactionChanged = false;
				if (c && typeof c === "object") {
					if (typeof c.enabled === "boolean") {
						setSetting("compaction_enabled", c.enabled ? "1" : "0");
						compactionChanged = true;
					}
					for (const [patchKey, settingKey, min] of [
						["reserveTokens", "compaction_reserve", 1024],
						["keepRecentTokens", "compaction_keep_recent", 0],
						["backgroundTokens", "compaction_background", 0],
					] as const) {
						const raw = Number(c[patchKey]);
						if (Number.isFinite(raw) && raw >= min) {
							setSetting(settingKey, String(Math.floor(raw)));
							compactionChanged = true;
						}
					}
				}
				// 压缩策略在 Harness.open 时读取，改了要重建
				if (compactionChanged) await this.recoverSession();
				return Response.json({
					ok: true,
					webSearch: getSetting("web_search", "1") === "1",
					thinkingLevel: currentThinkingLevel(),
					compaction: compactionSettings(),
					approval: approvalSettings(),
				});
			}
			if (url.pathname === "/compact" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string; instructions?: string };
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, body.sessionId);
				const taskId = await (conversation as unknown as {
					compact(instructions: string | undefined, c: unknown): Promise<unknown>;
				}).compact(typeof body.instructions === "string" ? body.instructions : undefined, ctx);
				return Response.json({ ok: true, taskId: String(taskId) });
			}
			if (url.pathname === "/plan" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const sid = url.searchParams.get("sessionId") ?? "1";
				return Response.json({ steps: readPlan(sid) });
			}
			/* ---- 目标模式（v0.31.0）：GET 读 / POST 建立 / DELETE 停止 ---- */
			if (url.pathname === "/goal" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const sid = url.searchParams.get("sessionId") ?? "1";
				return Response.json({ goal: goalInfo(readGoalRow(sid)) });
			}
			if (url.pathname === "/goal" && request.method === "POST") {
				ensureTables(sqlFacade!);
				const body = (await request.json().catch(() => ({}))) as {
					sessionId?: string;
					objective?: string;
					tokenBudget?: number;
					maxTurns?: number;
				};
				const objective = String(body.objective ?? "").trim().slice(0, 300);
				if (!objective) return Response.json({ ok: false, error: "目标不能为空。" }, { status: 400 });
				const sid = String(body.sessionId ?? "1");
				const budget = Math.max(10_000, Math.floor(Number(body.tokenBudget ?? GOAL_TOKEN_BUDGET_DEFAULT) || GOAL_TOKEN_BUDGET_DEFAULT));
				const turns = Math.min(50, Math.max(1, Math.floor(Number(body.maxTurns ?? GOAL_MAX_TURNS_DEFAULT) || GOAL_MAX_TURNS_DEFAULT)));
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, sid);
				const baseline = await this.goalTokens(harness, conversation.id);
				startGoal(sid, objective, budget, turns, baseline);
				return Response.json({ ok: true, goal: goalInfo(readGoalRow(sid)) });
			}
			if (url.pathname === "/goal" && request.method === "DELETE") {
				ensureTables(sqlFacade!);
				const sid = url.searchParams.get("sessionId") ?? "1";
				writeGoal(sid, { status: "paused", next_run_at: 0 });
				await this.scheduleNextAlarm();
				return Response.json({ ok: true, goal: goalInfo(readGoalRow(sid)) });
			}
			if (url.pathname === "/providers" && request.method === "GET") {
				ensureTables(sqlFacade!);
				const active = activeProviderId();
				const rows = listProviderRows().map((r) => ({
					id: r.id,
					name: r.name,
					baseUrl: r.base_url,
					models: splitModels(r.models),
					hasKey: Boolean(r.api_key),
					keyHint: r.api_key ? "••••" + r.api_key.slice(-4) : "",
					active: r.id === active,
				}));
				return Response.json({ active, default: DEFAULT_PROVIDER, providers: rows });
			}
			if (url.pathname === "/providers" && request.method === "POST") {
				const body = (await request.json()) as {
					id?: string;
					name?: string;
					baseUrl?: string;
					apiKey?: string;
					models?: string | string[];
				};
				const name = (body.name ?? "").trim().slice(0, 40);
				const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
				if (!name || !/^https?:\/\//.test(baseUrl)) {
					return Response.json({ error: "需要名称与 http(s) 地址" }, { status: 400 });
				}
				const modelList = (Array.isArray(body.models) ? body.models : splitModels(String(body.models ?? "")))
					.map((m) => String(m).trim())
					.filter(Boolean)
					.slice(0, 20);
				ensureTables(sqlFacade!);
				const id =
					(body.id ?? "").trim() ||
					baseUrl.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 24) ||
					"p" + Date.now().toString(36);
				const existing = listProviderRows().find((r) => r.id === id);
				// 编辑时 apiKey 留空 = 保留原密钥
				const apiKey = (body.apiKey ?? "").trim() || existing?.api_key || "";
				if (!apiKey) return Response.json({ error: "需要 API Key" }, { status: 400 });
				sqlFacade!.exec(
					"INSERT INTO providers (id, name, base_url, api_key, models, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key, models = excluded.models",
					id, name, baseUrl, apiKey, modelList.join(","), new Date().toISOString(),
				);
				if (activeProviderId() === id) await this.recoverSession();
				return Response.json({ ok: true, id, models: modelList });
			}
			if (url.pathname === "/providers" && request.method === "DELETE") {
				const id = url.searchParams.get("id") ?? "";
				ensureTables(sqlFacade!);
				sqlFacade!.exec("DELETE FROM providers WHERE id = ?", id);
				if (activeProviderId() === id) setSetting("active_provider", "");
				await this.recoverSession();
				return Response.json({ ok: true });
			}
			if (url.pathname === "/providers/activate" && request.method === "POST") {
				const body = (await request.json()) as { id?: string };
				const id = (body.id ?? "").trim();
				ensureTables(sqlFacade!);
				if (id && !listProviderRows().some((r) => r.id === id)) {
					return Response.json({ error: "供应商不存在" }, { status: 404 });
				}
				setSetting("active_provider", id);
				await this.recoverSession();
				return Response.json({ ok: true, active: id, provider: this.providerId(), models: activeModelIds() });
			}
			if (url.pathname === "/models" && request.method === "GET") {
				const available = activeModelIds();
				return Response.json({ models: available, default: available[0] ?? DEFAULT_MODEL_ID, provider: this.providerId() });
			}
			if (url.pathname === "/model" && request.method === "POST") {
				const body = (await request.json()) as { sessionId?: string; modelId?: string };
				const modelId = body.modelId ?? "";
				if (!activeModelIds().includes(modelId)) {
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
				// all=1 → 一键清空（v0.26.0）
				if (url.searchParams.get("all") === "1") {
					ensureTables(sqlFacade!);
					const before = (sqlFacade!.exec("SELECT COUNT(*) AS n FROM pi_mem").toArray() as { n: number }[])[0]?.n ?? 0;
					sqlFacade!.exec("DELETE FROM pi_mem");
					return Response.json({ ok: true, deleted: before });
				}
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

// Spike: pi-durable harness inside a Cloudflare Durable Object (MemoryStorage round).
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
// 构建期注入：内核依赖版本（v0.35.0）
import packageJson from "../package.json";
import { collectBootstrap } from "./worker/bootstrap";
import type { KbRef } from "./worker/lib/kb";
import { entryText, entryUsage } from "./worker/lib/entries";
import { demoShareToken, demoShareUrl, shareExpiryLabel } from "./worker/lib/share-render";
import { migrate, type SqlHandle } from "./worker/db/migrations";
import { buildContext, type AppEnv } from "./worker/http/context";
import {
	createChatGate,
	USER_ID_RE,
	type AlarmRuntime,
	type ChatEntry,
	type ChatHandle,
	type ChatRuntime,
	type ChatSettled,
	type ChatSubmission,
	type ChatWatchEvent,
	type ContextRuntime,
	type GoalRuntime,
	type McpRuntime,
	type SettingsRuntime,
	type ShareRuntime,
	type ToolRuntime,
} from "./worker/http/ports";
import { getModel } from "./worker/repo/sessions-repo";
import * as automationsRepo from "./worker/repo/automations-repo";
import * as customToolsRepo from "./worker/repo/custom-tools-repo";
import * as goalsRepo from "./worker/repo/goals-repo";
import * as mcpRepo from "./worker/repo/mcp-repo";
import * as plansRepo from "./worker/repo/plans-repo";
import * as providersRepo from "./worker/repo/providers-repo";
import * as settingsRepo from "./worker/repo/settings-repo";
import { createFileService } from "./worker/services/file-service";
import {
	activeModelIds,
	activeProviderId,
	compactionSettings,
	DEFAULT_MODEL_ID,
	DEFAULT_PROVIDER,
	settingsView,
	splitModels,
	thinkingLevel,
} from "./worker/services/settings-service";
import { createAutomationService, type AutomationService } from "./worker/services/automation-service";
import { createChatService, type ChatService } from "./worker/services/chat-service";
import { approvalSettings, listPending as listPendingApprovals, withApproval, type ToolGateDeps } from "./worker/services/approval-service";
import {
	buildExtension as buildCustomToolsExtension,
	CustomToolApiError,
	listTools as listCustomTools,
	removeTool as removeCustomTool,
	saveTool as saveCustomTool,
} from "./worker/services/custom-tool-service";
import {
	GOAL_MAX_TURNS_DEFAULT,
	GOAL_TOKEN_BUDGET_DEFAULT,
	goalInfo,
	readGoal,
	startGoal as startGoalRow,
	writeGoal as updateGoalRow,
	type GoalPatch,
	type GoalRow,
} from "./worker/services/goal-service";
import { buildExtension as buildMcpExtension, type McpCache } from "./worker/services/mcp-service";
import { readPlan as readPlanRow, savePlan as savePlanRow, type PlanStep } from "./worker/services/plan-service";
import { listPending as listPendingQuestions, record as recordQuestionRow, type AskItem, type AskOption, type AskPayload } from "./worker/services/question-service";
import { createKbService, type WebFetchResult } from "./worker/services/kb-service";
import { createSessionService, type SessionRuntime } from "./worker/services/session-service";
import { createShareService } from "./worker/services/share-service";
import { createSkillService, SkillApiError, trackSkillCall } from "./worker/services/skill-service";
import { normalizeSkillUrl } from "./worker/lib/skill-import";
import { dispatch } from "./worker/routes";

const ctx = BACKGROUND_CONTEXT;

/**
 * 同一 isolate 可能同时承载多个 Durable Object（多用户后必然发生），
 * 模块级全局会串数据；SQL / Harness / API Key 一律按请求作用域取（v0.43.0）。
 */
type AgentScope = {
	sql: SqlHandle;
	harness: unknown | null;
	apiKey: string | null;
	/** 向量检索 / 网页抓取配置（v0.53.0）：从 Worker 环境变量读取，不落库。 */
	env?: { AI?: unknown; KB_VEC?: unknown; CF_DISABLE_VECTOR?: string; DEEPSEEK_BASE_URL?: string; DEMO_SHARE_URL?: string };
	/** 当前 DO 的稳定标识，用作 Vectorize 元数据过滤与向量 id 前缀。 */
	scopeId?: string;
	/** 本次请求的公开 Origin：分享工具据此拼绝对链接（alarm 触发时为空）。 */
	origin?: string;
	/** 当前请求的用户键（x-pi-user），分享 token 复用同一前缀。 */
	userKey?: string;
};
const agentScope = new AsyncLocalStorage<AgentScope>();

function scope(): AgentScope {
	const current = agentScope.getStore();
	if (!current) throw new Error("Agent scope missing");
	return current;
}

/** 模块级工具通过代理读取当前请求的 SQL，调用点保持 `sqlFacade!.exec(...)` 不变。 */
const sqlFacade = new Proxy({} as SqlHandle, {
	get(_target, property) {
		const db = scope().sql;
		const value = (db as unknown as Record<PropertyKey, unknown>)[property];
		return typeof value === "function" ? value.bind(db) : value;
	},
});
/** 工具与首屏聚合共用文件域服务；服务只捕获代理，真实 SQL 仍按请求作用域解析。 */
const fileStore = createFileService({ sql: sqlFacade });
/** DEEPSEEK_API_KEY / Harness 都从当前请求作用域读取（多 DO 共 isolate 时不能放全局）。 */

/** 全局设置读写（`app_settings`）：SQL 在 repo，工具与未迁移端点共用这两个薄包装。 */
function getSetting(key: string, fallback: string): string {
	return settingsRepo.get(sqlFacade!, key, fallback);
}

function setSetting(key: string, value: string): void {
	settingsRepo.set(sqlFacade!, key, value);
}

/* ---------------- 计划与目标（服务在 services/plan-service.ts、services/goal-service.ts） ---------------- */

const readPlan = (conversationId: string): PlanStep[] => readPlanRow(sqlFacade!, conversationId);

function savePlan(conversationId: string, steps: PlanStep[]): void {
	savePlanRow(sqlFacade!, conversationId, steps);
}

function readGoalRow(sessionId: string): GoalRow | null {
	return readGoal(sqlFacade!, sessionId);
}

function writeGoal(sessionId: string, patch: GoalPatch): void {
	updateGoalRow(sqlFacade!, sessionId, patch);
}

/** 建立（或替换）一个会话的目标。baseline 是本轮之前的累计 token，用于计算目标消耗。 */
function startGoal(sessionId: string, objective: string, tokenBudget: number, maxTurns: number, baseline: number): void {
	startGoalRow(sqlFacade!, { sessionId, objective, tokenBudget, maxTurns, baseline });
}


/* ---------------- 工具审批（v0.33.0）：实现在 services/approval-service.ts ---------------- */

/** 模块级工具扩展的审批闸门依赖：SQL 与设置按请求作用域延迟解析。 */
const toolGate: ToolGateDeps = { sql: () => sqlFacade!, get: getSetting };




/* ---------------- 交互式问答（v0.37.0）：实现在 services/question-service.ts ---------------- */

function recordQuestion(sessionId: string, payload: AskPayload): number | null {
	return recordQuestionRow(sqlFacade!, sessionId, payload);
}

/* ---------------- 自定义工具（v0.36.0）：实现在 services/custom-tool-service.ts ---------------- */


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

/* ---------------- 只读面板（NERE-23）：单端点与 /bootstrap 共用同一实现 ---------------- */

function listMemories() {
	return sqlFacade!.exec("SELECT id, content, created_at, source FROM pi_mem ORDER BY id DESC LIMIT 200").toArray();
}

function ruleViews() {
	return listRules().map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
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

/* ---------------- 上下文压缩策略（v0.30.0）：实现在 services/settings-service.ts ---------------- */


/* ---------------- LLM 供应商（v0.27.0）：实现在 services/settings-service.ts ---------------- */

type ProviderRow = providersRepo.ProviderRow;

const listProviderRows = () => providersRepo.list(sqlFacade!);

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

/* ---------------- 用户知识库（v0.45.0） ----------------
 * 纯函数在 lib/kb.ts，用例在 services/kb-service.ts，SQL 在 repo/kb-repo.ts。
 * 本文件只保留工具/legacy 端点对 KB 服务的调用装配。
 */
/** 按请求作用域装配知识库服务：工具与 legacy 端点共用，服务不读 scope()。 */
function kbService() {
	const current = scope();
	return createKbService({
		sql: sqlFacade!,
		env: current.env ?? {},
		scopeId: current.scopeId ?? "spike",
		settings: { get: getSetting },
		webFetch: (url) => webFetchPageContent(url, current.apiKey),
	});
}

/** 按请求作用域装配分享服务：模型工具（share_file/share_conversation）在 agentScope 内调用，服务不读 scope()。 */
function shareService() {
	const current = scope();
	return createShareService({
		sql: sqlFacade!,
		settings: { get: getSetting },
		// 工具在 alarm 触发时没有请求 Origin：回落到 share_origin 设置（与旧 shareUrlForToken 一致）。
		origin: current.origin || getSetting("share_origin", ""),
		userKey: current.userKey ?? "",
		demoToken: demoShareToken(current.env?.DEMO_SHARE_URL),
	});
}

/** web_fetch_page 与链接 ingest 共用：DeepSeek Fetch API 抓正文，不截断（调用方决定长度）。 */
async function webFetchPageContent(url: string, apiKey: string | null): Promise<WebFetchResult> {
	if (!/^https?:\/\//i.test(url)) return { ok: false, kind: "error", message: "URL 必须以 http(s):// 开头。" };
	if (!apiKey) return { ok: false, kind: "error", message: "未配置 DEEPSEEK_API_KEY，无法抓取网页。" };
	const base = (scope().env?.DEEPSEEK_BASE_URL ?? "").trim().replace(/\/+$/, "") || "https://api.deepseek.com";
	try {
		const resp = await fetch(`${base}/v1/tools/fetch`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ url }),
		});
		const data = (await resp.json().catch(() => null)) as { title?: string; content?: string; error?: { message?: string } } | null;
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
}

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
				const rows = sqlFacade!
					.exec("SELECT name, description FROM skills WHERE audit_status != 'blocked' ORDER BY name")
					.toArray() as {
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
				const rows = sqlFacade!
					.exec("SELECT content, audit_status, audit_report FROM skills WHERE name = ?", name)
					.toArray() as { content: string; audit_status: string; audit_report: string }[];
				if (!rows[0]) return { output: [{ type: "text", text: `技能「${name}」不存在，可用 list_skills 查看。` }] };
				if (rows[0].audit_status === "blocked") {
					// 准入：blocked 行即使因历史原因存在也不可加载（契约 §5.5）
					let reason = "";
					try {
						const report = JSON.parse(rows[0].audit_report || "{}") as { reasons?: { message?: string }[] };
						reason = report.reasons?.[0]?.message ?? "";
					} catch {
						// 报告损坏时只给通用原因
					}
					return { output: [{ type: "text", text: `技能「${name}」未通过安全审计，不能加载。${reason}` }] };
				}
				trackSkillCall(sqlFacade!, name, "loaded");
				return { output: [{ type: "text", text: rows[0].content }] };
			},
		}),
		defineTool({
			name: "install_skill",
			description: "从 SKILL.md 链接安装技能到当前用户（写操作）：抓取正文、解析 frontmatter、按名称写入或覆盖技能库",
			parameters: Type.Object({
				url: Type.String({ description: "SKILL.md 的 http(s) 链接；GitHub blob 链接会自动转 raw" }),
				name: Type.Optional(Type.String({ description: "覆盖技能名（默认取 frontmatter 的 name）" })),
			}),
			execute: async (args) => {
				const raw = String((args as { url?: unknown }).url ?? "");
				const url = normalizeSkillUrl(raw);
				if (!url) return { output: [{ type: "text", text: "需要一个 http(s) 的 SKILL.md 链接。" }] };
				const name = String((args as { name?: unknown }).name ?? "").trim();
				try {
					// 与 Hub/API 同一导入通道：先审计再入库，blocked 不写库（NERE-55）。
					const result = await createSkillService({ sql: sqlFacade!, settings: { get: getSetting } }).importSkill({
						url,
						...(name ? { name } : {}),
					});
					const warn = result.audit.status === "warn" ? `（审计告警：${result.audit.reasons.map((r) => r.message).join("；")}）` : "";
					return {
						output: [
							{
								type: "text",
								text: `技能已安装：${result.name}${warn}。现在可以调用 load_skill("${result.name}") 读取；下一轮起会出现在技能索引里。`,
							},
						],
					};
				} catch (err) {
					const message = err instanceof SkillApiError ? err.message : `抓取失败：${String(err).slice(0, 120)}`;
					return { output: [{ type: "text", text: `安装失败：${message}` }] };
				}
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
			name: "ask_user",
			description:
				"向用户提问并等待回答（渲染成问答卡片，可选项 + 自由输入）。需要用户做决策、补充偏好或确认方向时使用；一次可以问 1–6 个问题，每个问题给出推荐项（recommended: true）。用户回答后你会自动收到答案并继续。普通对话不要用。",
			parameters: Type.Object({
				title: Type.Optional(Type.String({ description: "这一轮的问题标题，一句话" })),
				questions: Type.Array(
					Type.Object({
						id: Type.String({ description: "问题 id，如 q1" }),
						question: Type.String({ description: "问题正文" }),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									label: Type.String({ description: "选项文案（简短）" }),
									description: Type.Optional(Type.String({ description: "选项补充说明" })),
									recommended: Type.Optional(Type.Boolean({ description: "是否推荐项" })),
								}),
								{ description: "可选项；留空则只收自由文本" },
							),
						),
						allowText: Type.Optional(Type.Boolean({ description: "是否允许自由输入（默认 true）" })),
					}),
					{ description: "问题列表，1–6 个", minItems: 1, maxItems: 6 },
				),
			}),
			execute: async (args, api) => {
				const a = args as { title?: unknown; questions?: unknown };
				const list = Array.isArray(a.questions) ? a.questions : [];
				const questions: AskItem[] = [];
				for (const raw of list.slice(0, 6)) {
					const o = (raw ?? {}) as { id?: unknown; question?: unknown; options?: unknown; allowText?: unknown };
					const question = String(o.question ?? "").trim();
					if (!question) continue;
					const options = (Array.isArray(o.options) ? o.options : [])
						.slice(0, 8)
						.map((item) => {
							const opt = (item ?? {}) as { label?: unknown; description?: unknown; recommended?: unknown };
							const label = String(opt.label ?? "").trim();
							if (!label) return null;
							return {
								label: label.slice(0, 80),
								...(opt.description ? { description: String(opt.description).slice(0, 200) } : {}),
								...(opt.recommended === true ? { recommended: true } : {}),
							};
						})
						.filter((opt): opt is AskOption => opt !== null);
					questions.push({
						id: String(o.id ?? `q${questions.length + 1}`).slice(0, 20),
						question: question.slice(0, 500),
						...(options.length ? { options } : {}),
						allowText: o.allowText !== false,
					});
				}
				if (!questions.length) return { output: [{ type: "text", text: "没有有效问题，未提交。" }] };
				const sid = String(api.conversationId);
				const id = recordQuestion(sid, {
					...(a.title ? { title: String(a.title).slice(0, 120) } : {}),
					questions,
				});
				return {
					output: [{
						type: "text",
						text: `已向用户提出 ${questions.length} 个问题${id ? `（#${id}）` : ""}，正在等待回答。不要重复提问，也不要自己替用户作答；用户回答后你会收到答案。`,
					}],
				};
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
				const harness = scope().harness as {
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
				let model = { provider: activeProviderId(sqlFacade!) || DEFAULT_PROVIDER.id, modelId: activeModelIds(sqlFacade!)[0] ?? DEFAULT_MODEL_ID };
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
				const apiKey = scope().apiKey;
				if (!apiKey) return { output: [{ type: "text", text: "未配置 DEEPSEEK_API_KEY，无法联网搜索。" }] };
				const count = Math.min(50, Math.max(1, Math.floor(Number(a.count ?? 8) || 8)));
				try {
					const resp = await fetch("https://api.deepseek.com/v1/tools/search", {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
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
				if (!/^https?:\/\//i.test(url)) return { output: [{ type: "text", text: "URL 必须以 http(s):// 开头。" }] };
				if (getSetting("web_search", "1") !== "1") {
					return { output: [{ type: "text", text: "网页搜索当前未开启。请告诉用户：在 设置 → 网页搜索 中开启后即可抓取网页。" }] };
				}
				const page = await webFetchPageContent(url, scope().apiKey);
				if (!page.ok) return { output: [{ type: "text", text: page.message }] };
				return { output: [{ type: "text", text: (page.title ? `# ${page.title}\n\n` : "") + page.content.slice(0, 8000) }] };
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
				fileStore.write(String(api.conversationId), name, content);
				return { output: [{ type: "text", text: `已写入 ${name}（${content.length} 字符）。` }] };
			},
		}),
		defineTool({
			name: "read_file",
			description: "读取工作台文件内容",
			parameters: Type.Object({ name: Type.String({ description: "文件名" }) }),
			execute: async (args, api) => {
				const name = String((args as { name?: unknown }).name ?? "").replace(/^[/.]+/, "");
				const rows = fileStore.read(String(api.conversationId), name);
				return { output: [{ type: "text", text: rows?.content ?? `文件 ${name} 不存在。` }] };
			},
		}),
		defineTool({
			name: "list_files",
			description: "列出工作台全部文件",
			parameters: Type.Object({}),
			execute: async (_args, api) => {
				const rows = fileStore.list(String(api.conversationId));
				const text = rows.length ? rows.map((r) => `${r.name} · ${r.size} 字符 · ${r.updated_at.slice(0, 16).replace("T", " ")}`).join("\n") : "工作台还没有文件。";
				return { output: [{ type: "text", text }] };
			},
		}),
		defineTool({
			name: "share_file",
			description:
				"把工作台文件生成公开只读分享链接（写操作）。用户说「分享」「发我个链接」「转给同事」时直接调用；同一文件已有未过期链接会复用，不重复生成。ttlSeconds 不传时用设置里的默认有效期。",
			parameters: Type.Object({
				name: Type.String({ description: "工作台文件名，如 report.md" }),
				ttlSeconds: Type.Optional(Type.Number({ description: "有效期（秒），0 = 永久；不传沿用设置默认" })),
			}),
			execute: async (args, api) => {
				const a = args as { name?: unknown; ttlSeconds?: unknown };
				const name = String(a.name ?? "").trim().replace(/^[/.]+/, "").slice(0, 120);
				if (!name) return { output: [{ type: "text", text: "文件名不能为空。请先用 write_file 生成文件再分享。" }] };
				try {
					const shares = shareService();
					const { share, reused } = shares.shareForTool("file", String(api.conversationId), name, a.ttlSeconds);
					const url = shares.urlFor(share.token);
					const expiry = shareExpiryLabel(share.expiresAt);
					return {
						output: [{
							type: "text",
							text: `${reused ? "已复用未过期的分享链接" : "已生成分享链接"}：${url}（${expiry}）。请在回复里原样给出这个完整链接。`,
						}],
						details: {
							share: {
								kind: "file",
								name,
								url,
								expiresAt: share.expiresAt,
								createdAt: share.createdAt,
								reused,
							},
						},
					};
				} catch (err) {
					return {
						output: [{
							type: "text",
							text: `分享失败：${err instanceof Error ? err.message : String(err)}。先用 write_file 写入文件再调用 share_file。`,
						}],
					};
				}
			},
		}),
		defineTool({
			name: "share_conversation",
			description:
				"把当前对话生成公开只读分享链接（写操作）。用户要把这段对话发给别人时调用；已有未过期链接会复用。ttlSeconds 不传时用设置里的默认有效期。",
			parameters: Type.Object({
				ttlSeconds: Type.Optional(Type.Number({ description: "有效期（秒），0 = 永久；不传沿用设置默认" })),
			}),
			execute: async (args, api) => {
				const a = args as { ttlSeconds?: unknown };
				const conversationId = String(api.conversationId);
				try {
					const shares = shareService();
					const { share, reused } = shares.shareForTool("conversation", conversationId, "", a.ttlSeconds);
					const url = shares.urlFor(share.token);
					const expiry = shareExpiryLabel(share.expiresAt);
					const title = shares.sessionTitle(conversationId);
					return {
						output: [{
							type: "text",
							text: `${reused ? "已复用未过期的对话分享链接" : "已生成对话分享链接"}：${url}（${expiry}）。请在回复里原样给出这个完整链接。`,
						}],
						details: {
							share: {
								kind: "conversation",
								name: title,
								url,
								expiresAt: share.expiresAt,
								createdAt: share.createdAt,
								reused,
							},
						},
					};
				} catch (err) {
					return {
						output: [{ type: "text", text: `分享失败：${err instanceof Error ? err.message : String(err)}。` }],
					};
				}
			},
		}),
		defineTool({
			name: "kb_search",
			description:
				"检索当前用户的知识库（用户上传的资料、长期参考文档）。回答涉及用户私人资料或历史资料时先检索；返回命中的片段与文档名。",
			parameters: Type.Object({
				query: Type.String({ description: "检索词，用用户问题里的关键词" }),
				limit: Type.Optional(Type.Number({ description: "返回片段数，默认 6，最多 20" })),
			}),
			execute: async (args) => {
				const a = args as { query?: unknown; limit?: unknown };
				const query = String(a.query ?? "").trim();
				if (!query) return { output: [{ type: "text", text: "检索词不能为空。" }] };
				const hits = await kbService().searchAsync(query, Number(a.limit) || 6);
				if (!hits.length) return { output: [{ type: "text", text: `知识库里没有匹配「${query}」的内容。可用 kb_list 查看已有哪些文档。` }] };
				const lines = hits.map(
					(hit, i) => `[${i + 1}] ${hit.title}${hit.source ? `（${hit.source}）` : ""} · 片段 ${hit.chunkSeq + 1}\n${String(hit.text).slice(0, 900)}`,
				);
				return { output: [{ type: "text", text: `命中 ${hits.length} 段：\n\n${lines.join("\n\n---\n\n")}` }] };
			},
		}),
		defineTool({
			name: "kb_add",
			description:
				"把资料保存进当前用户的知识库（写操作）：自动分块、建立中文全文索引，之后可用 kb_search 检索。适合用户贴的资料、报告、长期参考；工作台文件不会被检索。",
			parameters: Type.Object({
				title: Type.String({ description: "文档标题" }),
				content: Type.String({ description: "文档正文（纯文本或 Markdown）" }),
				source: Type.Optional(Type.String({ description: "来源，如 URL 或文件名" })),
				tags: Type.Optional(Type.String({ description: "标签，逗号分隔" })),
			}),
			execute: async (args) => {
				const a = args as { title?: unknown; content?: unknown; source?: unknown; tags?: unknown };
				const title = String(a.title ?? "").trim().slice(0, 120);
				const content = String(a.content ?? "").trim();
				if (!title || !content) return { output: [{ type: "text", text: "标题和正文都不能为空。" }] };
				const { id, chunks, vectorized, updated } = await kbService().addIndexed({
					title,
					content,
					source: String(a.source ?? "").trim().slice(0, 300),
					tags: String(a.tags ?? "").trim().slice(0, 120),
				});
				return {
					output: [
						{
							type: "text",
							text: updated
								? `已存入知识库：${title}（id=${id}，${chunks} 个片段，${content.length} 字符${vectorized ? `，已建向量 ${vectorized} 段` : ""}）。`
								: `知识库已有相同内容：${title}（id=${id}，${chunks} 个片段），未重复入库。`,
						},
					],
				};
			},
		}),
		defineTool({
			name: "kb_list",
			description: "列出当前用户知识库里的文档",
			parameters: Type.Object({}),
			execute: async () => {
				const docs = kbService().listDocs();
				const text = docs.length
					? docs.map((doc) => `- [${doc.id}] ${doc.title}${doc.source ? ` · ${doc.source}` : ""} · ${doc.chunks} 段 · ${doc.size} 字符`).join("\n")
					: "知识库还是空的。用户贴资料时可以调用 kb_add 保存。";
				return { output: [{ type: "text", text }] };
			},
		}),
		defineTool({
			name: "kb_delete",
			description: "从当前用户的知识库删除一篇文档（写操作，不可撤销）",
			parameters: Type.Object({ id: Type.Number({ description: "文档 id（来自 kb_list）" }) }),
			execute: async (args) => {
				const id = Number((args as { id?: unknown }).id ?? 0);
				if (!id) return { output: [{ type: "text", text: "需要一个有效的文档 id。" }] };
				return { output: [{ type: "text", text: (await kbService().remove(id)) ? `已删除文档 ${id}。` : `文档 ${id} 不存在。` }] };
			},
		}),
	],
});

/** 带审批闸门的扩展（v0.33.0）：工具名与描述不变，只在 execute 外按 read/write/exec 策略判断。 */
const spikeExtension = {
	...baseSpikeExtension,
	tools: (baseSpikeExtension.tools ?? []).map((tool) => withApproval(tool as never, toolGate)),
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

/** 工具搜索扩展：模型先搜再加载被延迟的工具（v0.13.0）。 */
const baseToolSearchExtension = createToolSearchExtension();
const toolSearchExtension = {
	...baseToolSearchExtension,
	tools: (baseToolSearchExtension.tools ?? []).map((tool) => withApproval(tool as never, toolGate)),
};

/** Code mode 扩展：单例即可（沙箱无状态，脚本每次执行新建 VM）。 */
const baseCodemodeExtension = createCodemodeExtension({
	sandbox: createInlineCodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }),
	models: false,
});
/** 同样套审批闸门（v0.33.0）：codemode 属 exec 级。 */
const codemodeExtension = {
	...baseCodemodeExtension,
	tools: (baseCodemodeExtension.tools ?? []).map((tool) => withApproval(tool as never, toolGate)),
};

/* MCP 连接缓存与扩展构建在 services/mcp-service.ts（R5：缓存按 DO 实例传入）。 */

/**
 * pi-durable conversation 的结构子集。Service 只拿到不透明句柄（`ChatHandle`），
 * 真正的 Harness 调用由 DO 的端口实现完成；边界处一次断言，内部全部走命名类型。
 */
type ChatConversationLike = {
	configure(options: unknown, context: unknown): Promise<void>;
	agent(context: unknown): Promise<{ tools: readonly { name?: string }[] }>;
	entries(
		query: object,
		limit: number,
		cursor: undefined,
		context: unknown,
	): Promise<{ items: readonly ChatEntry[] }>;
	submit(draft: unknown, context: unknown): Promise<{ id?: unknown; wait(context: unknown): Promise<unknown> }>;
	commit(
		build: (tx: { entry(kind: unknown, answer: unknown): unknown }) => unknown,
		context: unknown,
	): Promise<ChatEntry | null>;
	abort(context: unknown): Promise<void>;
	reset(instructions: undefined, context: unknown): Promise<void>;
	compact(instructions: string | undefined, context: unknown): Promise<unknown>;
};

type ChatSubmissionLike = { wait(context: unknown): Promise<unknown> };

function conversationOf(handle: ChatHandle): ChatConversationLike {
	return handle as unknown as ChatConversationLike;
}

export class SpikeAgent extends DurableObject {
	/** pi-durable 的存储句柄，用来枚举会话（Harness 本身不提供列表 API）。 */
	/** 正在跑对话的会话 id（NERE-33：闸门状态对象由 DO 持有，开合时机在 chat-service）。 */
	private chatGate = createChatGate();
	/** MCP 扩展：构建一次后常驻，避免每轮重连造成工具列表抖动。 */
	private mcpExt: { name: string; tools?: unknown[] } | null = null;
	/** 自定义工具扩展（v0.36.0）：增删后重建并重新 install。 */
	private customExt: { name: string; tools?: unknown[] } | null = null;
	/** R5：已加载的自定义工具名，按 DO 实例隔离（同 isolate 多用户不串用）。 */
	private customToolNames = new Set<string>();
	/** R5：MCP 客户端缓存，按 DO 实例隔离；配置变更时清空。 */
	private mcpCache: McpCache = new Map();
	/** 注册表引用：MCP 扩展在运行时安装（install 按名替换）。 */
	private registryRef: { install(ext: unknown): void; snapshot(): { installed(): readonly { name: string }[] } } | null = null;
	private storageRef: { scanConversations(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> } | null = null;

	private harness: Harness | null = null;
	/** 测试观测点（TEST_HARNESS_STATS=1）：本实例真正 open() 的次数；/s/ 零初始化靠它断言。 */
	private harnessOpens = 0;
	/** DDL 迁移只跑一次：并发的 open()/alarm() 共享同一个 Promise。 */
	private migrated: Promise<void> | null = null;

	private ensureMigrated(): Promise<void> {
		this.migrated ??= Promise.resolve()
			.then(() => {
				migrate(this.ctx.storage.sql as unknown as SqlHandle);
			})
			.catch((err) => {
				// 迁移抛错不能封死这个 DO：清掉 memo，下次 open()/alarm() 重试（迁移自身可重入）。
				this.migrated = null;
				throw err;
			});
		return this.migrated;
	}

	private async open(): Promise<Harness> {
		if (!this.harness) {
			await this.ensureMigrated();
			const models = createModels();
			// v0.27.0：启用自定义供应商时用它，否则回落到 DeepSeek 官方（env DEEPSEEK_API_KEY）
			const activeId = activeProviderId(sqlFacade!);
			const providerRow = activeId ? listProviderRows().find((r) => r.id === activeId) : undefined;
			if (providerRow) models.setProvider(buildCustomProvider(providerRow) as never);
			else models.setProvider(deepseekProvider());
			scope().apiKey = (this.env as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY ?? null;
			const registry = createRegistry();
			this.registryRef = registry as unknown as typeof this.registryRef;
			registry.install(spikeExtension);
			// Code mode：模型写 JS 调 tools.<name>()，QuickJS WASM 沙箱内执行（workerd 原生支持）。
			registry.install(codemodeExtension);
			registry.install(toolSearchExtension);
			// Durable Object SQLite: conversations survive DO restarts and redeploys.
			const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
			this.storageRef = storage;
			// MCP 扩展在表就绪后构建并安装；之后由 /api/mcp 变更时重建（缓存按实例传入，R5）。
			this.mcpExt = (await buildMcpExtension(sqlFacade!, this.mcpCache)) as never;
			if (this.mcpExt) registry.install(this.mcpExt);
			// 自定义工具（v0.36.0）：同样必须在 Harness.open 之前 install
			this.customExt = buildCustomToolsExtension(sqlFacade!, this.customToolNames) as never;
			if (this.customExt) registry.install(this.customExt as never);
			this.harness = await Harness.open(storage, { models, registry, settings: { compaction: compactionSettings(getSetting) } }, ctx);
			this.harnessOpens++;
			scope().harness = this.harness;
			this.harness.resume();
		}
		return this.harness;
	}

	/** 对话域服务（NERE-33）：流式与非流式共用 prepare → submit → finish。 */
	private chatService(): ChatService {
		return createChatService({ sql: this.ctx.storage.sql as unknown as SqlHandle, runtime: this.chatRuntime() });
	}

	/** 对话域的 Harness 端口：open/重试、会话、扩展装配与事件泵留在 DO 组合根（ADR-0001 §4）。 */
	private chatRuntime(): ChatRuntime {
		return {
			gate: this.chatGate,
			conversation: async (sessionId) => this.conversationFor(await this.open(), sessionId),
			configure: async (handle, input) => {
				const conversation = conversationOf(handle);
				await conversation.configure(
					{
						model: { provider: this.providerId(), modelId: this.modelFor(input.sessionId) },
						// 思考档位（v0.22.0）：off 时不产生 thinking 事件，前端自然不显示思考块。
						thinkingLevel: thinkingLevel(getSetting),
						extensions: this.agentExtensions() as never,
						instructions: input.instructions,
					},
					ctx,
				);
			},
			instructions: (input) => this.buildInstructions(input.inv, input.sessionId, input.message),
			skillInvocation: (message) => this.skillInvocation(message),
			toolNames: async (handle) => {
				const agent = await conversationOf(handle).agent(ctx);
				return agent.tools.map((tool) => tool.name).filter((name): name is string => Boolean(name));
			},
			lastEntryId: async (handle) => {
				const page = await conversationOf(handle).entries({}, 1, undefined, ctx);
				return Number(page.items[0]?.id ?? 0);
			},
			submit: async (handle, input) => {
				const conversation = conversationOf(handle);
				const submission = await conversation.submit(
					{
						type: "input",
						content: userContent(input.message, input.images) as never,
						...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
					},
					ctx,
				);
				return { id: String(submission.id ?? ""), raw: submission } satisfies ChatSubmission;
			},
			wait: async (submission) => {
				const raw = submission.raw as ChatSubmissionLike;
				return (await raw.wait(ctx)) as ChatSettled;
			},
			commit: async (handle, answer) =>
				conversationOf(handle).commit((tx) => tx.entry(AssistantEntry, answer), ctx),
			entries: async (handle, opts) => {
				const query = opts?.order ? { order: opts.order } : {};
				const page = await conversationOf(handle).entries(query, opts?.limit ?? 60, undefined, ctx);
				return page.items;
			},
			watch: async (handle, onEvents) => {
				const stream = await watchEvents(await this.open(), handle.id as never, ctx);
				stream.start((events) => onEvents(events as unknown as readonly ChatWatchEvent[]));
				return { stop: () => stream.stop() };
			},
			abort: async (handle) => {
				await conversationOf(handle).abort(ctx);
			},
			reset: async (handle) => {
				await conversationOf(handle).reset(undefined, ctx);
			},
			compact: async (handle, instructions) => String(await conversationOf(handle).compact(instructions, ctx)),
			reflect: (conversationId, transcript) => this.reflect(conversationId, transcript),
			usageTokens: async (handle) => this.goalTokens(await this.open(), handle.id),
			recover: () => this.recoverSession(),
			scheduleAlarm: () => this.scheduleNextAlarm(),
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise);
			},
		};
	}

	/** 会话当前模型（未设置时用默认）。 */
	private providerId(): string {
		return activeProviderId(sqlFacade!) || DEFAULT_PROVIDER.id;
	}

	/** 当前供应商的第一个模型。 */
	private defaultModelId(): string {
		return activeModelIds(sqlFacade!)[0] ?? DEFAULT_MODEL_ID;
	}

	private modelFor(sessionId?: string): string {
		const available = activeModelIds(sqlFacade!);
		if (!sessionId) return available[0] ?? DEFAULT_MODEL_ID;
		try {
			const model = getModel(this.ctx.storage.sql as unknown as SqlHandle, sessionId);
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

	/** pi-durable 在存储错误后会把会话标记为 SessionFailed：必须 close + reopen 再重试一次（v0.46.1）。 */
	private async retryOnSessionError<T>(harness: Harness, run: (h: Harness) => Promise<T>): Promise<T> {
		try {
			return await run(harness);
		} catch (err) {
			if (!/SessionFailed|storage error/i.test(String(err))) throw err;
			await this.recoverSession();
			return run(await this.open());
		}
	}

	private async conversationFor(harness: Awaited<ReturnType<typeof this.open>>, sessionId?: string) {
		return this.retryOnSessionError(harness, (h) => this.findConversation(h, sessionId));
	}

	private async findConversation(harness: Awaited<ReturnType<typeof this.open>>, sessionId?: string) {
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

	/** 会话域的 Harness 端口：open/重试/模型与扩展配置留在 DO，Service 只做编排。 */
	private sessionRuntime(): SessionRuntime {
		return {
			entries: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, sessionId);
				const page = await conversation.entries({}, 200, undefined, ctx);
				return { conversationId: String(conversation.id), items: page.items };
			},
			createConversation: async () => {
				const harness = await this.open();
				const conversation = await this.retryOnSessionError(harness, (h) =>
					h.createConversation(
						{
							ownership: { kind: "ownerless" },
							agent: {
								model: { provider: this.providerId(), modelId: this.defaultModelId() },
								extensions: this.agentExtensions() as never,
							},
						},
						ctx,
					),
				);
				return String(conversation.id);
			},
			forkBefore: async (sessionId, entryId) => {
				const harness = await this.open();
				const parent = await this.conversationFor(harness, sessionId);
				const typed = parent as unknown as {
					id: number;
					entries(q: object, limit: number, cursor: undefined, c: unknown): Promise<{ items: readonly { id?: unknown }[] }>;
					fork(at: number, options: { ownership: { kind: string } }, c: unknown): Promise<{ id: unknown }>;
				};
				// 取「这条消息之前的最新一条」作为分叉点，新会话历史停在上一条（v0.32.0）。
				const before = await typed.entries({ maxEntryId: entryId - 1 }, 1, undefined, ctx);
				const at = Number((before.items[0] as { id?: unknown } | undefined)?.id);
				if (!Number.isFinite(at) || at <= 0) throw new Error("这条消息之前没有历史，无法分叉");
				const fork = await typed.fork(at, { ownership: { kind: "ownerless" } }, ctx);
				return { id: String(fork.id), parentId: String(typed.id), at };
			},
			rootId: async () => {
				const harness = await this.open();
				const root = await this.retryOnSessionError(harness, (h) => h.root(ctx));
				return String(root.id);
			},
			scanConversationIds: async () => {
				await this.open();
				const scan = (await this.storageRef!.scanConversations({}, 100, undefined, ctx)) as {
					items: readonly { id: unknown }[];
				};
				return scan.items.map((item) => String(item.id));
			},
			modelFor: (sessionId) => this.modelFor(sessionId),
			pauseGoal: (sessionId) => {
				try {
					writeGoal(sessionId, { status: "paused", next_run_at: 0 });
				} catch {
					// 没有目标时忽略
				}
			},
		};
	}

	/**
	 * 分享域的 Harness 端口：只有会话分享真正要读条目时才会走到这里。
	 * 文件分享、失效 token、过期 token 由 share-service 在 open() 之前短路。
	 */
	private shareRuntime(): ShareRuntime {
		return {
			conversationId: async (sessionId) => String((await this.conversationFor(await this.open(), sessionId)).id),
			entries: async (sessionId) => {
				const conversation = await (await this.open()).conversation(Number(sessionId) as never, ctx);
				if (!conversation) return [];
				const page = await conversation.entries({}, 500, undefined, ctx);
				return page.items;
			},
		};
	}

	private sessionService() {
		return createSessionService({ sql: this.ctx.storage.sql as unknown as SqlHandle, runtime: this.sessionRuntime() });
	}

	private fileService() {
		return createFileService({ sql: this.ctx.storage.sql as unknown as SqlHandle });
	}

	/** 技能域服务：与 GET /api/skills 同一实现，首屏带上 runtime / auditStatus / lastInvokedAt（NERE-59）。 */
	private skillService() {
		return createSkillService({ sql: this.ctx.storage.sql as unknown as SqlHandle, settings: { get: getSetting } });
	}

	private automationService(): AutomationService {
		return createAutomationService(this.ctx.storage.sql as unknown as SqlHandle);
	}

	private settingsRuntime(): SettingsRuntime {
		return { recover: () => this.recoverSession() };
	}

	private alarmRuntime(): AlarmRuntime {
		return { schedule: () => this.scheduleNextAlarm() };
	}

	private contextRuntime(): ContextRuntime {
		return { usage: (sessionId) => this.contextUsage(sessionId) };
	}

	private goalRuntime(): GoalRuntime {
		return {
			baselineTokens: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, sessionId);
				return this.goalTokens(harness, conversation.id);
			},
		};
	}

	/** R5：工具清单与自定义工具名都按实例取，不读模块级集合。 */
	private toolRuntime(): ToolRuntime {
		return {
			names: () => {
				const names = new Set<string>();
				for (const ext of [spikeExtension, codemodeExtension, toolSearchExtension, this.mcpExt, this.customExt] as unknown as {
					tools?: { name?: string }[];
				}[]) {
					for (const tool of ext?.tools ?? []) if (tool.name) names.add(tool.name);
				}
				return [...names];
			},
			customNames: () => [...this.customToolNames],
		};
	}

	private mcpRuntime(): McpRuntime {
		return {
			rebuild: async () => {
				this.mcpCache.clear();
				const rebuilt = await buildMcpExtension(sqlFacade!, this.mcpCache);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
				return rebuilt?.tools?.length ?? 0;
			},
		};
	}

	/**
	 * 首屏聚合（NERE-23）：一次读取所有只读面板。
	 * 各 loader 与单端点共用同一实现；collectBootstrap 负责逐字段容错。
	 */
	private async readBootstrap(sessionId: string) {
		return collectBootstrap({
			session: () => ({ ok: true, name: "pi-harness-spike" }),
			entries: () => this.sessionService().entries(sessionId),
			sessions: async () => (await this.sessionService().list()).sessions,
			files: () => this.fileService().list(sessionId),
			memories: () => listMemories(),
			approvals: () => listPendingApprovals(sqlFacade!, sessionId),
			settings: () => settingsView(getSetting, this.env as AppEnv),
			plan: () => readPlan(sessionId),
			goal: () => goalInfo(readGoalRow(sessionId)),
			questions: () => listPendingQuestions(sqlFacade!, sessionId),
			prompts: () => listPrompts(),
			rules: () => ruleViews(),
			customTools: () => customToolsRepo.listAll(sqlFacade!),
			skills: () => this.skillService().listCompat().skills,
			automations: () => automationsRepo.list(sqlFacade!),
			mcpServers: () => mcpRepo.list(sqlFacade!),
			models: () => {
				const models = activeModelIds(sqlFacade!);
				return { models, default: models[0] ?? DEFAULT_MODEL_ID };
			},
		});
	}

	/** 识别消息开头的「/技能名」（v0.23.0）：命中已安装技能时返回技能正文与去掉前缀的正文。 */
	private skillInvocation(message: string): { name: string; content: string; rest: string } | null {
		const trimmed = message.trimStart();
		if (!trimmed.startsWith("/")) return null;
		const match = /^\/(\S{1,60})(?:\s+([\s\S]*))?$/.exec(trimmed);
		if (!match) return null;
		try {
			const rows = sqlFacade!
				.exec("SELECT name, content FROM skills WHERE name = ? AND audit_status != 'blocked'", match[1]!)
				.toArray() as {
				name: string;
				content: string;
			}[];
			if (!rows[0]) return null;
			trackSkillCall(sqlFacade!, rows[0].name, "invoked");
			return { name: rows[0].name, content: rows[0].content, rest: (match[2] ?? "").trim() };
		} catch {
			return null;
		}
	}

	/** 组装本轮 instructions：基础规则 + 技能索引 + 显式技能 + 进行中的目标 + 知识库预检索（v0.46.0）。 */
	private async buildInstructions(
		inv: { name: string; content: string } | null,
		sessionId?: string,
		message?: string,
	): Promise<{ instructions: string; kbRefs: KbRef[] }> {
		const base =
			"你在 Cloudflare Free Web Pi（GitHub: scudong/cloudflare-free-web-pi，界面名 π Harness）里运行：一个部署在 Cloudflare Workers 上的 pi-durable harness，个人用量在 Cloudflare 免费额度内。被问到本项目时以上面的仓库为准。\n" +
			"凡是需要计算、批量处理、解析或转换数据时，必须调用 codemode 工具写 JavaScript 执行（脚本内可用 await tools.<name>(args) 调用其它工具），不要心算或声称没有该工具。";
		const withSkills = this.instructionsWithSkills(base);
		const goal = sessionId ? readGoalRow(sessionId) : null;
		const goalBlock =
			goal && goal.status === "active"
				? `\n\n## 目标模式（进行中）\n目标：${goal.objective}\n进度：第 ${goal.turns + 1} 轮，已用 ${goal.tokens_used} / ${goal.token_budget} tokens。\n- 这一轮必须有实际进展，不要只回复「继续」。\n- 全部达成后调用 complete_goal，并附可核对的证据。\n- 确实无法推进时调用 report_goal 说明阻塞原因。`
				: "";
		const prefetch = message ? await kbService().prefetch(message) : { block: "", refs: [] };
		// 只有真正注入了检索块才记引用（NERE-40）：未命中/开关关闭时 kbRefs 为空。
		const kbRefs = prefetch.block ? prefetch.refs : [];
		const instructions = !inv
			? withSkills + goalBlock + prefetch.block
			: `${withSkills}${goalBlock}\n\n## 用户显式调用的技能：${inv.name}\n下面是该技能的完整说明，请严格按照它执行，不要声称找不到该技能：\n\n${inv.content}${prefetch.block}`;
		return { instructions, kbRefs };
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

	/** 下一次闹钟时间：定时任务与待续转目标里最早的一个（判断在 automation-service）。 */
	private async scheduleNextAlarm(): Promise<void> {
		try {
			const next = this.automationService().nextAlarmAt();
			if (next !== null) {
				const at = Math.max(Date.now() + 5_000, next);
				await this.ctx.storage.setAlarm(at);
			} else {
				await this.ctx.storage.deleteAlarm();
			}
		} catch (err) {
			console.warn("scheduleNextAlarm failed", err);
		}
	}

	/** DO alarm：执行到点的定时任务。 */
	async alarm(): Promise<void> {
		// 先迁移再看 app_settings（share_origin），失败交给平台重试 alarm。
		await this.ensureMigrated();
		return agentScope.run(
			{
				sql: this.ctx.storage.sql as unknown as SqlHandle,
				harness: this.harness ?? null,
				apiKey: (this.env as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY ?? null,
				env: this.env as AgentScope["env"],
				scopeId: (this.ctx.id as { name?: string }).name ?? this.ctx.id.toString(),
				origin: getSetting("share_origin", ""),
				userKey: "",
			},
			() => this.handleAlarm(),
		);
	}

	private async handleAlarm(): Promise<void> {
		try {
			await this.open();
			const now = Date.now();
			const automations = this.automationService();
			const due = automations.due(now);
			const chat = this.chatService();
			for (const job of due) {
				try {
					// 会话正忙时跳过这一轮，避免并发 submit 破坏会话状态（v0.17.1）
					if (chat.hasActive(job.session_id || "1")) {
						automations.defer(job.id, now);
						continue;
					}
					await chat.chat({ message: job.prompt, sessionId: job.session_id || undefined });
				} catch (err) {
					console.warn(`automation ${job.id} failed`, String(err).slice(0, 200));
					await this.recoverSession();
				}
				automations.markRun(job, now);
			}
			if (due.length) automations.rescheduleOverdue(now);

			// 目标自动续转（v0.31.0）：到点的目标推进一轮
			for (const sessionId of automations.dueGoals(now)) {
				if (chat.hasActive(sessionId)) {
					automations.deferGoal(sessionId, now);
					continue;
				}
				try {
					await chat.goalTick(sessionId);
				} catch (err) {
					console.warn(`goal ${sessionId} tick failed`, String(err).slice(0, 200));
					await this.recoverSession();
					automations.deferGoal(sessionId, now);
				}
			}
		} catch (err) {
			console.warn("alarm failed", err);
		}
		await this.scheduleNextAlarm();
	}

	/** 已安装技能清单（name + description），供提示词索引与工具使用；blocked 不进入模型视野。 */
	private skillIndex(): { name: string; description: string }[] {
		try {
			return sqlFacade!.exec("SELECT name, description FROM skills WHERE audit_status != 'blocked' ORDER BY name").toArray() as {
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
		out += "\n安装技能：用户给出 SKILL.md 链接时，直接调用 install_skill({ url }) 安装；不要用 write_file 往工作台复制技能文件，工作台文件不会被注册。";
		// 用户知识库（v0.45.0）：每个用户独立，和工作台文件是两套存储
		out +=
			"\n用户资料与长期知识用知识库：先 kb_search 检索；用户要求「存到知识库 / 记到资料库」时用 kb_add。工作台文件不会被知识库检索到。";
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
		// 交互式问答（v0.37.0）：需要用户决策时用卡片而不是纯文本罗列
		out +=
			"\n需要用户在方案之间做选择、或缺少关键偏好无法继续时，用 ask_user 提结构化问题（一次 1–6 题，每题给 recommended 选项），比在正文里罗列问题更好用；能从环境查到的信息不要问用户。";
		// 子代理（v0.29.0）：可并行的独立子任务交给它们
		out +=
			"\n当有 2–4 个**互不依赖**的子任务（如分别调研几个对象再做对比）时，用 dispatch_tasks 并行分派给子代理，比串行逐个做更快；子代理看不到主对话，每个 prompt 要自包含。";
		// 分享（v0.55.0）：模型能直接生成链接，不能把用户推给配置项
		out +=
			"\n用户说「分享 / 发我个链接 / 转给同事 / 生成公开链接」时，直接调用 share_file（工作台文件）或 share_conversation（当前对话），并把返回的完整 URL 原样写进回复；不要回答「做不到」，也不要让用户去别处配置。";
		return out;
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
				automations: automationsRepo.listForBackup(sqlFacade!),
				mcpServers: mcpRepo.listForBackup(sqlFacade!),
				sessions: q("SELECT id, title, created_at, updated_at, model FROM sessions_meta WHERE deleted = 0"),
				shares: q("SELECT token, kind, session_id, name, expires_at, theme, created_at FROM shares"),
				skills: q("SELECT name, description, content FROM skills ORDER BY name"),
				settings: settingsRepo.listAll(sqlFacade!),
				plans: plansRepo.listForBackup(sqlFacade!),
				providers: providersRepo.listForBackup(sqlFacade!),
				prompts: q("SELECT name, description, content FROM prompts"),
				rules: q("SELECT name, content, enabled FROM rules"),
				goals: goalsRepo.listForBackup(sqlFacade!),
				kbDocs: kbService().backupDocs(),
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
			automationsRepo.restoreRow(
				sqlFacade!,
				{
					id,
					name: str(a.name),
					prompt: str(a.prompt),
					session_id: str(a.session_id),
					schedule: str(a.schedule) || '{"kind":"daily","time":"09:00"}',
					enabled: num(a.enabled) ? 1 : 0,
					next_run_at: num(a.next_run_at) || Date.now() + 60_000,
				},
				new Date().toISOString(),
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
		// 知识库只备份文档正文；恢复时分块并重建 FTS 索引（v0.45.0）
		const kb = kbService();
		for (const doc of rows("kbDocs")) {
			const title = str(doc.title).trim();
			const content = str(doc.content).trim();
			if (!title || !content) continue;
			if (kb.hasDoc(title, content)) continue;
			const restored = await kb.add({ title, content, source: str(doc.source), tags: str(doc.tags) });
			if (restored.updated) counts.kbDocs = (counts.kbDocs ?? 0) + 1;
		}
		for (const s of rows("mcpServers")) {
			const id = str(s.id);
			if (!id) continue;
			mcpRepo.restoreRow(
				sqlFacade!,
				{ id, name: str(s.name), url: str(s.url), headers: str(s.headers) || "{}" },
				new Date().toISOString(),
			);
			counts.mcpServers = (counts.mcpServers ?? 0) + 1;
		}
		this.mcpCache.clear();
		const rebuilt = await buildMcpExtension(sqlFacade!, this.mcpCache);
		if (rebuilt) {
			this.mcpExt = rebuilt as never;
			if (this.registryRef) this.registryRef.install(rebuilt);
		}
		for (const s of rows("settings")) {
			const key = str(s.key).trim();
			if (!key) continue;
			settingsRepo.restoreRow(sqlFacade!, { key, value: str(s.value) });
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
			goalsRepo.restoreRow(
				sqlFacade!,
				{
					session_id: sid,
					objective,
					status: str(g.status) || "paused",
					token_budget: num(g.token_budget) || GOAL_TOKEN_BUDGET_DEFAULT,
					baseline_tokens: num(g.baseline_tokens),
					tokens_used: num(g.tokens_used),
					turns: num(g.turns),
					max_turns: num(g.max_turns) || GOAL_MAX_TURNS_DEFAULT,
					summary: str(g.summary),
					next_run_at: num(g.next_run_at),
					created_at: str(g.created_at) || new Date().toISOString(),
				},
				new Date().toISOString(),
			);
			counts.goals = (counts.goals ?? 0) + 1;
		}
		for (const p of rows("providers")) {
			const id = str(p.id).trim();
			if (!id) continue;
			providersRepo.restoreRow(
				sqlFacade!,
				{ id, name: str(p.name), base_url: str(p.base_url), api_key: str(p.api_key), models: str(p.models) },
				new Date().toISOString(),
			);
			counts.providers = (counts.providers ?? 0) + 1;
		}
		for (const p of rows("plans")) {
			const conversation_id = str(p.conversation_id);
			if (!conversation_id) continue;
			plansRepo.restoreRow(sqlFacade!, {
				conversation_id,
				steps: str(p.steps) || "[]",
				updated_at: str(p.updated_at) || new Date().toISOString(),
			});
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

	/** 达到阈值才跑 reflect（NERE-33：节流与 transcripts 在 chat-service）。 */
	private async maybeReflect(root: ChatHandle, uptoId: number): Promise<number> {
		return this.chatService().maybeReflect(root, uptoId);
	}

	/** 估算当前上下文占用（v0.42.0）：最近一次模型用量 + 之后新增内容的字符估算。 */
	private async contextUsage(
		sessionId?: string,
	): Promise<{ usedTokens: number; contextWindow: number; percent: number; approximate: boolean }> {
		const CONTEXT_WINDOW = 128_000;
		try {
			const harness = await this.open();
			const conversation = await this.conversationFor(harness, sessionId);
			const page = (await conversation.entries({}, 500, undefined, ctx)) as { items: readonly Record<string, unknown>[] };
			const items = [...page.items].reverse(); // 按时间正序
			let base = 0;
			let lastUsage = -1;
			for (let i = items.length - 1; i >= 0; i--) {
				const usage = entryUsage(items[i].model);
				if (usage != null) {
					base = usage;
					lastUsage = i;
					break;
				}
			}
			let extra = 0;
			if (lastUsage >= 0) {
				for (let i = lastUsage + 1; i < items.length; i++) extra += Math.ceil(entryText(items[i].model).length / 2);
			} else {
				// 还没有模型用量：整段按字符估算（中文约 2 字符 / token）
				for (const item of items) extra += Math.ceil(entryText(item.model).length / 2);
			}
			const usedTokens = Math.max(0, base + extra);
			return {
				usedTokens,
				contextWindow: CONTEXT_WINDOW,
				percent: Math.min(100, Math.round((usedTokens / CONTEXT_WINDOW) * 100)),
				approximate: lastUsage < 0,
			};
		} catch {
			return { usedTokens: 0, contextWindow: CONTEXT_WINDOW, percent: 0, approximate: true };
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

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const env = this.env as unknown as AppEnv;
		// 测试观测点：Harness 真正 open() 的次数。放在路由之前，自身不触发 open()（NERE-22 验收）。
		if (url.pathname === "/debug/harness" && request.method === "GET") {
			if (env.TEST_HARNESS_STATS !== "1") return Response.json({ error: "not found" }, { status: 404 });
			return Response.json({ opens: this.harnessOpens });
		}
		const scopeId = (this.ctx.id as { name?: string }).name ?? this.ctx.id.toString();
		const userKey = request.headers.get("x-pi-user") ?? "";
		// 每个请求绑定自己的 SQL / Harness，避免同一 isolate 里的其它 DO 串数据
		return agentScope.run(
			{
				sql: this.ctx.storage.sql as unknown as SqlHandle,
				harness: this.harness ?? null,
				apiKey: env.DEEPSEEK_API_KEY ?? null,
				env,
				scopeId,
				origin: url.origin,
				userKey,
			},
			() => {
				const context = buildContext({
					req: request,
					env,
					scopeId,
					userKey,
					origin: url.origin,
					sql: this.ctx.storage.sql as unknown as SqlHandle,
					ensureMigrated: () => this.ensureMigrated(),
					open: () => this.open(),
					legacy: () => this.handleLegacyFetch(request),
					sessionRuntime: this.sessionRuntime(),
					shareRuntime: this.shareRuntime(),
					settings: { get: getSetting },
					settingsRuntime: this.settingsRuntime(),
					alarmRuntime: this.alarmRuntime(),
					contextRuntime: this.contextRuntime(),
					goalRuntime: this.goalRuntime(),
					toolRuntime: this.toolRuntime(),
					mcpRuntime: this.mcpRuntime(),
					chatRuntime: this.chatRuntime(),
					webFetch: (target) => webFetchPageContent(target, env.DEEPSEEK_API_KEY ?? null),
				});
				return dispatch(context);
			},
		);
	}

	private async handleLegacyFetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			// 所有路由都先确保 DO 初始化（sqlFacade/表/Harness 就绪），幂等。
			if (url.pathname !== "/") await this.open();
			if (request.method === "GET" && url.pathname === "/debug/agent") {
				const harness = await this.open();
				const root = await this.retryOnSessionError(harness, (h) => h.root(ctx));
				const mcpExtDbg = await buildMcpExtension(sqlFacade!, this.mcpCache);
				if (mcpExtDbg && this.registryRef) this.registryRef.install(mcpExtDbg);
				if (!this.customExt) this.customExt = buildCustomToolsExtension(sqlFacade!, this.customToolNames) as never;
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
					// 传 message 时返回本轮 instructions，用于确认技能 / 知识库预检索的注入（v0.46.0）
					instructions: url.searchParams.get("message")
						? (await this.buildInstructions(null, url.searchParams.get("sessionId") ?? "1", url.searchParams.get("message") ?? "")).instructions
						: undefined,
				});
			}
			/* ---- 首屏聚合（NERE-23）：只读，一次返回所有面板 ---- */
			if (request.method === "GET" && url.pathname === "/bootstrap") {
				const raw = (url.searchParams.get("sessionId") ?? "").trim();
				const sessionId = raw || "1";
				// 会话 id 由 Harness 以正整数分配；非法值直接 400，避免落到根会话造成误读。
				if (!/^[1-9]\d{0,15}$/.test(sessionId)) {
					return Response.json({ error: "sessionId 必须是正整数" }, { status: 400 });
				}
				return Response.json(await this.readBootstrap(sessionId));
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
				return Response.json({ prompts: listPrompts() });
			}
			if (url.pathname === "/prompts" && request.method === "POST") {
				const body = (await request.json()) as { name?: string; description?: string; content?: string };
				const name = (body.name ?? "").trim().slice(0, 40);
				const content = (body.content ?? "").trim();
				if (!name || !content) return Response.json({ error: "需要名称与内容" }, { status: 400 });
				sqlFacade!.exec(
					"INSERT INTO prompts (name, description, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content",
					name, (body.description ?? "").trim().slice(0, 120), content, new Date().toISOString(),
				);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/prompts" && request.method === "DELETE") {
				sqlFacade!.exec("DELETE FROM prompts WHERE name = ?", url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			/* ---- 规则文件（v0.31.0） ---- */
			if (url.pathname === "/rules" && request.method === "GET") {
				return Response.json({ rules: ruleViews() });
			}
			if (url.pathname === "/rules" && request.method === "POST") {
				const body = (await request.json()) as { name?: string; content?: string; enabled?: boolean };
				const name = (body.name ?? "").trim().slice(0, 40);
				const content = (body.content ?? "").trim();
				if (!name || !content) return Response.json({ error: "需要名称与内容" }, { status: 400 });
				sqlFacade!.exec(
					"INSERT INTO rules (name, content, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content",
					name, content, body.enabled === false ? 0 : 1, new Date().toISOString(),
				);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/rules" && request.method === "PATCH") {
				const body = (await request.json()) as { name?: string; enabled?: boolean };
				if (!body.name) return Response.json({ error: "缺少 name" }, { status: 400 });
				sqlFacade!.exec("UPDATE rules SET enabled = ? WHERE name = ?", body.enabled ? 1 : 0, body.name);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/rules" && request.method === "DELETE") {
				sqlFacade!.exec("DELETE FROM rules WHERE name = ?", url.searchParams.get("name") ?? "");
				return Response.json({ ok: true });
			}
			/* ---- 自定义工具（v0.36.0）：SQL/校验在 custom-tool-service ---- */
			if (url.pathname === "/custom-tools" && request.method === "GET") {
				return Response.json({ tools: listCustomTools(sqlFacade!) });
			}
			if (url.pathname === "/custom-tools" && request.method === "POST") {
				try {
					const saved = saveCustomTool(
						sqlFacade!,
						(await request.json().catch(() => ({}))) as never,
						this.customToolNames,
					);
					this.customExt = saved.extension as never;
					if (this.registryRef) this.registryRef.install(this.customExt as never);
					return Response.json({ ok: true, name: saved.name, tools: saved.extension.tools?.length ?? 0 });
				} catch (err) {
					if (err instanceof CustomToolApiError) {
						return Response.json({ ok: false, error: err.message }, { status: err.status });
					}
					throw err;
				}
			}
			if (url.pathname === "/custom-tools" && request.method === "DELETE") {
				try {
					const removed = removeCustomTool(sqlFacade!, url.searchParams.get("name") ?? "", this.customToolNames);
					this.customExt = removed.extension as never;
					if (this.registryRef) this.registryRef.install(this.customExt as never);
					return Response.json({ ok: true, tools: removed.extension.tools?.length ?? 0 });
				} catch (err) {
					if (err instanceof CustomToolApiError) {
						return Response.json({ ok: false, error: err.message }, { status: err.status });
					}
					throw err;
				}
			}
			/* ---- pi 内核版本（v0.35.0）：当前声明版本 + npm 最新版本（缓存 6 小时） ---- */
			if (url.pathname === "/kernel" && request.method === "GET") {
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
			if (url.pathname === "/reflect" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, body.sessionId);
				const page = (await conversation.entries({}, 1, undefined, ctx)) as { items: readonly { id?: number }[] };
				const saved = await this.maybeReflect(conversation as never, Number(page.items[0]?.id ?? 0));
				return Response.json({ ok: true, saved });
			}
			if (url.pathname === "/memories" && request.method === "GET") {
				return Response.json({ memories: listMemories() });
			}
			if (url.pathname === "/memories" && request.method === "DELETE") {
				// all=1 → 一键清空（v0.26.0）
				if (url.searchParams.get("all") === "1") {
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
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (e) {
			return Response.json({ error: String(e).slice(0, 500) }, { status: 500 });
		}
	}
}

/* ---------------- 访问控制（v0.10.0） ---------------- */

const SESSION_COOKIE = "pi_access";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** 主人（沿用旧版单一 token）与邀请用户（u_ 前缀）的区分（v0.43.0）。 */
const OWNER_ID = "owner";

/** 旧版主人令牌 = HMAC(ACCESS_PASSWORD, 固定串)，改密码即全体失效。 */
async function accessToken(password: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("pi-harness-access-v1")));
	return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 用户令牌签名 = HMAC(ACCESS_PASSWORD, "pi-harness-access-v2:<userId>")。 */
async function userAccessSig(password: string, userId: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`pi-harness-access-v2:${userId}`)),
	);
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

/** 邀请用户状态查询次数（仅测试配置 TEST_REGISTRY_STATS=1 时暴露，用于验收 NERE-23 的请求放大）。 */
let registryLookups = 0;

/** 邀请用户是否仍然存在（每次请求查注册表，吊销立即生效）。 */
async function userEnabled(env: { UserRegistry: DurableObjectNamespace }, userId: string): Promise<boolean> {
	registryLookups++;
	try {
		const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
		const res = await registry.fetch(
			new Request(`https://registry/internal/user-status?userId=${encodeURIComponent(userId)}`),
		);
		if (!res.ok) return false;
		const data = (await res.json()) as { ok?: boolean };
		return Boolean(data.ok);
	} catch {
		return false;
	}
}

/**
 * 解析登录态（v0.43.0）：
 * - 旧版 64 位 token → 主人；
 * - `<userId>.<sig>` → 对应邀请用户（每次都确认用户未被删除）；
 * - 未配置 ACCESS_PASSWORD → 主人（本地开发/开放模式）。
 */
async function authorizedUser(
	request: Request,
	password: string,
	env: { UserRegistry: DurableObjectNamespace } | null,
): Promise<string | null> {
	if (!password) return OWNER_ID;
	const token = cookieValue(request, SESSION_COOKIE);
	if (!token) return null;
	if (token.length === 64 && timingSafeEqualStr(token, await accessToken(password))) return OWNER_ID;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const userId = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (userId !== OWNER_ID && !USER_ID_RE.test(userId)) return null;
	if (!timingSafeEqualStr(sig, await userAccessSig(password, userId))) return null;
	if (userId === OWNER_ID) return OWNER_ID;
	if (!env) return null;
	return (await userEnabled(env, userId)) ? userId : null;
}

/* ---------------- 用户注册表（v0.43.0） ---------------- */

const INVITE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** 无歧义随机串（去掉 0/1/l/o）。 */
function randomInvite(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

/** 邀请码哈希：码本身高熵，SHA-256 足够；库里不存明文。 */
async function hashCode(code: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pi-harness-invite-v1:${code}`));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 独立的小 DO：只存 users 表，负责邀请码校验与用户 CRUD。
 * 不加载 pi-harness Harness，所以每次鉴权查询都很轻。
 */
export class UserRegistry extends DurableObject {
	private sqlRef: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } } | null = null;

	private db() {
		if (!this.sqlRef) {
			this.sqlRef = this.ctx.storage.sql as unknown as {
				exec(q: string, ...b: unknown[]): { toArray(): unknown[] };
			};
			this.sqlRef.exec(
				`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', code_hash TEXT NOT NULL UNIQUE, code_hint TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT)`,
			);
		}
		return this.sqlRef;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const db = this.db();
		try {
			if (url.pathname === "/internal/verify-code" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { code?: string };
				const code = String(body.code ?? "").trim().toLowerCase();
				if (!code) return Response.json({ ok: false });
				const rows = db
					.exec("SELECT id, name FROM users WHERE code_hash = ?", await hashCode(code))
					.toArray() as { id: string; name: string }[];
				if (!rows[0]) return Response.json({ ok: false });
				db.exec("UPDATE users SET last_used_at = ? WHERE id = ?", new Date().toISOString(), rows[0].id);
				return Response.json({ ok: true, userId: rows[0].id, name: rows[0].name });
			}
			if (url.pathname === "/internal/user-status" && request.method === "GET") {
				const userId = url.searchParams.get("userId") ?? "";
				return Response.json({ ok: db.exec("SELECT id FROM users WHERE id = ?", userId).toArray().length > 0 });
			}
			if (url.pathname === "/users" && request.method === "GET") {
				const rows = db
					.exec("SELECT id, name, code_hint, created_at, last_used_at FROM users ORDER BY created_at DESC")
					.toArray() as { id: string; name: string; code_hint: string; created_at: string; last_used_at: string | null }[];
				return Response.json({
					users: rows.map((row) => ({
						id: row.id,
						name: row.name,
						codeHint: row.code_hint,
						createdAt: row.created_at,
						lastUsedAt: row.last_used_at,
					})),
				});
			}
			if (url.pathname === "/users" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { name?: string };
				const name = String(body.name ?? "").trim().slice(0, 40);
				const id = `u_${randomInvite(8)}`;
				const code = randomInvite(16);
				const now = new Date().toISOString();
				db.exec(
					"INSERT INTO users (id, name, code_hash, code_hint, created_at) VALUES (?, ?, ?, ?, ?)",
					id, name, await hashCode(code), code.slice(-4), now,
				);
				return Response.json({
					ok: true,
					user: { id, name, codeHint: code.slice(-4), createdAt: now, lastUsedAt: null },
					code,
				});
			}
			if (url.pathname === "/users/reset" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { id?: string };
				const id = String(body.id ?? "");
				if (!db.exec("SELECT id FROM users WHERE id = ?", id).toArray().length) {
					return Response.json({ ok: false, error: "用户不存在" }, { status: 404 });
				}
				const code = randomInvite(16);
				db.exec("UPDATE users SET code_hash = ?, code_hint = ? WHERE id = ?", await hashCode(code), code.slice(-4), id);
				return Response.json({ ok: true, code, hint: code.slice(-4) });
			}
			if (url.pathname === "/users" && request.method === "DELETE") {
				db.exec("DELETE FROM users WHERE id = ?", url.searchParams.get("id") ?? "");
				return Response.json({ ok: true });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (err) {
			return Response.json({ error: String(err).slice(0, 200) }, { status: 500 });
		}
	}
}

/** 登录成功：写 cookie。 */
function sessionResponse(token: string, payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		headers: {
			"content-type": "application/json",
			"set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
		},
	});
}

export default {
	async fetch(
		request: Request,
		env: {
			SpikeAgent: DurableObjectNamespace;
			UserRegistry: DurableObjectNamespace;
			ACCESS_PASSWORD?: string;
			TEST_REGISTRY_STATS?: string;
			/** 登录页「看一个真实对话」入口：站内 /s/<token> 或 https 绝对地址。 */
			DEMO_SHARE_URL?: string;
		},
	): Promise<Response> {
		const url = new URL(request.url);
		const password = env.ACCESS_PASSWORD ?? "";
		const protect = Boolean(password);
		const userId = await authorizedUser(request, password, env);

		// 测试专用计数端点：只有测试配置显式打开且请求者是主人时才存在。
		if (url.pathname === "/api/debug/registry" && request.method === "GET") {
			if (env.TEST_REGISTRY_STATS !== "1" || userId !== OWNER_ID) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return Response.json({ lookups: registryLookups });
		}

		// 登录/登出/状态：不需要已登录。
		if (url.pathname === "/api/auth" && request.method === "GET") {
			const demo = demoShareUrl(env.DEMO_SHARE_URL);
			return Response.json({
				required: protect,
				authenticated: protect ? Boolean(userId) : true,
				owner: !protect || userId === OWNER_ID,
				...(demo ? { demoUrl: demo } : {}),
			});
		}
		if (url.pathname === "/api/login" && request.method === "POST") {
			if (!protect) return Response.json({ ok: true, required: false, owner: true });
			const body = (await request.json().catch(() => ({}))) as { password?: string; code?: string };
			const input = String(body.password ?? body.code ?? "").trim();
			if (!input) return Response.json({ error: "请输入密码或邀请码" }, { status: 400 });
			// 先当主人密码，再当邀请码
			if (timingSafeEqualStr(input, password)) {
				return sessionResponse(await accessToken(password), { ok: true, owner: true });
			}
			try {
				const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
				const res = await registry.fetch(
					new Request("https://registry/internal/verify-code", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: input }),
					}),
				);
				const data = (await res.json()) as { ok?: boolean; userId?: string; name?: string };
				if (data.ok && data.userId && USER_ID_RE.test(data.userId)) {
					const token = `${data.userId}.${await userAccessSig(password, data.userId)}`;
					return sessionResponse(token, { ok: true, owner: false, name: data.name ?? "" });
				}
			} catch {
				// 注册表不可用时按登录失败处理
			}
			return Response.json({ error: "密码或邀请码不正确" }, { status: 401 });
		}
		if (url.pathname === "/api/logout" && request.method === "POST") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
				},
			});
		}

		// 用户管理：仅主人；转发到轻量注册表 DO。
		if (
			(url.pathname === "/api/users" || url.pathname === "/api/users/reset") &&
			(request.method === "GET" || request.method === "POST" || request.method === "DELETE")
		) {
			if (protect && !userId) return Response.json({ error: "未登录" }, { status: 401 });
			if (protect && userId !== OWNER_ID) return Response.json({ error: "只有主人可以管理用户" }, { status: 403 });
			const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
			const inner = new URL(request.url);
			inner.pathname = url.pathname.replace(/^\/api/, "");
			const headers = new Headers(request.headers);
			headers.delete("x-pi-user");
			const init: RequestInit = { method: request.method, headers };
			if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
			return registry.fetch(new Request(inner, init));
		}

		// 分享页保持公开：只读、只含被打包的内容。
		const isShare = url.pathname.startsWith("/s/");
		if (protect && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/")) && !userId) {
			return Response.json({ error: "未登录" }, { status: 401 });
		}

		if (isShare) {
			// 新分享 token 形如 u_ab12cd34.xxxx：按前缀路由到对应用户的 DO；旧链接留在主人 DO。
			const shareUser = /^\/s\/(u_[a-z0-9]{6,16})\./.exec(url.pathname)?.[1];
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName(shareUser ? `user:${shareUser}` : "spike"));
			const headers = new Headers(request.headers);
			headers.set("x-pi-user", shareUser ?? "");
			return stub.fetch(new Request(new URL(request.url), { method: request.method, headers }));
		}

		if (url.pathname.startsWith("/agent/") || url.pathname.startsWith("/api/")) {
			// 每个用户一个独立 DO；主人沿用历史数据所在的 "spike"
			const who = userId ?? OWNER_ID;
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName(who === OWNER_ID ? "spike" : `user:${who}`));
			const inner = new URL(request.url);
			inner.pathname = url.pathname.replace(/^\/(agent|api)/, "") || "/";
			const headers = new Headers(request.headers);
			headers.set("x-pi-user", who);
			const init: RequestInit = { method: request.method, headers };
			if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
			return stub.fetch(new Request(inner, init));
		}
		return Response.json({ ok: true, name: "pi-harness-spike" });
	},
};

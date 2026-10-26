// Spike: pi-durable harness inside a Cloudflare Durable Object (MemoryStorage round).
import { DurableObject } from "cloudflare:workers";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, UsageDoc, watchEvents } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { demoShareToken, demoShareUrl } from "./worker/lib/share-render";
import { createProviderFetch, withProviderFetch } from "./worker/lib/provider-fetch";
import { userContent } from "./worker/lib/chat-content";
import { migrate, migrateRegistry, type SqlHandle } from "./worker/db/migrations";
import { buildContext, type AppEnv } from "./worker/http/context";
import { AppError, toResponse } from "./worker/http/errors";
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
	type CustomToolsRuntime,
	type DataRuntime,
	type DebugRuntime,
	type GoalRuntime,
	type McpRuntime,
	type SettingsPort,
	type SettingsRuntime,
	type ShareRuntime,
	type ToolRuntime,
} from "./worker/http/ports";
import { getModel } from "./worker/repo/sessions-repo";
import * as providersRepo from "./worker/repo/providers-repo";
import * as sessionsRepo from "./worker/repo/sessions-repo";
import * as settingsRepo from "./worker/repo/settings-repo";
import { createAutomationService, runDueAutomations, type AutomationService } from "./worker/services/automation-service";
import { createChatService, type ChatService } from "./worker/services/chat-service";
import { createContextService } from "./worker/services/context-service";
import {
	buildExtension as buildCustomToolsExtension,
	removeTool as removeCustomTool,
	saveTool as saveCustomTool,
} from "./worker/services/custom-tool-service";
import { createFileService, type FileService } from "./worker/services/file-service";
import { readGoal, writeGoal } from "./worker/services/goal-service";
import { buildInstructions } from "./worker/services/instructions-service";
import { createKbService, type KbService } from "./worker/services/kb-service";
import { buildExtension as buildMcpExtension, type McpCache } from "./worker/services/mcp-service";
import { reflectConversation } from "./worker/services/reflect-service";
import { createSessionService, type SessionRuntime } from "./worker/services/session-service";
import { createShareService, type ShareService } from "./worker/services/share-service";
import { parseSkillInvocation } from "./worker/services/skill-service";
import {
	activeModelIds,
	activeProviderId,
	compactionSettings,
	DEFAULT_MODEL_ID,
	DEFAULT_PROVIDER,
	splitModels,
	thinkingLevel,
} from "./worker/services/settings-service";
import { createWebFetch } from "./worker/services/web-fetch";
import { createUserAdminService } from "./worker/services/user-admin-service";
import type { BackupPayload } from "./worker/services/data-service";
import type { RevokeResult, UserDataCounts } from "./worker/services/user-lifecycle-service";
import { createAgentExtensions, type AgentExtensions, type HarnessLike } from "./worker/tools/spike-tools";
import { dispatch } from "./worker/routes";
import { internalRoutes } from "./worker/routes/internal";

/** pi-durable 的 Harness 调用上下文。 */
const ctx = BACKGROUND_CONTEXT;

/**
 * DO 组合根（ADR-0001 §4）：Harness 生命周期、按请求装配端口、alarm。
 *
 * 阶段 6 起本文件不再持有隐式存储/请求作用域：
 * - SQL 一律 `this.ctx.storage.sql`（或经 `db()`）；
 * - 工具扩展按请求由 `createAgentExtensions()` 构造，origin/userKey/apiKey 显式传入；
 * - 业务 SQL 在 repo、编排在 service、HTTP 在 routes。
 */

/** 一次请求的显式依赖；alarm 用 origin="" / userKey=""。 */
type RequestDeps = {
	sql: SqlHandle;
	env: AppEnv;
	scopeId: string;
	apiKey: string | null;
	origin: string;
	userKey: string;
};

/**
 * pi-durable conversation 的结构子集。Service 只拿到不透明句柄（`ChatHandle`），
 * 真正的 Harness 调用由 DO 的端口实现完成；边界处一次断言，内部全部走命名类型。
 */
type ChatConversationLike = {
	id: unknown;
	configure(options: unknown, context: unknown): Promise<void>;
	agent(context: unknown): Promise<{ tools: readonly { name?: string }[] }>;
	entries(query: object, limit: number, cursor: undefined, context: unknown): Promise<{ items: readonly ChatEntry[] }>;
	submit(draft: unknown, context: unknown): Promise<{ id?: unknown; wait(context: unknown): Promise<unknown> }>;
	commit(build: (tx: { entry(kind: unknown, answer: unknown): unknown }) => unknown, context: unknown): Promise<ChatEntry | null>;
	abort(context: unknown): Promise<void>;
	reset(instructions: undefined, context: unknown): Promise<void>;
	compact(instructions: string | undefined, context: unknown): Promise<unknown>;
};

type ChatSubmissionLike = { wait(context: unknown): Promise<unknown> };

function conversationOf(handle: ChatHandle): ChatConversationLike {
	return handle as unknown as ChatConversationLike;
}

export class SpikeAgent extends DurableObject {
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
	/** 注册表引用：MCP/自定义工具扩展在运行时安装（install 按名替换）。 */
	private registryRef: { install(ext: unknown): void; snapshot(): { installed(): readonly { name: string }[] } } | null = null;
	private storageRef: { scanConversations(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> } | null = null;
	/** open() 时装配的内置扩展（工具名清单与 tool-search 目录用；请求级扩展同名替换）。 */
	private baseExt: AgentExtensions | null = null;

	private harness: Harness | null = null;
	/** 测试观测点（TEST_HARNESS_STATS=1）：本实例真正 open() 的次数；/s/ 零初始化靠它断言。 */
	private harnessOpens = 0;
	/** DDL 迁移只跑一次：并发的 open()/alarm() 共享同一个 Promise。 */
	private migrated: Promise<void> | null = null;

	private db(): SqlHandle {
		return this.ctx.storage.sql as unknown as SqlHandle;
	}

	private scopeId(): string {
		return (this.ctx.id as { name?: string }).name ?? this.ctx.id.toString();
	}

	private ensureMigrated(): Promise<void> {
		this.migrated ??= Promise.resolve()
			.then(() => {
				migrate(this.db());
			})
			.catch((err) => {
				// 迁移抛错不能封死这个 DO：清掉 memo，下次 open()/alarm() 重试（迁移自身可重入）。
				this.migrated = null;
				throw err;
			});
		return this.migrated;
	}

	private settingsPort(deps: RequestDeps): SettingsPort {
		return {
			get: (key, fallback) => settingsRepo.get(deps.sql, key, fallback),
			snapshot: () => Object.fromEntries(settingsRepo.listAll(deps.sql).map((row) => [row.key, row.value])),
		};
	}

	private deps(input: {
		origin: string;
		userKey: string;
		env?: AppEnv;
		apiKey?: string | null;
		scopeId?: string;
	}): RequestDeps {
		const env = input.env ?? (this.env as unknown as AppEnv);
		return {
			sql: this.db(),
			env,
			scopeId: input.scopeId ?? this.scopeId(),
			apiKey: input.apiKey === undefined ? (env.DEEPSEEK_API_KEY ?? null) : input.apiKey,
			origin: input.origin,
			userKey: input.userKey,
		};
	}

	private webFetch(deps: RequestDeps) {
		return createWebFetch({ apiKey: deps.apiKey, baseUrl: deps.env.DEEPSEEK_BASE_URL });
	}

	private kbService(deps: RequestDeps): KbService {
		return createKbService({
			sql: deps.sql,
			env: deps.env,
			scopeId: deps.scopeId,
			settings: this.settingsPort(deps),
			webFetch: this.webFetch(deps),
		});
	}

	private fileService(deps: RequestDeps): FileService {
		return createFileService({ sql: deps.sql });
	}

	/** 按请求装配分享服务：工具与 HTTP 端点共用，origin/userKey 显式传入。 */
	private shareService(deps: RequestDeps): ShareService {
		return createShareService({
			sql: deps.sql,
			settings: this.settingsPort(deps),
			// 工具在 alarm 触发时没有请求 Origin：回落到 share_origin 设置（与旧 shareUrlForToken 一致）。
			origin: deps.origin || settingsRepo.get(deps.sql, "share_origin", ""),
			userKey: deps.userKey,
			demoToken: demoShareToken(deps.env.DEMO_SHARE_URL),
		});
	}

	/**
	 * 本轮扩展：内置工具按请求构造（share 工具需要当前 Origin/userKey），
	 * MCP 与自定义工具沿用实例级扩展（R5：缓存与集合都按 DO 隔离）。
	 */
	private agentExtensions(deps: RequestDeps): unknown[] {
		const ext = createAgentExtensions({
			sql: deps.sql,
			settings: this.settingsPort(deps),
			files: this.fileService(deps),
			kb: this.kbService(deps),
			shares: this.shareService(deps),
			harness: () => this.harness as unknown as HarnessLike | null,
			apiKey: deps.apiKey,
			webFetch: this.webFetch(deps),
		});
		// pi-durable 按扩展名从注册表解析工具（configure 只存名字），因此请求级扩展必须
		// 先 install 覆盖同名内置扩展，share 工具才能拿到本次请求的 Origin。
		if (this.registryRef) {
			for (const extension of [ext.spike, ext.codemode, ext.toolSearch]) {
				this.registryRef.install(extension as never);
			}
		}
		const list: unknown[] = [ext.spike, ext.codemode, ext.toolSearch];
		if (this.mcpExt && (this.mcpExt.tools?.length ?? 0) > 0) list.push(this.mcpExt);
		if (this.customExt && (this.customExt.tools?.length ?? 0) > 0) list.push(this.customExt);
		return list;
	}

	private async open(): Promise<Harness> {
		if (!this.harness) {
			await this.ensureMigrated();
			const deps = this.deps({ origin: "", userKey: "" });
			const models = createModels();
			// v0.27.0：启用自定义供应商时用它，否则回落到 DeepSeek 官方（env DEEPSEEK_API_KEY）
			const activeId = activeProviderId(deps.sql);
			const providerRow = activeId ? providersRepo.find(deps.sql, activeId) : undefined;
			// NERE-85：模型请求统一走带重试 + 空闲看门狗的 fetch；上游一次断流不再报废整轮。
			const providerFetch = createProviderFetch();
			if (providerRow) {
				models.setProvider(withProviderFetch(this.buildCustomProvider(providerRow), providerFetch) as never);
			} else {
				models.setProvider(withProviderFetch(deepseekProvider(), providerFetch) as never);
			}
			const registry = createRegistry();
			this.registryRef = registry as unknown as typeof this.registryRef;
			this.baseExt = createAgentExtensions({
				sql: deps.sql,
				settings: this.settingsPort(deps),
				files: this.fileService(deps),
				kb: this.kbService(deps),
				shares: this.shareService(deps),
				harness: () => this.harness as unknown as HarnessLike | null,
				apiKey: deps.apiKey,
				webFetch: this.webFetch(deps),
			});
			registry.install(this.baseExt.spike as never);
			// Code mode：模型写 JS 调 tools.<name>()，QuickJS WASM 沙箱内执行（workerd 原生支持）。
			registry.install(this.baseExt.codemode as never);
			registry.install(this.baseExt.toolSearch as never);
			// Durable Object SQLite: conversations survive DO restarts and redeploys.
			const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
			this.storageRef = storage;
			// MCP 扩展在表就绪后构建并安装；之后由 /api/mcp 变更时重建（缓存按实例传入，R5）。
			this.mcpExt = (await buildMcpExtension(deps.sql, this.mcpCache)) as never;
			if (this.mcpExt) registry.install(this.mcpExt);
			// 自定义工具（v0.36.0）：同样必须在 Harness.open 之前 install
			this.customExt = buildCustomToolsExtension(deps.sql, this.customToolNames) as never;
			if (this.customExt) registry.install(this.customExt as never);
			this.harness = await Harness.open(
				storage,
				{
					models,
					registry,
					settings: {
						compaction: compactionSettings(this.settingsPort(deps).get),
						// NERE-85：瞬时失败的重试收敛到 provider fetch 层（3 次尝试 + 退避），
						// 关掉内核按错误文本再重试整轮生成，否则一次断流会放大成 3×4 次请求、重复计费。
						retry: { enabled: false },
					},
				},
				ctx,
			);
			this.harnessOpens++;
			this.harness.resume();
		}
		return this.harness;
	}

	/** 把一条供应商记录构造成 pi-ai 的 Provider（OpenAI 兼容端点）。 */
	private buildCustomProvider(row: providersRepo.ProviderRow): object {
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

	/** 对话域服务（NERE-33）：流式与非流式共用 prepare → submit → finish。 */
	private chatService(deps: RequestDeps): ChatService {
		return createChatService({ sql: deps.sql, runtime: this.chatRuntime(deps) });
	}

	/** 对话域的 Harness 端口：open/重试、会话、扩展装配与事件泵留在 DO 组合根（ADR-0001 §4）。 */
	private chatRuntime(deps: RequestDeps): ChatRuntime {
		return {
			gate: this.chatGate,
			conversation: async (sessionId) => this.conversationFor(await this.open(), deps, sessionId),
			configure: async (handle, input) => {
				const conversation = conversationOf(handle);
				await conversation.configure(
					{
						model: { provider: this.providerId(deps), modelId: this.modelFor(deps, input.sessionId) },
						// 思考档位（v0.22.0）：off 时不产生 thinking 事件，前端自然不显示思考块。
						thinkingLevel: thinkingLevel(this.settingsPort(deps).get),
						extensions: this.agentExtensions(deps) as never,
						instructions: input.instructions,
					},
					ctx,
				);
			},
			instructions: (input) =>
				buildInstructions(
					{ sql: deps.sql, settings: this.settingsPort(deps), kb: this.kbService(deps) },
					input.inv,
					input.sessionId,
					input.message,
				),
			skillInvocation: (message) => parseSkillInvocation(deps.sql, message),
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
				stream.start(async (events) => {
					await onEvents(events as unknown as readonly ChatWatchEvent[]);
				});
				return {
					stop: async () => {
						await stream.stop();
					},
				};
			},
			abort: async (handle) => {
				await conversationOf(handle).abort(ctx);
			},
			reset: async (handle) => {
				await conversationOf(handle).reset(undefined, ctx);
			},
			compact: async (handle, instructions) => String(await conversationOf(handle).compact(instructions, ctx)),
			reflect: (conversationId, transcript) =>
				reflectConversation({ sql: deps.sql, apiKey: deps.apiKey }, conversationId, transcript),
			usageTokens: async (handle) => this.goalTokens(await this.open(), handle.id),
			recover: () => this.recoverSession(),
			scheduleAlarm: () => this.scheduleNextAlarm(),
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise);
			},
		};
	}

	/** 会话当前供应商 / 模型（未设置时用默认）。 */
	private providerId(deps: RequestDeps): string {
		return activeProviderId(deps.sql) || DEFAULT_PROVIDER.id;
	}

	private defaultModelId(deps: RequestDeps): string {
		return activeModelIds(deps.sql)[0] ?? DEFAULT_MODEL_ID;
	}

	private modelFor(deps: RequestDeps, sessionId?: string): string {
		const available = activeModelIds(deps.sql);
		if (!sessionId) return available[0] ?? DEFAULT_MODEL_ID;
		try {
			const model = getModel(deps.sql, sessionId);
			return model && available.includes(model) ? model : (available[0] ?? DEFAULT_MODEL_ID);
		} catch {
			return available[0] ?? DEFAULT_MODEL_ID;
		}
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

	private async conversationFor(harness: Harness, deps: RequestDeps, sessionId?: string) {
		return this.retryOnSessionError(harness, (h) => this.findConversation(h, deps, sessionId));
	}

	private async findConversation(harness: Harness, deps: RequestDeps, sessionId?: string) {
		const agentChange = {
			model: { provider: this.providerId(deps), modelId: this.modelFor(deps, sessionId) },
			extensions: this.agentExtensions(deps) as never,
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
	private sessionRuntime(deps: RequestDeps): SessionRuntime {
		return {
			entries: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
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
								model: { provider: this.providerId(deps), modelId: this.defaultModelId(deps) },
								extensions: this.agentExtensions(deps) as never,
							},
						},
						ctx,
					),
				);
				return String(conversation.id);
			},
			forkBefore: async (sessionId, entryId) => {
				const harness = await this.open();
				const parent = await this.conversationFor(harness, deps, sessionId);
				const typed = parent as unknown as {
					id: number;
					entries(query: object, limit: number, cursor: undefined, c: unknown): Promise<{ items: readonly { id?: unknown }[] }>;
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
			modelFor: (sessionId) => this.modelFor(deps, sessionId),
			pauseGoal: (sessionId) => {
				try {
					writeGoal(deps.sql, sessionId, { status: "paused", next_run_at: 0 });
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
			conversationId: async (sessionId) =>
				String((await this.conversationFor(await this.open(), this.deps({ origin: "", userKey: "" }), sessionId)).id),
			entries: async (sessionId) => {
				const conversation = await (await this.open()).conversation(Number(sessionId) as never, ctx);
				if (!conversation) return [];
				const page = await conversation.entries({}, 500, undefined, ctx);
				return page.items;
			},
		};
	}

	private automationService(): AutomationService {
		return createAutomationService(this.db());
	}

	private settingsRuntime(): SettingsRuntime {
		return { recover: () => this.recoverSession() };
	}

	private alarmRuntime(): AlarmRuntime {
		return { schedule: () => this.scheduleNextAlarm() };
	}

	private contextRuntime(deps: RequestDeps): ContextRuntime {
		return {
			usage: async (sessionId) => {
				const service = createContextService({
					entries: async (id) => {
						const harness = await this.open();
						const conversation = await this.conversationFor(harness, deps, id);
						const page = await conversation.entries({}, 500, undefined, ctx);
						return page.items as readonly Record<string, unknown>[];
					},
				});
				return service.usage(sessionId);
			},
		};
	}

	private goalRuntime(deps: RequestDeps): GoalRuntime {
		return {
			baselineTokens: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				return this.goalTokens(harness, conversation.id);
			},
		};
	}

	/** R5：工具清单与自定义工具名都按实例取，不读模块级集合。 */
	private toolRuntime(): ToolRuntime {
		return {
			names: () => {
				const names = new Set<string>();
				for (const ext of [
					this.baseExt?.spike,
					this.baseExt?.codemode,
					this.baseExt?.toolSearch,
					this.mcpExt,
					this.customExt,
				] as unknown as { tools?: { name?: string }[] }[]) {
					for (const tool of ext?.tools ?? []) if (tool.name) names.add(tool.name);
				}
				return [...names];
			},
			customNames: () => [...this.customToolNames],
		};
	}

	private mcpRuntime(deps: RequestDeps): McpRuntime {
		return {
			rebuild: async () => {
				this.mcpCache.clear();
				const rebuilt = await buildMcpExtension(deps.sql, this.mcpCache);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
				return rebuilt?.tools?.length ?? 0;
			},
		};
	}

	/** 数据域端口：导出/反思读 Harness；恢复后清 MCP 缓存并重建扩展。 */
	private dataRuntime(deps: RequestDeps): DataRuntime {
		return {
			exportSnapshot: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				const page = (await conversation.entries({}, 1000, undefined, ctx)) as {
					items: readonly Record<string, unknown>[];
				};
				const id = String(conversation.id);
				let title = `会话 ${id}`;
				try {
					const row = sessionsRepo.get(deps.sql, id);
					if (row?.title) title = row.title;
				} catch {
					// 元数据缺失时用默认标题
				}
				return { sessionId: id, title, entries: page.items };
			},
			reflect: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				const page = (await conversation.entries({}, 1, undefined, ctx)) as { items: readonly { id?: number }[] };
				return this.chatService(deps).maybeReflect(conversation as never, Number(page.items[0]?.id ?? 0));
			},
			afterRestore: async () => {
				this.mcpCache.clear();
				const rebuilt = await buildMcpExtension(deps.sql, this.mcpCache);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
			},
		};
	}

	/** 系统域端口：`/debug/agent` 的注册表快照（可附带本轮 instructions）。 */
	private debugRuntime(deps: RequestDeps): DebugRuntime {
		return {
			inspect: async ({ message, sessionId }) => {
				const harness = await this.open();
				const root = await this.retryOnSessionError(harness, (h) => h.root(ctx));
				const mcpExtDbg = await buildMcpExtension(deps.sql, this.mcpCache);
				if (mcpExtDbg && this.registryRef) this.registryRef.install(mcpExtDbg);
				if (!this.customExt) this.customExt = buildCustomToolsExtension(deps.sql, this.customToolNames) as never;
				await (root as unknown as { configure(options: unknown, c: unknown): Promise<void> }).configure(
					{ extensions: this.agentExtensions(deps) as never },
					ctx,
				);
				const agent = await root.agent(ctx);
				const a = agent as unknown as {
					tools?: readonly { name?: string }[];
					callable?: readonly { name?: string }[];
					deferred?: readonly { name?: string }[];
					extensions?: readonly { name?: string }[];
					sections?: readonly { key?: string }[];
				};
				const names = (x?: readonly { name?: string }[]) => (x ?? []).map((t) => t.name);
				return {
					tools: names(a.tools),
					callable: names(a.callable),
					deferred: names(a.deferred),
					extensions: names(a.extensions),
					sections: (a.sections ?? []).map((x) => x.key),
					mcpToolCount: mcpExtDbg ? (mcpExtDbg.tools?.length ?? 0) : 0,
					customToolCount: (this.customExt as { tools?: unknown[] } | null)?.tools?.length ?? 0,
					installed: this.registryRef?.snapshot().installed().map((e) => e.name) ?? null,
					// 传 message 时返回本轮 instructions，用于确认技能 / 知识库预检索的注入（v0.46.0）
					instructions:
						message
							? (
									await buildInstructions(
										{ sql: deps.sql, settings: this.settingsPort(deps), kb: this.kbService(deps) },
										null,
										sessionId,
										message,
									)
								).instructions
							: undefined,
				};
			},
		};
	}

	private customToolsRuntime(deps: RequestDeps): CustomToolsRuntime {
		return {
			save: (body) => {
				const saved = saveCustomTool(deps.sql, body as never, this.customToolNames);
				this.customExt = saved.extension as never;
				if (this.registryRef) this.registryRef.install(this.customExt as never);
				return { name: saved.name, tools: saved.extension.tools?.length ?? 0 };
			},
			remove: (name) => {
				const removed = removeCustomTool(deps.sql, name, this.customToolNames);
				this.customExt = removed.extension as never;
				if (this.registryRef) this.registryRef.install(this.customExt as never);
				return { tools: removed.extension.tools?.length ?? 0 };
			},
		};
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

	/**
	 * 清空该 DO 的全部存储（NERE-24 purge）：先关 Harness，再删 SQL/条目/闹钟。
	 * 迁移备忘一起清掉，下一次任何请求（包括旧分享链接）会重建空 schema。
	 */
	private async purgeStorage(): Promise<void> {
		await this.recoverSession();
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm().catch(() => {});
		this.migrated = null;
		this.storageRef = null;
		this.registryRef = null;
		this.baseExt = null;
		this.mcpExt = null;
		this.customExt = null;
		this.customToolNames.clear();
		this.mcpCache.clear();
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
		return this.handleAlarm();
	}

	private async handleAlarm(): Promise<void> {
		try {
			await this.open();
			const deps = this.deps({ origin: settingsRepo.get(this.db(), "share_origin", ""), userKey: "" });
			const now = Date.now();
			const automations = this.automationService();
			const due = automations.due(now);
			const chat = this.chatService(deps);
			// 每轮建新会话（NERE-84）：复用 `/sessions` 的创建路径，元数据与默认模型一致。
			const sessions = createSessionService({ sql: deps.sql, runtime: this.sessionRuntime(deps) });
			await runDueAutomations(due, now, automations, {
				createSession: async () => (await sessions.create()).id,
				hasActive: (sessionId) => chat.hasActive(sessionId),
				run: async (job) => {
					await chat.chat({ message: job.prompt, sessionId: job.session_id || undefined });
				},
				recover: () => this.recoverSession(),
			});
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

	/** 估算当前上下文占用（v0.42.0）：最近一次模型用量 + 之后新增内容的字符估算。 */
	private async goalTokens(harness: Harness, conversationId: unknown): Promise<number> {
		try {
			const usage = await (harness as unknown as {
				snapshot(
					token: unknown,
					id: unknown,
					c: unknown,
				): Promise<{
					models?: Record<string, { totalTokens?: number }>;
					tools?: Record<string, { totalTokens?: number }>;
				} | undefined>;
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
		// 跨 DO 内部协议（NERE-24）：只有 Worker 主动发起的请求带这个头，客户端伪造会在 Worker 层被剥离。
		const internal = url.pathname.startsWith("/internal/");
		if (internal && request.headers.get("x-pi-internal") !== "1") {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		const deps = this.deps({
			env,
			origin: url.origin,
			userKey: request.headers.get("x-pi-user") ?? "",
			apiKey: env.DEEPSEEK_API_KEY ?? null,
			scopeId: this.scopeId(),
		});
		// 每个请求绑定自己的 SQL / Harness / 端口，避免同一 isolate 里的其它 DO 串数据（不再有 ALS）。
		const context = buildContext({
			req: request,
			env,
			scopeId: deps.scopeId,
			userKey: deps.userKey,
			origin: deps.origin,
			sql: deps.sql,
			ensureMigrated: () => this.ensureMigrated(),
			open: () => this.open(),
			sessionRuntime: this.sessionRuntime(deps),
			shareRuntime: this.shareRuntime(),
			userLifecycleRuntime: { purge: () => this.purgeStorage() },
			settings: this.settingsPort(deps),
			setSetting: (key, value) => settingsRepo.set(deps.sql, key, value),
			settingsRuntime: this.settingsRuntime(),
			alarmRuntime: this.alarmRuntime(),
			contextRuntime: this.contextRuntime(deps),
			goalRuntime: this.goalRuntime(deps),
			toolRuntime: this.toolRuntime(),
			mcpRuntime: this.mcpRuntime(deps),
			chatRuntime: this.chatRuntime(deps),
			dataRuntime: this.dataRuntime(deps),
			debugRuntime: this.debugRuntime(deps),
			customToolsRuntime: this.customToolsRuntime(deps),
			webFetch: this.webFetch(deps),
		});
		return dispatch(context, internal ? internalRoutes : undefined);
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
	/** 注册表 DDL 只在首次 fetch 执行一次；SQL 在 db/migrations.ts（阶段 6）。 */
	private migrated: Promise<void> | null = null;

	private ensureMigrated(): Promise<void> {
		this.migrated ??= Promise.resolve()
			.then(() => {
				migrateRegistry(this.ctx.storage.sql as unknown as SqlHandle);
			})
			.catch((err) => {
				this.migrated = null;
				throw err;
			});
		return this.migrated;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		await this.ensureMigrated();
		const db = this.ctx.storage.sql as unknown as SqlHandle;
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
				const id = (url.searchParams.get("id") ?? "").trim();
				const rows = id ? db.exec("DELETE FROM users WHERE id = ? RETURNING id", id).toArray() : [];
				return Response.json({ ok: true, id, deleted: rows.length > 0 });
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

/* ---------------- 用户吊销 / 数据处置（NERE-24） ---------------- */

/** 用户 DO 的显式内部调用：只在 Worker 侧构造，带内部头，客户端同名头在转发前被剥离。 */
async function callUserData<T>(
	env: Pick<AppEnv, "SpikeAgent">,
	userId: string,
	path: string,
	method: "GET" | "POST",
): Promise<T> {
	const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName(`user:${userId}`));
	const res = await stub.fetch(
		new Request(`https://user${path}`, { method, headers: { "x-pi-internal": "1" } }),
	);
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) {
		throw new AppError("cleanup_failed", 502, `用户数据处置失败：${data.error ?? res.status}`, true);
	}
	return data as T;
}

async function callRegistry<T>(
	env: Pick<AppEnv, "UserRegistry">,
	path: string,
	method: "GET" | "DELETE",
): Promise<T> {
	const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
	const res = await registry.fetch(
		new Request(`https://registry${path}`, { method, headers: { "x-pi-internal": "1" } }),
	);
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) {
		throw new AppError("registry_failed", 502, `注册表操作失败：${data.error ?? res.status}`, true);
	}
	return data as T;
}

function userAdmin(env: AppEnv) {
	return createUserAdminService({
		deleteRegistryUser: async (id) => {
			const data = await callRegistry<{ deleted?: boolean }>(
				env,
				`/users?id=${encodeURIComponent(id)}`,
				"DELETE",
			);
			return { deleted: Boolean(data.deleted) };
		},
		registryHas: async (id) => {
			const data = await callRegistry<{ ok?: boolean }>(
				env,
				`/internal/user-status?userId=${encodeURIComponent(id)}`,
				"GET",
			);
			return Boolean(data.ok);
		},
		revoke: (id) => callUserData<RevokeResult>(env, id, "/internal/revoke-user", "POST"),
		backup: (id) => callUserData<BackupPayload>(env, id, "/internal/user-backup", "GET"),
		purge: async (id) => {
			const data = await callUserData<{ purged: UserDataCounts }>(env, id, "/internal/purge-user", "POST");
			return data.purged;
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

		// 用户管理：仅主人；注册表 CRUD 转发到轻量 DO，吊销/导出/清空走显式跨 DO 协议（NERE-24）。
		const userPath =
			url.pathname === "/api/users" ||
			url.pathname === "/api/users/reset" ||
			url.pathname === "/api/users/export" ||
			url.pathname === "/api/users/data";
		if (userPath && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
			if (protect && !userId) return Response.json({ error: "未登录" }, { status: 401 });
			if (protect && userId !== OWNER_ID) return Response.json({ error: "只有主人可以管理用户" }, { status: 403 });
			try {
				const admin = userAdmin(env);
				const id = (url.searchParams.get("id") ?? "").trim();
				if (url.pathname === "/api/users/export" && request.method === "GET") {
					const backup = await admin.exportData(id);
					return new Response(JSON.stringify(backup), {
						headers: {
							"content-type": "application/json; charset=utf-8",
							"content-disposition": `attachment; filename="user-${id || "unknown"}-backup.json"`,
						},
					});
				}
				if (url.pathname === "/api/users/data" && request.method === "DELETE") {
					const purged = await admin.purge(id, url.searchParams.get("confirm"));
					return Response.json({ ok: true, id, purged });
				}
				if (url.pathname === "/api/users" && request.method === "DELETE") {
					return Response.json(await admin.remove(id));
				}

				const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
				const inner = new URL(request.url);
				inner.pathname = url.pathname.replace(/^\/api/, "");
				const headers = new Headers(request.headers);
				headers.delete("x-pi-user");
				headers.delete("x-pi-internal");
				const method: string = request.method;
				const init: RequestInit = { method, headers };
				if (method !== "GET" && method !== "HEAD") init.body = request.body;
				return registry.fetch(new Request(inner, init));
			} catch (err) {
				return toResponse(err);
			}
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
			headers.delete("x-pi-internal");
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
			headers.delete("x-pi-internal");
			headers.set("x-pi-user", who);
			const init: RequestInit = { method: request.method, headers };
			if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
			return stub.fetch(new Request(inner, init));
		}
		return Response.json({ ok: true, name: "pi-harness-spike" });
	},
};

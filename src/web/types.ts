/** One tool call shown as an expandable pill (summary = truncated brief, full = original text). */
export interface ToolCallInfo {
	name: string;
	summary: string;
	full?: string;
	/** 运行时 id（v0.22.0）：用于把 codemode 的内嵌调用挂到父调用下。 */
	id?: string;
	/** 父调用 id：有值时表示这是 codemode 脚本里发起的嵌套调用。 */
	parentId?: string;
	/** 运行状态。 */
	status?: "running" | "done" | "error";
	/** 工具入参（仅运行中保留，用于渲染计划等结构化结果）。 */
	args?: unknown;
}

/** 计划步骤（update_plan 工具，v0.22.0）。 */
export interface PlanStep {
	title: string;
	status: "pending" | "in_progress" | "completed";
}

/** 聊天里出现的文件产出（write_file 的副作用，v0.22.0）。 */
export interface FileArtifact {
	name: string;
	/** 内容长度（字符），未知时省略。 */
	size?: number;
}

/** 分享链接（share_file / share_conversation 工具结果，v0.55.0）。 */
export interface ShareLink {
	url: string;
	title: string;
	kind: "file" | "conversation";
	/** 0 = 永久。 */
	expiresAt: number;
	createdAt?: string;
	/** 复用了已有未过期链接。 */
	reused?: boolean;
}

/** 一条知识库命中（NERE-40）：随 assistant entry 落库，用于消息下方「参考资料」。 */
export interface KbRef {
	docId: number;
	chunkId: number;
	/** 命中的分块序号（从 0 开始），仅用于标注「第 N 段」，不做正文定位。 */
	chunkSeq: number;
	title: string;
	/** 来源（文件名 / 链接），可缺省。 */
	source?: string;
}

/** 从消息里的参考资料跳到知识库（NERE-41）。nonce 让「重复点同一段」也能再次触发。 */
export interface KbFocus {
	docId: number;
	chunkSeq?: number;
	nonce: number;
}

/** 一条分享记录（NERE-42 的 /api/shares/all）。与工具结果里的 ShareLink 不是同一件事。 */
export interface ShareRecord {
	token: string;
	kind: "file" | "conversation";
	name: string;
	/** epoch 毫秒；0 = 永久有效。 */
	expiresAt: number;
	createdAt: string;
	openCount: number;
	/** epoch 毫秒；0 = 从未打开。 */
	lastOpenedAt: number;
	sessionId: string;
	/** 相对路径；渲染前经 lib/format.shareUrlFor 归一化。 */
	url: string;
}

/** Message list entry. notice = system hint (stopped / reset failed...); tool = orphan tool activity row. */
export type ChatMessage =
	| { id: string; role: "user"; text: string; images?: string[]; /** 后端条目 id（v0.32.0：分支用）。 */ entryId?: number }
	| {
			id: string;
			role: "assistant";
			text: string;
			tools?: ToolCallInfo[];
			/** 思考过程（v0.22.0）：模型开 reasoning 时累积的 thinking 文本。 */
			thinking?: string;
			error?: boolean;
			/** 本轮产出的文件（由 write_file 工具结果提取）。 */
			files?: FileArtifact[];
			/** 本轮生成的分享链接（v0.55.0）。 */
			shares?: ShareLink[];
			/** 本轮知识库命中（NERE-40）；缺省或空数组时不渲染任何 UI。 */
			kbRefs?: KbRef[];
	  }
	| { id: string; role: "tool"; tools: ToolCallInfo[] }
	| { id: string; role: "notice"; text: string };

/** Session list item for the left sidebar. */
export interface SessionListItem {
	id: string;
	title: string;
	createdAt: string;
	/** 该会话使用的模型（v6）；旧数据可能为空。 */
	model?: string;
	/** 分支来源会话（v0.32.0）：有值表示这是从某个会话分叉出来的。 */
	parentId?: string;
	/** 分叉点条目 id（v0.32.0）。 */
	forkAt?: number;
}

/** Virtual file produced by the agent's write_file tool. */
export interface FileInfo {
	name: string;
	size: number;
	updatedAt: string;
}

/** Memory library entry. */
export interface MemoryInfo {
	id: number;
	content: string;
	createdAt: string;
	/** manual = 显式保存；reflect = 会话末自动抽取。旧数据可能为空。 */
	source?: string;
}

/** An MCP server the agent can call tools from (v5). */
export interface McpServerInfo {
	id: string;
	name: string;
	url: string;
	created_at?: string;
}

/** 定时任务的调度（NERE-65）：daily 用 time，interval 用 minutes。 */
export interface AutomationSchedule {
	kind: "daily" | "interval";
	time?: string;
	minutes?: number;
}

/** 上次运行结果（NERE-68 2b）：成功 / 失败 / 会话忙顺延。 */
export type AutomationRunStatus = "ok" | "failed" | "deferred";

/** A scheduled prompt that runs on its own (v0.8.0). */
export interface AutomationInfo {
	id: string;
	name: string;
	prompt: string;
	/** 人类可读的调度说明，由解析器生成。 */
	scheduleLabel: string;
	nextLabel?: string;
	enabled: boolean;
	/** 原始调度，供编辑弹窗回填（NERE-65）；解析失败时由解析器给默认值。 */
	schedule?: AutomationSchedule;
	/** 归属会话，供编辑弹窗回填（NERE-65），也是「查看产出」的跳转目标（NERE-68）。 */
	sessionId?: string;
	/** 上次执行时间（毫秒）；后端写成功也写失败（NERE-68 2a 只展示，不判断成败）。缺失 / null 不渲染。 */
	lastRunAt?: number;
	/** 上次运行结果（NERE-68 2b）；NULL / 未知值解析为 undefined（不渲染徽标）。 */
	lastStatus?: AutomationRunStatus;
	/** 上次失败原因（v1.0.4）；仅 lastStatus = "failed" 时有值。 */
	lastError?: string;
}

/** PATCH /api/automations 的请求体（NERE-64 契约；enabled 原样带回，编辑不改启停）。 */
export interface AutomationPatch {
	id: string;
	name: string;
	prompt: string;
	schedule: AutomationSchedule;
	sessionId: string;
	enabled: boolean;
}

/**
 * 目标（v0.31.0）：绑定一个会话的长期目标。
 * status: active 进行中 / done 已完成 / blocked 受阻 / paused 手动暂停 / exhausted 预算用尽
 */
export interface GoalInfo {
	objective: string;
	status: "active" | "done" | "blocked" | "paused" | "exhausted";
	tokenBudget: number;
	tokensUsed: number;
	turns: number;
	maxTurns: number;
	summary?: string;
	updatedAt?: string;
}

/** ask_user 的一个问题（v0.37.0）。 */
export interface AskItem {
	id: string;
	question: string;
	options?: { label: string; description?: string; recommended?: boolean }[];
	allowText?: boolean;
}

/** 待回答的问题组（v0.37.0）。 */
export interface AskQuestion {
	id: number;
	title?: string;
	questions: AskItem[];
	created_at?: string;
}

/** 自定义工具（v0.36.0）：用户贴的 JS，沙箱执行后成为模型可调用的工具。 */
export interface CustomToolInfo {
	name: string;
	description: string;
	/** 参数 JSON Schema 字符串。 */
	parameters: string;
	code: string;
	createdAt?: string;
}

/** 待审批的工具调用（v0.33.0）。 */
export interface ApprovalInfo {
	id: number;
	tool: string;
	category: string;
	/** 调用参数的 JSON 预览（截断）。 */
	args: string;
	created_at: string;
}

/** 提示模板（v0.31.0）：输入 / 选中后把正文填进输入框。 */
export interface PromptInfo {
	name: string;
	description: string;
	content: string;
}

/** 规则文件（v0.31.0）：启用后每轮注入 instructions。 */
export interface RuleInfo {
	name: string;
	content: string;
	enabled: boolean;
}

/** A named instruction the agent loads on demand (v0.15.0). */
export interface SkillInfo {
	name: string;
	description: string;
	content: string;
	/** 运行时（NERE-59）：prompt / javascript / typescript；缺省表示服务端未提供。 */
	runtime?: string;
	/** 审计结论快照（NERE-59）：来自 GET /skills 的 auditStatus。 */
	auditStatus?: SkillAuditStatus;
	/** 安装时间（NERE-59）：ISO 字符串，用于「装了 7 天还没用过」的提示。 */
	createdAt?: string;
	/**
	 * 最后一次 load_skill / 显式调用 `/name` 的时间（NERE-59，epoch ms）。
	 * `null` = 从未使用；`undefined` = 服务端没有埋点数据（整行不渲染）。
	 */
	lastInvokedAt?: number | null;
}

/** Skill Hub 审计结论（NERE-53 契约 §3）：pass 通过 / warn 有风险 / blocked 不可安装。 */
export type SkillAuditStatus = "pass" | "warn" | "blocked";

/** 审计时检测到的能力（NERE-53 契约 §3）：运行时、出站域名、依赖工具。 */
export interface SkillAuditDetected {
	runtime: string;
	network: string[];
	tools: string[];
}

/** 审计原因（NERE-53 契约 §4.4）：message 是唯一给用户看的解释；rule / evidence 便于定位。 */
export interface SkillAuditReason {
	rule?: string;
	level?: SkillAuditStatus;
	message: string;
	evidence?: string;
}

/** 一条技能的审计报告（NERE-53 契约 §4.4）。 */
export interface SkillAudit {
	status: SkillAuditStatus;
	/** 兼容早期 `reasons: string[]`；解析后统一成结构化对象。 */
	reasons: SkillAuditReason[];
	detected: SkillAuditDetected;
	auditedAt?: string;
	/** 本次审计实际计算出的 contentHash。 */
	hash?: string;
	rulesVersion?: number;
	auditSource?: "local" | "catalog";
}

/** Skill Hub 市场条目（NERE-53 契约 §5.2 的 HubSkill）。 */
export interface SkillHubEntry {
	name: string;
	version: string;
	description: string;
	author: string;
	/** 来源 URL（存量技能为 "local"）。 */
	source: string;
	/** 运行时枚举：prompt / javascript / typescript 可安装；python / shell 等被审计挡下。 */
	runtime: string;
	tags: string[];
	license: string;
	contentHash: string;
	/** 服务端计算的已安装状态（比页面级技能列表更权威）。 */
	installed: boolean;
	/** 同名已安装但内容不同：前端提示「可更新」。 */
	installedHash?: string;
	audit: SkillAudit;
	/** 直接安装地址；缺省时回退 source（必须是 http(s) URL）。 */
	installUrl?: string;
}

/**
 * 技能安装结果（NERE-69）：Hub 行内要展示失败原因，`onInstall` 不能只回布尔。
 * `message` 优先取 `details.audit.reasons[0].message`，缺失时回退到接口 `error`。
 */
export type SkillInstallOutcome = { ok: true; name?: string } | { ok: false; message: string };

/** 全部文件总览条目（v0.45.0）：文件 + 所属会话。 */
export interface AllFileInfo extends FileInfo {
	sessionId: string;
	sessionTitle: string;
}

/** 知识库文档（v0.45.0）：每个用户独立。 */
export interface KbDocInfo {
	id: number;
	title: string;
	source: string;
	tags: string;
	/** 正文字符数。 */
	size: number;
	/** 分块数（检索单位）。 */
	chunks: number;
	createdAt: string;
	updatedAt: string;
}

/** 知识库检索命中片段（v0.45.0）。 */
export interface KbHit {
	docId: number;
	title: string;
	source: string;
	text: string;
	chunkSeq: number;
	score: number;
}

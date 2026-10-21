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

/** 分享工具产出的只读链接（v0.55.0：share_file / share_conversation）。 */
export interface ShareLinkInfo {
	url: string;
	title: string;
	/** 人读的有效期文案，如「有效期至 2026-10-28 20:00」或「长期有效」。 */
	expiresLabel: string;
	kind: "file" | "conversation";
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
			/** 本轮生成的分享链接（由 share_file / share_conversation 工具结果提取）。 */
			shares?: ShareLinkInfo[];
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

/** A scheduled prompt that runs on its own (v0.8.0). */
export interface AutomationInfo {
	id: string;
	name: string;
	prompt: string;
	/** 人类可读的调度说明，由解析器生成。 */
	scheduleLabel: string;
	nextLabel?: string;
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
}

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

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

/** Message list entry. notice = system hint (stopped / reset failed...); tool = orphan tool activity row. */
export type ChatMessage =
	| { id: string; role: "user"; text: string; images?: string[] }
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

/** A named instruction the agent loads on demand (v0.15.0). */
export interface SkillInfo {
	name: string;
	description: string;
	content: string;
}

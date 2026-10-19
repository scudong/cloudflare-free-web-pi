/** One tool call shown as an expandable pill (summary = truncated brief, full = original text). */
export interface ToolCallInfo {
	name: string;
	summary: string;
	full?: string;
}

/** Message list entry. notice = system hint (stopped / reset failed...); tool = orphan tool activity row. */
export type ChatMessage =
	| { id: string; role: "user"; text: string }
	| { id: string; role: "assistant"; text: string; tools?: ToolCallInfo[]; error?: boolean }
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

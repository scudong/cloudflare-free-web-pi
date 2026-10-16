/** 一轮工具调用的展示信息。 */
export interface ToolCallInfo {
	name: string;
	summary: string;
}

/** 消息列表条目。notice 为系统提示（停止等待 / 重置失败等）；tool 为孤立的工具活动条。 */
export type ChatMessage =
	| { id: string; role: "user"; text: string }
	| { id: string; role: "assistant"; text: string; tools?: ToolCallInfo[]; error?: boolean }
	| { id: string; role: "tool"; tools: ToolCallInfo[] }
	| { id: string; role: "notice"; text: string };

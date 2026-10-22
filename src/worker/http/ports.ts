/**
 * Route ↔ DO 组合根之间的端口（ADR-0001 §9.2「端口增长规则」）。
 * http 层只依赖这里的形状；Service 向下依赖端口，避免 http → services → http 的环。
 */

import type { KbRef } from "../lib/kb";

/** `app_settings` 读取端口（阶段 2 的 KbSettings 同形，阶段 6 统一收口）。 */
export type SettingsPort = { get(key: string, fallback: string): string };

/** 邀请用户 id 形如 u_ab12cd34；新分享 token 以 `<userId>.` 前缀路由到该用户的 DO。 */
export const USER_ID_RE = /^u_[a-z0-9]{6,16}$/;

/** 用户分享 token 前缀；主人（owner）不加前缀，保持旧链接形态。 */
export function shareTokenPrefix(userKey: string): string {
	return USER_ID_RE.test(userKey) ? `${userKey}.` : "";
}

/** 从 token 解出所属邀请用户 id；主人 / 旧链接（无前缀）返回 undefined。 */
export function shareTokenOwner(token: string): string | undefined {
	const dot = token.indexOf(".");
	if (dot < 0) return undefined;
	const candidate = token.slice(0, dot);
	return USER_ID_RE.test(candidate) ? candidate : undefined;
}

/**
 * 分享域的 Harness 端口（阶段 3）：由 DO 组合根实现。
 * 只有确实要读会话条目时才会 open()；文件分享、失效/过期 token 不碰它。
 */
export type ShareRuntime = {
	/** 会话 id 解析（缺省回落根会话）；POST /share 与 GET /shares 用它取真实会话 id。 */
	conversationId(sessionId?: string): Promise<string>;
	/** 会话条目；会话不存在时返回空数组（与旧 renderShare 一致）。 */
	entries(sessionId: string): Promise<readonly unknown[]>;
};

/* ---------------- 阶段 4：设置 / 自动化 / 上下文 / 能力 / MCP ---------------- */

/** 设置域：压缩策略或当前供应商变更后重建 Harness（先写库后重建）。 */
export type SettingsRuntime = { recover(): Promise<void> };

/** 自动化域：`/automations`、`/goal` 改变调度后重排 alarm。 */
export type AlarmRuntime = { schedule(): Promise<void> };

export type ContextUsage = { usedTokens: number; contextWindow: number; percent: number; approximate: boolean };

/** 上下文用量端口：`GET /context` 需要 Harness 条目，留在 DO。 */
export type ContextRuntime = { usage(sessionId?: string): Promise<ContextUsage> };

/** 目标域：建立目标前需要会话累计 token 基线（Harness 用量快照）。 */
export type GoalRuntime = { baselineTokens(sessionId: string): Promise<number> };

/** 能力域：`/tools` 需要当前已安装扩展的工具名，自定义工具集合来自 DO 实例（R5）。 */
export type ToolRuntime = { names(): string[]; customNames(): string[] };

/** MCP 域：配置变更后清空本 DO 的连接缓存并重建扩展，返回最新工具数。 */
export type McpRuntime = { rebuild(): Promise<number> };

/* ---------------- 阶段 5：对话域（NERE-33） ---------------- */

/**
 * 并发闸门（原 DO 的 `activeChats`）：同一 DO 内同一会话同时只跑一次提交。
 * 状态由 DO 组合根持有（`createChatGate()` 一次），Service 负责 enter/exit 时机。
 */
export type ChatGate = { has(key: string): boolean; enter(key: string): void; exit(key: string): void };

export function createChatGate(): ChatGate {
	const active = new Set<string>();
	return {
		has: (key) => active.has(key),
		enter: (key) => {
			active.add(key);
		},
		exit: (key) => {
			active.delete(key);
		},
	};
}

/** 显式技能调用（`/技能名`）：正文注入本轮 instructions，原文留在转录。 */
export type ChatSkillInvocation = { name: string; content: string; rest: string };

/** 会话句柄：pi-durable conversation 的结构子集；Service 不 import pi-durable。 */
export type ChatHandle = { readonly id: unknown };
/** 转录条目（pi-durable 的 entry）：Service 只读 id/kind/model，不解释内部结构。 */
export type ChatEntry = Record<string, unknown> & { id?: number };
export type ChatSubmission = { readonly id: string; readonly raw: unknown };
export type ChatSettled = { readonly status?: string; readonly type?: string; readonly answer?: unknown };
export type ChatToolSummary = { name: string; summary: string };

/** watchEvents 的事件形状（Service 只做 SSE 映射，不接触 Harness）。 */
export type ChatWatchEvent = {
	type: string;
	changes?: readonly { type?: string; delta?: string }[];
	toolName?: string;
	toolCallId?: string;
	parentToolCallId?: string;
	args?: unknown;
	entry?: { model?: readonly { content?: unknown; details?: unknown }[] };
	result?: { details?: unknown };
};

/**
 * 对话域的 Harness 端口：open/重试/conversation/扩展装配都在 DO 组合根。
 * Service 只编排顺序（prepare → submit → 标题/反思/目标续转），不接触 pi-durable 类型。
 */
export type ChatRuntime = {
	/** 本 DO 实例的并发闸门（原 `activeChats`）。 */
	readonly gate: ChatGate;
	/** 取/建会话（含 SessionFailed 重试）。 */
	conversation(sessionId?: string): Promise<ChatHandle>;
	/** 配置本轮 agent：模型/思考档位/扩展 + instructions。 */
	configure(handle: ChatHandle, input: { sessionId?: string; instructions: string }): Promise<void>;
	/** 组装本轮 instructions 与知识库引用（技能索引、目标、预检索）。 */
	instructions(input: {
		inv: ChatSkillInvocation | null;
		sessionId?: string;
		message: string;
	}): Promise<{ instructions: string; kbRefs: readonly KbRef[] }>;
	/** 解析 `/技能名`；未命中返回 null。 */
	skillInvocation(message: string): ChatSkillInvocation | null;
	toolNames(handle: ChatHandle): Promise<string[]>;
	/** 最近一条条目的 id（本轮 tools 的起点）。 */
	lastEntryId(handle: ChatHandle): Promise<number>;
	submit(
		handle: ChatHandle,
		input: { message: string; images?: string[]; whenBusy?: "steer" },
	): Promise<ChatSubmission>;
	wait(submission: ChatSubmission): Promise<ChatSettled>;
	commit(handle: ChatHandle, answer: unknown): Promise<ChatEntry | null>;
	entries(
		handle: ChatHandle,
		opts?: { limit?: number; order?: "descending" },
	): Promise<readonly ChatEntry[]>;
	watch(
		handle: ChatHandle,
		onEvents: (events: readonly ChatWatchEvent[]) => Promise<void> | void,
	): Promise<{ stop(): Promise<void> }>;
	abort(handle: ChatHandle): Promise<void>;
	reset(handle: ChatHandle): Promise<void>;
	compact(handle: ChatHandle, instructions?: string): Promise<string>;
	/** reflect：一次低成本模型调用抽取长期事实，返回入库条数。 */
	reflect(conversationId: string, transcript: string): Promise<number>;
	/** 会话累计 token（pi.usage 快照）。 */
	usageTokens(handle: ChatHandle): Promise<number>;
	/** SessionFailed 后重建 Harness。 */
	recover(): Promise<void>;
	scheduleAlarm(): Promise<void>;
	waitUntil(promise: Promise<unknown>): void;
};

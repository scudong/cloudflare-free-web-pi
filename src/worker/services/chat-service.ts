import type { SqlHandle } from "../db/migrations";
import type {
	ChatEntry,
	ChatHandle,
	ChatRuntime,
	ChatSettled,
	ChatToolSummary,
	ChatWatchEvent,
} from "../http/ports";
import type { KbRef } from "../lib/kb";
import { upsert as upsertEntryKbRefs } from "../repo/entry-kb-refs-repo";
import * as reflectRepo from "../repo/reflect-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import {
	GOAL_ROUNDS_PER_REQUEST,
	goalContinuePrompt,
	goalInfo,
	readGoal,
	writeGoal,
	type GoalRow,
} from "./goal-service";
import { readPending as readPendingQuestion } from "./question-service";

/**
 * 对话域用例（ADR-0001 §2 / architecture-map R11，NERE-33）。
 *
 * `POST /chat` 与 `POST /chat/stream` 共用同一条提交路径：
 *   prepare（技能解析 → instructions → configure → beforeId）
 *   → submit（submit → wait → commit → kbRefs）
 *   → finish（标题 → 工具摘要）；流式只额外负责把 Harness 事件泵成 SSE。
 *
 * Harness 的 open/重试/coversation/扩展装配留在 DO 组合根（`ChatRuntime`）；
 * 目标续转、并发闸门、reflection 节流与标题策略在这里，保证两条路径不再各写一份。
 */

/** SSE 事件：名称与 data 形状与旧 `runChatStream` 逐字一致。 */
export type ChatEvent =
	| { type: "thinking_start"; data: Record<string, never> }
	| { type: "thinking"; data: { delta: string } }
	| { type: "text"; data: { delta: string } }
	| { type: "compaction"; data: { status: "start" | "end" } }
	| { type: "tool_start"; data: { name: string; id?: string; parentId?: string; args?: unknown } }
	| {
			type: "tool_end";
			data: {
				name: string;
				id?: string;
				parentId?: string;
				summary?: string;
				details?: unknown;
			};
	  }
	| { type: "goal"; data: Record<string, unknown> }
	| { type: "error"; data: { message: string } }
	| {
			type: "done";
			data: { answer: string; tools: ChatToolSummary[]; kbRefs?: readonly KbRef[] };
	  };

export type ChatInput = { message: string; sessionId?: string; images?: string[] };

export type PreparedChat = {
	root: ChatHandle;
	/** 实际会话 id（缺省时为根会话）。 */
	sessionId: string;
	input: ChatInput;
	effectiveMessage: string;
	kbRefs: readonly KbRef[];
	beforeId: number;
};

/** 单轮结果：`ok:false` 保留旧实现的两种错误文案所需原始 JSON。 */
export type SubmitOutcome =
	| { ok: true; answer: string; entry: ChatEntry | null }
	| { ok: false; reason: string; raw: string };

export type ChatServiceDeps = { sql: SqlHandle; runtime: ChatRuntime };

export interface ChatService {
	/** 技能解析 → instructions → configure → beforeId；进入并发闸门。 */
	prepare(input: ChatInput): Promise<PreparedChat>;
	/** 一轮：submit → wait → commit（AssistantEntry）→ 记录 kbRefs。 */
	submit(prepared: PreparedChat, input: { message: string; images?: string[] }): Promise<SubmitOutcome>;
	/** 标题与工具摘要；返回时顺带给出最近条目 id（reflection 用）。 */
	finish(prepared: PreparedChat): Promise<{ tools: ChatToolSummary[]; lastId: number }>;
	/** 非流式完整流程；异常时按旧行为重建 Harness 后抛出。 */
	chat(input: ChatInput): Promise<{ answer: string; tools: ChatToolSummary[] }>;
	/** 流式：调用方传入已 prepared 的会话与 SSE emit。 */
	stream(prepared: PreparedChat, emit: (event: ChatEvent) => Promise<void>): Promise<void>;
	maybeReflect(root: ChatHandle, uptoId: number): Promise<number>;
	goalTick(sessionId: string): Promise<void>;
	interject(message: string, sessionId?: string): Promise<{ ok: true; id: string }>;
	abort(sessionId?: string): Promise<{ ok: true }>;
	reset(sessionId?: string): Promise<{ ok: true }>;
	compact(sessionId?: string, instructions?: string): Promise<{ ok: true; taskId: string }>;
	/** alarm 用：该会话是否正在跑对话（原 `activeChats.has`）。 */
	hasActive(sessionId?: string): boolean;
}

const SESSION_ERROR = /SessionFailed|storage error/i;
const DEFAULT_TITLE = "新会话";
const GENERATED_TITLE = /^会话 \d+$/;

/** assistant entry 的可见文本：字符串 content 或文本块数组。 */
function answerText(entry: ChatEntry | null): string {
	const model: unknown = entry?.model;
	if (!Array.isArray(model)) return "";
	const first: unknown = model[0];
	if (!first || typeof first !== "object" || !("content" in first)) return "";
	const content = first.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => {
			return Boolean(b) && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string";
		})
		.map((b) => b.text)
		.join("");
}

/** 本轮工具活动：只取 `beforeId` 之后新增的 `pi.tool-result`，最多 6 条。 */
function toolSummary(items: readonly ChatEntry[], beforeId: number): ChatToolSummary[] {
	const tools: ChatToolSummary[] = [];
	for (const entry of items) {
		if (entry.kind !== "pi.tool-result") continue;
		if (Number(entry.id ?? 0) <= beforeId) continue;
		const model: unknown = entry.model;
		if (!Array.isArray(model)) continue;
		const first: unknown = model[0];
		if (!first || typeof first !== "object") continue;
		const name = "toolName" in first && typeof first.toolName === "string" ? first.toolName : "tool";
		const content = "content" in first && Array.isArray(first.content) ? first.content : [];
		const text = content
			.map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
			.join("");
		tools.push({ name, summary: text.slice(0, 80) });
	}
	return tools.slice(-6);
}

export function createChatService({ sql, runtime }: ChatServiceDeps): ChatService {
	const gate = runtime.gate;

	function maybeRecover(err: unknown): void {
		if (!SESSION_ERROR.test(String(err))) return;
		// 与原 chat()/chatStream() 包装一致：重建 Harness 但不重试本轮。
		void runtime.recover();
	}

	/** 标题策略（v0.22.0）：首轮取 effectiveMessage 前 24 字，之后只刷新时间。 */
	function updateTitle(conversationId: string, effectiveMessage: string): void {
		try {
			const now = new Date().toISOString();
			const existing = sessionsRepo.get(sql, conversationId)?.title;
			if (!existing || existing === DEFAULT_TITLE || GENERATED_TITLE.test(existing)) {
				sessionsRepo.upsertTitle(sql, conversationId, effectiveMessage.slice(0, 24), now);
			} else {
				sessionsRepo.touchUpdatedAt(sql, conversationId, now);
			}
		} catch (err) {
			console.warn("session meta update failed", err);
		}
	}

	/** 每轮结束后把会话累计 token 折算成目标消耗（原 DO 的 syncGoalProgress）。 */
	async function syncGoalProgress(handle: ChatHandle, sessionId: string, incrementTurn: boolean): Promise<GoalRow | null> {
		const row = readGoal(sql, sessionId);
		if (!row) return null;
		const total = await runtime.usageTokens(handle);
		// baseline = -1 表示目标由模型在对话中途建立：第一次同步以当前累计值为起点，不计之前的花费。
		const baseline = row.baseline_tokens < 0 ? total : row.baseline_tokens;
		const used = total > 0 ? Math.max(0, total - baseline) : row.tokens_used;
		const turns = row.turns + (incrementTurn ? 1 : 0);
		if (row.status !== "active") {
			// 已经结束的目标只补记本轮消耗，不再改变状态。
			writeGoal(sql, sessionId, { baseline_tokens: baseline, tokens_used: used, turns });
			return { ...row, baseline_tokens: baseline, tokens_used: used, turns };
		}
		let status = row.status;
		if (used >= row.token_budget || turns >= row.max_turns) status = "exhausted";
		const nextRunAt = status === "active" ? row.next_run_at : 0;
		writeGoal(sql, sessionId, { baseline_tokens: baseline, tokens_used: used, turns, status, next_run_at: nextRunAt });
		return { ...row, baseline_tokens: baseline, tokens_used: used, turns, status, next_run_at: nextRunAt };
	}

	async function submit(
		prepared: PreparedChat,
		input: { message: string; images?: string[] },
	): Promise<SubmitOutcome> {
		const submission = await runtime.submit(prepared.root, input);
		const settled: ChatSettled = await runtime.wait(submission);
		if (settled.status !== "done" || settled.type !== "input") {
			const raw = JSON.stringify(settled).slice(0, 300);
			return { ok: false, reason: `运行未完成：${JSON.stringify(settled).slice(0, 200)}`, raw };
		}
		const entry = await runtime.commit(prepared.root, settled.answer);
		// 目标续转不重算 instructions：同一请求里的每一轮都记同一份 kbRefs（NERE-40/41）。
		if (entry && prepared.kbRefs.length) {
			const entryId = Number(entry.id ?? 0);
			if (Number.isFinite(entryId) && entryId > 0) {
				upsertEntryKbRefs(sql, prepared.sessionId, entryId, prepared.kbRefs, new Date().toISOString());
			}
		}
		return { ok: true, answer: answerText(entry), entry };
	}

	async function finish(prepared: PreparedChat): Promise<{ tools: ChatToolSummary[]; lastId: number }> {
		updateTitle(prepared.sessionId, prepared.effectiveMessage);
		const page = await runtime.entries(prepared.root, { limit: 60 });
		const lastId = Number(page[0]?.id ?? 0);
		return { tools: toolSummary(page, prepared.beforeId), lastId };
	}

	/** watchEvents → SSE 事件映射（事件名与顺序与阶段 4 之前一致）。 */
	async function pumpEvents(events: readonly ChatWatchEvent[], emit: (event: ChatEvent) => Promise<void>): Promise<void> {
		for (const e of events) {
			if (e.type === "message_update") {
				for (const change of e.changes ?? []) {
					// 思考过程（v0.22.0）：模型开 reasoning 时逐字推送。
					if (change.type === "thinking_delta" && change.delta) await emit({ type: "thinking", data: { delta: change.delta } });
					else if (change.type === "thinking_start") await emit({ type: "thinking_start", data: {} });
					else if (change.type === "text_delta" && change.delta) await emit({ type: "text", data: { delta: change.delta } });
				}
			} else if (e.type === "compaction_start") {
				await emit({ type: "compaction", data: { status: "start" } });
			} else if (e.type === "compaction_end") {
				await emit({ type: "compaction", data: { status: "end" } });
			} else if (e.type === "tool_execution_start") {
				await emit({
					type: "tool_start",
					data: {
						name: e.toolName ?? "tool",
						id: e.toolCallId,
						parentId: e.parentToolCallId,
						args: e.args,
					},
				});
			} else if (e.type === "tool_execution_end") {
				const message = e.entry?.model?.[0];
				let summary: string | undefined;
				if (message && Array.isArray(message.content)) {
					summary =
						message.content
							.filter((b): b is { type: "text"; text: string } => {
								return Boolean(b) && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string";
							})
							.map((b) => b.text)
							.join("")
							.trim() || undefined;
				}
				await emit({
					type: "tool_end",
					data: {
						name: e.toolName ?? "tool",
						id: e.toolCallId,
						parentId: e.parentToolCallId,
						summary,
						details: e.result?.details ?? message?.details,
					},
				});
			}
		}
	}

	const service: ChatService = {
		async prepare(input) {
			const key = input.sessionId || "1";
			gate.enter(key);
			try {
				const root = await runtime.conversation(input.sessionId);
				// 显式技能调用（v0.23.0）：`/技能名` 命中后把技能正文注入本轮 instructions。
				const inv = runtime.skillInvocation(input.message);
				const effectiveMessage = inv ? inv.rest || `请按技能「${inv.name}」执行。` : input.message;
				// 会话首次创建后 agent 选择会固化在 pi.agent 文档里；幂等重设，保证新扩展开关对老会话也生效。
				const turn = await runtime.instructions({ inv, sessionId: input.sessionId, message: effectiveMessage });
				await runtime.configure(root, { sessionId: input.sessionId, instructions: turn.instructions });
				console.log("CHAT_TOOLS", JSON.stringify(await runtime.toolNames(root)));
				// 记录本轮起点：之后只把新增条目里的工具结果算作本轮工具活动。
				const beforeId = await runtime.lastEntryId(root);
				return {
					root,
					sessionId: String(root.id),
					input,
					effectiveMessage,
					kbRefs: turn.kbRefs,
					beforeId,
				};
			} catch (err) {
				gate.exit(key);
				// 旧 chatStream 包装会在 prepare 阶段重建 Harness；保持同样的错误恢复语义。
				if (SESSION_ERROR.test(String(err))) await runtime.recover();
				throw err;
			}
		},

		submit,

		finish,

		async chat(input) {
			const key = input.sessionId || "1";
			try {
				const prepared = await service.prepare(input);
				const outcome = await submit(prepared, { message: input.message, images: input.images });
				if (!outcome.ok) throw new Error(`run failed: ${outcome.raw}`);
				const final = await finish(prepared);
				// 与原 runChat 一致：反思在后台跑，不阻塞本轮返回。
				runtime.waitUntil(service.maybeReflect(prepared.root, final.lastId));
				return { answer: outcome.answer || "(empty)", tools: final.tools };
			} catch (err) {
				maybeRecover(err);
				throw err;
			} finally {
				gate.exit(key);
			}
		},

		async stream(prepared, emit) {
			const key = prepared.input.sessionId || "1";
			try {
				const watch = await runtime.watch(prepared.root, (events) => pumpEvents(events, emit));
				try {
					let answer = "";
					let prompt = prepared.input.message;
					let images = prepared.input.images;
					let round = 0;
					// 目标模式（v0.31.0）：一轮结束且目标仍在进行时自动续转，最多 3 轮/请求，其余交给 alarm。
					for (;;) {
						const outcome = await submit(prepared, { message: prompt, images });
						if (!outcome.ok) {
							await emit({ type: "error", data: { message: outcome.reason } });
							break;
						}
						answer = outcome.answer;
						round++;
						const goal = readGoal(sql, prepared.sessionId);
						if (!goal) break;
						const updated = await syncGoalProgress(prepared.root, prepared.sessionId, true);
						if (!updated) break;
						if (updated.status !== "active") {
							await emit({ type: "goal", data: { goal: goalInfo(updated), finished: true } });
							break;
						}
						// 有待回答的问题：暂停自动续转，等用户答完再说（v0.37.0）。
						const pendingQuestion = readPendingQuestion(sql, prepared.sessionId);
						if (pendingQuestion) {
							writeGoal(sql, prepared.sessionId, { next_run_at: 0 });
							await emit({
								type: "goal",
								data: { goal: goalInfo(updated), paused: true, questionId: pendingQuestion.id },
							});
							break;
						}
						if (round >= GOAL_ROUNDS_PER_REQUEST) {
							writeGoal(sql, prepared.sessionId, { next_run_at: Date.now() + 15_000 });
							await runtime.scheduleAlarm();
							await emit({
								type: "goal",
								data: { goal: goalInfo(readGoal(sql, prepared.sessionId)), scheduled: true },
							});
							break;
						}
						await emit({ type: "goal", data: { goal: goalInfo(updated), continuing: true, round } });
						prompt = goalContinuePrompt(updated);
						images = undefined;
					}
					const final = await finish(prepared);
					// kbRefs 与 entry 同一份：命中才带字段，未命中保持旧事件形状（NERE-40/41）。
					await emit({
						type: "done",
						data: {
							answer,
							tools: final.tools,
							...(prepared.kbRefs.length ? { kbRefs: prepared.kbRefs } : {}),
						},
					});
					runtime.waitUntil(service.maybeReflect(prepared.root, final.lastId));
				} catch (err) {
					await emit({ type: "error", data: { message: String(err).slice(0, 300) } });
				} finally {
					await watch.stop().catch(() => {});
				}
			} catch (err) {
				maybeRecover(err);
				await emit({ type: "error", data: { message: String(err).slice(0, 300) } });
			} finally {
				gate.exit(key);
			}
		},

		async maybeReflect(root, uptoId) {
			try {
				const conversationId = String(root.id);
				const since = reflectRepo.getLastEntryId(sql, conversationId);
				if (uptoId - since < 6) return 0;
				const page = await runtime.entries(root, { limit: 40, order: "descending" });
				const lines: string[] = [];
				for (const entry of [...page].reverse()) {
					const kind = String(entry.kind ?? "");
					const text = JSON.stringify(entry.model ?? entry.data ?? "").slice(0, 800);
					if (kind === "pi.user") lines.push(`用户：${text}`);
					else if (kind === "pi.assistant") lines.push(`助手：${text}`);
				}
				const saved = await runtime.reflect(conversationId, lines.join("\n"));
				reflectRepo.setLastEntryId(sql, conversationId, uptoId, new Date().toISOString());
				return saved;
			} catch (err) {
				console.warn("maybeReflect skipped", err);
				return 0;
			}
		},

		async goalTick(sessionId) {
			const row = readGoal(sql, sessionId);
			if (!row || row.status !== "active") return;
			// 用户还没回答问题：暂停续转（v0.37.0）。
			if (readPendingQuestion(sql, sessionId)) {
				writeGoal(sql, sessionId, { next_run_at: 0 });
				return;
			}
			writeGoal(sql, sessionId, { next_run_at: 0 });
			gate.enter(sessionId);
			try {
				const conversation = await runtime.conversation(sessionId);
				await service.chat({ message: goalContinuePrompt(row), sessionId });
				const updated = await syncGoalProgress(conversation, sessionId, true);
				if (updated?.status === "active") {
					writeGoal(sessionId, { next_run_at: Date.now() + 15_000 });
				}
			} finally {
				gate.exit(sessionId);
			}
		},

		async interject(message, sessionId) {
			const text = message.trim();
			if (!text) throw new Error("插话内容不能为空");
			const handle = await runtime.conversation(sessionId);
			const submission = await runtime.submit(handle, { message: text, whenBusy: "steer" });
			return { ok: true, id: submission.id };
		},

		async abort(sessionId) {
			const handle = await runtime.conversation(sessionId);
			await runtime.abort(handle);
			return { ok: true };
		},

		async reset(sessionId) {
			const handle = await runtime.conversation(sessionId);
			await runtime.reset(handle);
			if (sessionId) sessionsRepo.rename(sql, sessionId, DEFAULT_TITLE, new Date().toISOString());
			return { ok: true };
		},

		async compact(sessionId, instructions) {
			const handle = await runtime.conversation(sessionId);
			const taskId = await runtime.compact(handle, instructions);
			return { ok: true, taskId };
		},

		hasActive(sessionId) {
			return gate.has(sessionId || "1");
		},
	};

	return service;
}

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import type { SqlHandle } from "../db/migrations";
import type { SettingsPort } from "../http/ports";
import { withApproval, type ToolGateDeps } from "../services/approval-service";
import type { FileService } from "../services/file-service";
import {
	GOAL_MAX_TURNS_DEFAULT,
	GOAL_TOKEN_BUDGET_DEFAULT,
	readGoal,
	startGoal,
	writeGoal,
} from "../services/goal-service";
import type { KbService, WebFetchResult } from "../services/kb-service";
import { normalizeSkillUrl } from "../lib/skill-import";
import { readPlan, savePlan } from "../services/plan-service";
import { record as recordQuestion, type AskItem, type AskOption } from "../services/question-service";
import type { ShareService } from "../services/share-service";
import { createSkillService, SkillApiError, trackSkillCall } from "../services/skill-service";
import { activeModelIds, activeProviderId, DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "../services/settings-service";
import * as memoryRepo from "../repo/memory-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import * as skillsRepo from "../repo/skills-repo";
import { shareExpiryLabel } from "../lib/share-render";

/**
 * 模型工具扩展（ADR-0001 §5.5）：只依赖显式注入的 Service / Repository。
 *
 * 这里没有隐式存储代理，也不读请求作用域：SQL、设置、文件/KB/分享服务与 Harness
 * 都由 DO 组合根按请求构造后传入。扩展按请求创建，`share_file` 的 Origin / userKey
 * 因此不需要隐式作用域也能拿到当前请求的值。
 */
export type HarnessLike = {
	createConversation(
		options: unknown,
		context: unknown,
	): Promise<{
		id: unknown;
		submit(input: unknown, context: unknown): Promise<{ wait(context: unknown): Promise<{ status: string; type?: string; answer?: unknown }> }>;
		entries(
			query: object,
			limit: number,
			cursor: undefined,
			context: unknown,
		): Promise<{ items: readonly unknown[] }>;
	}>;
	conversation(
		id: unknown,
		context: unknown,
	): Promise<{ agent(context: unknown): Promise<{ model?: { provider: string; modelId: string } }> } | null>;
};

export type SpikeToolDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	files: FileService;
	kb: KbService;
	shares: ShareService;
	/** 当前 DO 的 Harness；open() 之前或不可用时返回 null。 */
	harness(): HarnessLike | null;
	apiKey: string | null;
	webFetch(url: string): Promise<WebFetchResult>;
};

export type AgentExtensions = {
	spike: { name: string; tools?: { name: string }[] };
	codemode: { name: string; tools?: { name: string }[] };
	toolSearch: { name: string; tools?: { name: string }[] };
};

const stripHtml = (html: string) =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 6000);

/** 当前请求的 Harness 上下文（pi-durable 的 BACKGROUND_CONTEXT）。 */
const harnessContext = BACKGROUND_CONTEXT;

export function createAgentExtensions(deps: SpikeToolDeps): AgentExtensions {
	const { sql, settings, files, kb, shares } = deps;
	const gate: ToolGateDeps = { sql: () => sql, get: settings.get };
	const now = () => new Date().toISOString();

	const base = defineExtension({
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
					memoryRepo.insert(sql, content, now());
					return { output: [{ type: "text", text: "已保存到记忆库。" }] };
				},
			}),
			defineTool({
				name: "recall",
				description: "按关键词检索记忆库",
				parameters: Type.Object({ query: Type.String({ description: "关键词（空格分隔多个）" }) }),
				execute: async (args) => {
					const q = String((args as { query?: unknown }).query ?? "").trim();
					const rows = memoryRepo.listContents(sql).map((content) => ({ content }));
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
					const rows = skillsRepo.listSkillRows(sql).filter((row) => row.auditStatus !== "blocked");
					const text = rows.length
						? rows.map((r) => `- ${r.name}：${r.description || "（无描述）"}`).join("\n")
						: "还没有安装任何技能。";
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "load_skill",
				description: "读取某个技能的完整说明（步骤/模板/约束），按说明完成任务",
				parameters: Type.Object({ name: Type.String({ description: "技能名称" }) }),
				execute: async (args) => {
					const name = String((args as { name?: unknown }).name ?? "").trim();
					const row = skillsRepo.getSkillRow(sql, name);
					if (!row) return { output: [{ type: "text", text: `技能「${name}」不存在，可用 list_skills 查看。` }] };
					if (row.auditStatus === "blocked") {
						// 准入：blocked 行即使因历史原因存在也不可加载（契约 §5.5）
						let reason = "";
						try {
							const report = JSON.parse(row.auditReport || "{}") as { reasons?: { message?: string }[] };
							reason = report.reasons?.[0]?.message ?? "";
						} catch {
							// 报告损坏时只给通用原因
						}
						return { output: [{ type: "text", text: `技能「${name}」未通过安全审计，不能加载。${reason}` }] };
					}
					trackSkillCall(sql, name, "loaded");
					return { output: [{ type: "text", text: row.content }] };
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
						const result = await createSkillService({ sql, settings }).importSkill({
							url,
							...(name ? { name } : {}),
						});
						const warn =
							result.audit.status === "warn"
								? `（审计告警：${result.audit.reasons.map((r) => r.message).join("；")}）`
								: "";
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
					const steps: { title: string; status: "pending" | "in_progress" | "completed" }[] = [];
					for (const item of list.slice(0, 20)) {
						const o = (item ?? {}) as { title?: unknown; status?: unknown };
						const title = String(o.title ?? "").trim().slice(0, 120);
						if (!title) continue;
						const s = String(o.status ?? "pending");
						steps.push({ title, status: s === "completed" || s === "in_progress" ? s : "pending" });
					}
					if (!steps.length) return { output: [{ type: "text", text: "计划为空，未保存。" }] };
					savePlan(sql, String(api.conversationId), steps);
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
					const existing = readGoal(sql, sid);
					if (existing?.status === "active") {
						return { output: [{ type: "text", text: `当前会话已有进行中的目标「${existing.objective}」，先完成或停止它。` }] };
					}
					const budget = Math.max(10_000, Math.floor(Number(a.tokenBudget ?? GOAL_TOKEN_BUDGET_DEFAULT) || GOAL_TOKEN_BUDGET_DEFAULT));
					const turns = Math.min(50, Math.max(1, Math.floor(Number(a.maxTurns ?? GOAL_MAX_TURNS_DEFAULT) || GOAL_MAX_TURNS_DEFAULT)));
					// baseline = -1：目标由模型在对话中途建立，真实基线在下一轮同步时以当时累计值为准
					startGoal(sql, { sessionId: sid, objective, tokenBudget: budget, maxTurns: turns, baseline: -1 });
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
					const row = readGoal(sql, sid);
					if (!row || row.status !== "active") {
						return { output: [{ type: "text", text: "当前会话没有进行中的目标。" }] };
					}
					const evidence = String(a.evidence ?? "").trim();
					if (evidence.length < 10) {
						return { output: [{ type: "text", text: "证据太短（至少 10 字）。请说明你实际做了什么、用什么方式验证的，再调用本工具。" }] };
					}
					// 完成硬校验：计划里不能还有没做完的步骤
					const steps = readPlan(sql, sid);
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
					writeGoal(sql, sid, { status: "done", summary: `${summary}\n\n证据：${evidence.slice(0, 400)}`, next_run_at: 0 });
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
					const row = readGoal(sql, sid);
					if (!row || row.status !== "active") return { output: [{ type: "text", text: "当前会话没有进行中的目标。" }] };
					const reason = String((args as { reason?: unknown }).reason ?? "").trim().slice(0, 500) || "未说明";
					writeGoal(sql, sid, { status: "blocked", summary: reason, next_run_at: 0 });
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
					const id = recordQuestion(sql, sid, {
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
					const harness = deps.harness();
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
					let model = {
						provider: activeProviderId(sql) || DEFAULT_PROVIDER.id,
						modelId: activeModelIds(sql)[0] ?? DEFAULT_MODEL_ID,
					};
					try {
						const parent = await harness.conversation(api.conversationId, harnessContext);
						const agent = parent ? await parent.agent(harnessContext) : null;
						if (agent?.model) model = { provider: agent.model.provider, modelId: agent.model.modelId };
					} catch {
						// 取不到就用默认
					}

					// 子代理只给只读类工具，避免并发写文件/记忆
					const allTools = [
						...((spikeDefinition.tools ?? []) as unknown as { name: string }[]),
						...((extensions.codemode.tools ?? []) as unknown as { name: string }[]),
					];
					const allowedNames: Record<string, true> = {
						now: true,
						recall: true,
						read_file: true,
						list_files: true,
						http_fetch: true,
						web_search: true,
						web_fetch_page: true,
						codemode: true,
					};
					const modelTools = allTools.filter((t) => allowedNames[t.name]);
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
									agent: {
										model,
										extensions: [spikeDefinition, extensions.codemode],
										instructions,
										modelTools,
									},
								},
								harnessContext,
							);
							// 子代理会话标记为隐藏，不出现在侧栏
							sessionsRepo.insertHiddenIfAbsent(
								sql,
								String(conv.id),
								`子代理 ${index + 1}：${task.title || "未命名"}`,
								now(),
							);
							const submission = await conv.submit({ type: "input", content: task.prompt }, harnessContext);
							const settled = await submission.wait(harnessContext);
							if (settled.status !== "done" || settled.type !== "input") {
								return { title: task.title, ok: false, text: `（子任务未完成：${settled.status}）`, ms: Date.now() - started };
							}
							// settled.answer 可能只是这一轮的工具调用消息；改为读会话里最新一条含文本的助手条目
							let text = "";
							try {
								const page = await conv.entries({}, 20, undefined, harnessContext);
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
					const summary = results
						.map((r, i) => `${i + 1}. ${r.title} — ${r.ok ? "完成" : "失败"} · ${(r.ms / 1000).toFixed(1)}s`)
						.join("\n");
					return {
						output: [{
							type: "text",
							text: `已并行完成 ${results.filter((r) => r.ok).length}/${results.length} 个子任务：\n${summary}\n\n${parts.join("\n\n")}`,
						}],
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
					if (settings.get("web_search", "1") !== "1") {
						return { output: [{ type: "text", text: "网页搜索当前未开启。请告诉用户：在 设置 → 网页搜索 中开启后即可联网搜索。" }] };
					}
					const apiKey = deps.apiKey;
					if (!apiKey) return { output: [{ type: "text", text: "未配置 DEEPSEEK_API_KEY，无法联网搜索。" }] };
					const count = Math.min(50, Math.max(1, Math.floor(Number(a.count ?? 8) || 8)));
					try {
						const resp = await fetch("https://api.deepseek.com/v1/tools/search", {
							method: "POST",
							headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
							body: JSON.stringify({ query, count, need_content: false }),
						});
						const data = (await resp.json().catch(() => null)) as {
							results?: unknown;
							error?: { message?: string };
						} | null;
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
					if (settings.get("web_search", "1") !== "1") {
						return { output: [{ type: "text", text: "网页搜索当前未开启。请告诉用户：在 设置 → 网页搜索 中开启后即可抓取网页。" }] };
					}
					const page = await deps.webFetch(url);
					if (!page.ok) return { output: [{ type: "text", text: page.message }] };
					return {
						output: [{ type: "text", text: (page.title ? `# ${page.title}\n\n` : "") + page.content.slice(0, 8000) }],
					};
				},
			}),
			defineTool({
				name: "write_file",
				description:
					"把内容写入工作台文件（覆盖同名）；适合报告、笔记、代码、数据。文件会出现在右侧工作台面板，需要发给他人时可用 share_file 生成分享链接",
				parameters: Type.Object({
					name: Type.String({ description: "文件名，如 report.md / notes.txt / main.js" }),
					content: Type.String({ description: "完整文件内容" }),
				}),
				execute: async (args, api) => {
					const a = args as { name?: unknown; content?: unknown };
					const name = String(a.name ?? "").trim().replace(/^[/.]+/, "").slice(0, 120);
					if (!name) return { output: [{ type: "text", text: "文件名不能为空。" }] };
					const content = String(a.content ?? "");
					files.write(String(api.conversationId), name, content);
					return {
						output: [{ type: "text", text: `已写入 ${name}（${content.length} 字符）。需要发给他人时可用 share_file 生成分享链接。` }],
					};
				},
			}),
			defineTool({
				name: "read_file",
				description: "读取工作台文件内容",
				parameters: Type.Object({ name: Type.String({ description: "文件名" }) }),
				execute: async (args, api) => {
					const name = String((args as { name?: unknown }).name ?? "").replace(/^[/.]+/, "");
					const rows = files.read(String(api.conversationId), name);
					return { output: [{ type: "text", text: rows?.content ?? `文件 ${name} 不存在。` }] };
				},
			}),
			defineTool({
				name: "list_files",
				description: "列出工作台全部文件",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					const rows = files.list(String(api.conversationId));
					const text = rows.length
						? rows.map((r) => `${r.name} · ${r.size} 字符 · ${r.updated_at.slice(0, 16).replace("T", " ")}`).join("\n")
						: "工作台还没有文件。";
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
					const hits = await kb.searchAsync(query, Number(a.limit) || 6);
					if (!hits.length) {
						return { output: [{ type: "text", text: `知识库里没有匹配「${query}」的内容。可用 kb_list 查看已有哪些文档。` }] };
					}
					const lines = hits.map(
						(hit, i) =>
							`[${i + 1}] ${hit.title}${hit.source ? `（${hit.source}）` : ""} · 片段 ${hit.chunkSeq + 1}\n${String(hit.text).slice(0, 900)}`,
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
					const { id, chunks, vectorized, updated } = await kb.addIndexed({
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
					const docs = kb.listDocs();
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
					return { output: [{ type: "text", text: (await kb.remove(id)) ? `已删除文档 ${id}。` : `文档 ${id} 不存在。` }] };
				},
			}),
		],
	});

	const spikeDefinition = {
		...base,
		tools: (base.tools ?? []).map((tool) => withApproval(tool as never, gate)),
	};

	const baseToolSearch = createToolSearchExtension();
	const toolSearch = {
		...baseToolSearch,
		tools: (baseToolSearch.tools ?? []).map((tool) => withApproval(tool as never, gate)),
	};

	const baseCodemode = createCodemodeExtension({
		sandbox: createInlineCodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }),
		models: false,
	});
	const codemode = {
		...baseCodemode,
		tools: (baseCodemode.tools ?? []).map((tool) => withApproval(tool as never, gate)),
	};

	// dispatch_tasks 的闭包在扩展构造后才执行，因此可以引用最终对象。
	const extensions = { spike: spikeDefinition, codemode, toolSearch };
	return extensions;
}

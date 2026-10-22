import type { SqlHandle } from "../db/migrations";
import type { AlarmRuntime, DataRuntime } from "../http/ports";
import type { KbService } from "./kb-service";
import * as automationsRepo from "../repo/automations-repo";
import * as filesRepo from "../repo/files-repo";
import * as goalsRepo from "../repo/goals-repo";
import * as mcpRepo from "../repo/mcp-repo";
import * as memoryRepo from "../repo/memory-repo";
import * as plansRepo from "../repo/plans-repo";
import * as promptsRepo from "../repo/prompts-repo";
import * as providersRepo from "../repo/providers-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import * as settingsRepo from "../repo/settings-repo";
import * as sharesRepo from "../repo/shares-repo";
import * as skillsRepo from "../repo/skills-repo";
import { GOAL_MAX_TURNS_DEFAULT, GOAL_TOKEN_BUDGET_DEFAULT } from "./goal-service";
import { renderExportMarkdown } from "../lib/export-markdown";

/**
 * 数据域用例（ADR-0001 §2 / R8）：备份、恢复、导出、记忆。
 *
 * 备份/恢复只做编排，SQL 全部经 repo；Harness 相关（导出条目、reflect、恢复后重建 MCP）
 * 由 DO 通过 `DataRuntime` 端口注入，因此 Service 可以脱离 DO 单测。
 * `/backup`、`/restore` 的 JSON 结构与幂等语义逐字保持不变（R8 不在本阶段修）。
 */

export type DataServiceDeps = {
	sql: SqlHandle;
	kb: KbService;
	runtime: DataRuntime;
	/** 恢复完成后重排 alarm（旧 restore 的最后一步）。 */
	alarm: AlarmRuntime;
	now?: () => string;
};

export type BackupPayload = { version: number; exportedAt: string; data: Record<string, unknown> };

/**
 * 备份载荷（NERE-24 起也供用户数据导出复用）：纯 SQL 汇总，不读 Harness、不写库。
 * `kbDocs` 由调用方传入，避免本函数依赖 KbService 的检索/向量能力。
 */
export function buildBackup(input: {
	sql: SqlHandle;
	kbDocs: readonly unknown[];
	now?: () => string;
}): BackupPayload {
	const { sql, kbDocs, now = () => new Date().toISOString() } = input;
	return {
		version: 1,
		exportedAt: now(),
		data: {
			memories: memoryRepo.listForBackup(sql),
			files: filesRepo.listForBackup(sql),
			automations: automationsRepo.listForBackup(sql),
			mcpServers: mcpRepo.listForBackup(sql),
			sessions: sessionsRepo.listForBackup(sql),
			shares: sharesRepo.listForBackup(sql),
			skills: skillsRepo.listForBackup(sql),
			settings: settingsRepo.listAll(sql),
			plans: plansRepo.listForBackup(sql),
			providers: providersRepo.listForBackup(sql),
			prompts: promptsRepo.listPromptsForBackup(sql),
			rules: promptsRepo.listRulesForBackup(sql),
			goals: goalsRepo.listForBackup(sql),
			kbDocs,
		},
	};
}

export type DataService = {
	backup(): BackupPayload;
	restore(payload: unknown): Promise<Record<string, number>>;
	exportMarkdown(sessionId?: string): Promise<{ markdown: string; title: string; sessionId: string }>;
	reflect(sessionId?: string): Promise<{ ok: true; saved: number }>;
};

function str(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function num(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

/** 外部 JSON 的数组字段：只保留对象元素，逐字段读取时再窄化。 */
function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
	);
}

export function createDataService({ sql, kb, runtime, alarm, now = () => new Date().toISOString() }: DataServiceDeps): DataService {
	return {
		backup: () => buildBackup({ sql, kbDocs: kb.backupDocs(), now }),

		/** 从备份恢复：按主键 upsert，不删除现有数据。返回各类写入条数。 */
		restore: async (payload) => {
			// 外部 JSON 边界：只声明要读的 data 字段，字段内部仍逐项窄化。
			const data = (payload as { data?: unknown } | null)?.data;
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("备份格式不正确");
			const backup = data as Record<string, unknown>;
			const counts: Record<string, number> = {};
			const list = (key: string) => rows(backup[key]);

			for (const m of list("memories")) {
				const content = str(m.content).trim();
				if (!content) continue;
				if (memoryRepo.existsByContent(sql, content)) continue;
				memoryRepo.insertRestored(sql, {
					content,
					createdAt: str(m.created_at) || now(),
					source: str(m.source) || "manual",
				});
				counts.memories = (counts.memories ?? 0) + 1;
			}
			for (const f of list("files")) {
				const name = str(f.name).trim();
				if (!name) continue;
				filesRepo.restoreRow(sql, {
					conversation_id: str(f.conversation_id) || "1",
					name,
					content: str(f.content),
					updated_at: str(f.updated_at) || now(),
				});
				counts.files = (counts.files ?? 0) + 1;
			}
			for (const a of list("automations")) {
				const id = str(a.id);
				if (!id) continue;
				automationsRepo.restoreRow(
					sql,
					{
						id,
						name: str(a.name),
						prompt: str(a.prompt),
						session_id: str(a.session_id),
						schedule: str(a.schedule) || '{"kind":"daily","time":"09:00"}',
						enabled: num(a.enabled) ? 1 : 0,
						next_run_at: num(a.next_run_at) || Date.now() + 60_000,
					},
					now(),
				);
				counts.automations = (counts.automations ?? 0) + 1;
			}
			for (const k of list("skills")) {
				const name = str(k.name).trim();
				if (!name) continue;
				skillsRepo.restoreRow(sql, { name, description: str(k.description), content: str(k.content) }, now());
				counts.skills = (counts.skills ?? 0) + 1;
			}
			// 知识库只备份文档正文；恢复时分块并重建 FTS 索引（v0.45.0）
			for (const doc of list("kbDocs")) {
				const title = str(doc.title).trim();
				const content = str(doc.content).trim();
				if (!title || !content) continue;
				if (kb.hasDoc(title, content)) continue;
				const restored = await kb.add({ title, content, source: str(doc.source), tags: str(doc.tags) });
				if (restored.updated) counts.kbDocs = (counts.kbDocs ?? 0) + 1;
			}
			for (const s of list("mcpServers")) {
				const id = str(s.id);
				if (!id) continue;
				mcpRepo.restoreRow(sql, { id, name: str(s.name), url: str(s.url), headers: str(s.headers) || "{}" }, now());
				counts.mcpServers = (counts.mcpServers ?? 0) + 1;
			}
			// MCP 配置变化后必须重建本 DO 的扩展（旧 restore 的 fixed 行为）
			await runtime.afterRestore();
			for (const s of list("settings")) {
				const key = str(s.key).trim();
				if (!key) continue;
				settingsRepo.restoreRow(sql, { key, value: str(s.value) });
				counts.settings = (counts.settings ?? 0) + 1;
			}
			for (const pr of list("prompts")) {
				const name = str(pr.name).trim();
				if (!name) continue;
				promptsRepo.restorePrompt(sql, { name, description: str(pr.description), content: str(pr.content) }, now());
				counts.prompts = (counts.prompts ?? 0) + 1;
			}
			for (const rl of list("rules")) {
				const name = str(rl.name).trim();
				if (!name) continue;
				promptsRepo.restoreRule(sql, { name, content: str(rl.content), enabled: num(rl.enabled) ? 1 : 0 }, now());
				counts.rules = (counts.rules ?? 0) + 1;
			}
			for (const g of list("goals")) {
				const sid = str(g.session_id).trim();
				const objective = str(g.objective).trim();
				if (!sid || !objective) continue;
				goalsRepo.restoreRow(
					sql,
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
						created_at: str(g.created_at) || now(),
					},
					now(),
				);
				counts.goals = (counts.goals ?? 0) + 1;
			}
			for (const p of list("providers")) {
				const id = str(p.id).trim();
				if (!id) continue;
				providersRepo.restoreRow(
					sql,
					{ id, name: str(p.name), base_url: str(p.base_url), api_key: str(p.api_key), models: str(p.models) },
					now(),
				);
				counts.providers = (counts.providers ?? 0) + 1;
			}
			for (const p of list("plans")) {
				const conversationId = str(p.conversation_id);
				if (!conversationId) continue;
				plansRepo.restoreRow(sql, {
					conversation_id: conversationId,
					steps: str(p.steps) || "[]",
					updated_at: str(p.updated_at) || now(),
				});
				counts.plans = (counts.plans ?? 0) + 1;
			}
			for (const s of list("sessions")) {
				const id = str(s.id);
				if (!id) continue;
				sessionsRepo.restoreRow(sql, {
					id,
					title: str(s.title) || `会话 ${id}`,
					created_at: str(s.created_at) || now(),
					updated_at: str(s.updated_at) || now(),
					model: str(s.model) || "deepseek-flash",
				});
				counts.sessions = (counts.sessions ?? 0) + 1;
			}
			// 恢复后可能带回进行中的目标：重排闹钟（与旧 restore 的顺序一致，放在最后）
			await alarm.schedule();
			return counts;
		},

		exportMarkdown: async (sessionId) => {
			const snapshot = await runtime.exportSnapshot(sessionId);
			return renderExportMarkdown(snapshot, now());
		},

		reflect: async (sessionId) => ({ ok: true, saved: await runtime.reflect(sessionId) }),
	};
}


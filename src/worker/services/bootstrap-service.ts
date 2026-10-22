import type { SqlHandle } from "../db/migrations";
import type { SettingsPort } from "../http/ports";
import { collectBootstrap } from "../bootstrap";
import * as automationsRepo from "../repo/automations-repo";
import * as customToolsRepo from "../repo/custom-tools-repo";
import * as mcpRepo from "../repo/mcp-repo";
import { listPending as listPendingApprovals } from "./approval-service";
import { goalInfo, readGoal } from "./goal-service";
import { readPlan } from "./plan-service";
import { listPending as listPendingQuestions } from "./question-service";
import { createFileService } from "./file-service";
import { createMemoryService } from "./memory-service";
import { createPromptsService } from "./prompts-service";
import { createSessionService, type SessionRuntime } from "./session-service";
import { createSkillService } from "./skill-service";
import { activeModelIds, DEFAULT_MODEL_ID, settingsView, type SettingsEnv } from "./settings-service";

/**
 * 首屏聚合（NERE-23 / ADR-0001 §2）：一次读取所有只读面板。
 * 各 loader 与单端点共用同一实现；collectBootstrap 负责逐字段容错。
 */
export type BootstrapDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	env: SettingsEnv;
	sessionRuntime: SessionRuntime;
};

export function readBootstrap({ sql, settings, env, sessionRuntime }: BootstrapDeps, sessionId: string) {
	const session = createSessionService({ sql, runtime: sessionRuntime });
	const files = createFileService({ sql });
	const memories = createMemoryService(sql);
	const prompts = createPromptsService(sql);
	const skills = createSkillService({ sql, settings });
	const get = (key: string, fallback: string) => settings.get(key, fallback);

	return collectBootstrap({
		session: () => ({ ok: true, name: "pi-harness-spike" }),
		entries: () => session.entries(sessionId),
		sessions: async () => (await session.list()).sessions,
		files: () => files.list(sessionId),
		memories: () => memories.list(),
		approvals: () => listPendingApprovals(sql, sessionId),
		settings: () => settingsView(get, env),
		plan: () => readPlan(sql, sessionId),
		goal: () => goalInfo(readGoal(sql, sessionId)),
		questions: () => listPendingQuestions(sql, sessionId),
		prompts: () => prompts.listPrompts(),
		rules: () => prompts.listRules(),
		customTools: () => customToolsRepo.listAll(sql),
		skills: () => skills.listCompat().skills,
		automations: () => automationsRepo.list(sql),
		mcpServers: () => mcpRepo.list(sql),
		models: () => {
			const models = activeModelIds(sql);
			return { models, default: models[0] ?? DEFAULT_MODEL_ID };
		},
	});
}

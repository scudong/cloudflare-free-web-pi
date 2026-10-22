import type { SqlHandle } from "../db/migrations";
import * as promptsRepo from "../repo/prompts-repo";

/**
 * 提示模板与规则文件（v0.31.0 / ADR-0001 §2）：HTTP 之外的校验与编排。
 * 直接 SQL 在 `repo/prompts-repo.ts`。
 */
export class PromptsApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "PromptsApiError";
	}
}

export type RuleView = Omit<promptsRepo.RuleRow, "enabled"> & { enabled: boolean };

export type PromptInput = { name?: string; description?: string; content?: string };
export type RuleInput = { name?: string; content?: string; enabled?: boolean };

export type PromptsService = {
	listPrompts(): promptsRepo.PromptRow[];
	savePrompt(input: PromptInput): void;
	deletePrompt(name: string): void;
	listRules(): RuleView[];
	saveRule(input: RuleInput): void;
	setRuleEnabled(name: string | undefined, enabled: unknown): void;
	deleteRule(name: string): void;
};

/** 读列表失败时回退空数组（旧端点对缺表/坏库容错，面板不因它 500）。 */
function safe<T>(read: () => T[]): T[] {
	try {
		return read();
	} catch {
		return [];
	}
}

/** rules 注入 instructions：只取启用且正文非空的条目。 */
export function enabledRuleContents(sql: SqlHandle): string[] {
	return safe(() => promptsRepo.listRules(sql))
		.filter((rule) => rule.enabled)
		.map((rule) => rule.content.trim())
		.filter(Boolean);
}

export function createPromptsService(sql: SqlHandle, now: () => string = () => new Date().toISOString()): PromptsService {
	return {
		listPrompts: () => safe(() => promptsRepo.listPrompts(sql)),

		savePrompt: (input) => {
			const name = (input.name ?? "").trim().slice(0, 40);
			const content = (input.content ?? "").trim();
			if (!name || !content) throw new PromptsApiError(400, "需要名称与内容");
			promptsRepo.upsertPrompt(
				sql,
				{ name, description: (input.description ?? "").trim().slice(0, 120), content },
				now(),
			);
		},

		deletePrompt: (name) => promptsRepo.deletePrompt(sql, name),

		listRules: () => safe(() => promptsRepo.listRules(sql)).map((rule) => ({ ...rule, enabled: Boolean(rule.enabled) })),

		saveRule: (input) => {
			const name = (input.name ?? "").trim().slice(0, 40);
			const content = (input.content ?? "").trim();
			if (!name || !content) throw new PromptsApiError(400, "需要名称与内容");
			// 旧语义：只有显式 false 才停用。
			promptsRepo.upsertRule(sql, { name, content, enabled: input.enabled === false ? 0 : 1 }, now());
		},

		setRuleEnabled: (name, enabled) => {
			if (!name) throw new PromptsApiError(400, "缺少 name");
			promptsRepo.setRuleEnabled(sql, name, Boolean(enabled));
		},

		deleteRule: (name) => promptsRepo.deleteRule(sql, name),
	};
}

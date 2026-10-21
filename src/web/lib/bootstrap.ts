/**
 * /api/bootstrap 响应 → 各面板的领域模型（NERE-26）。
 *
 * 后端（NERE-23）已经做了一层逐面板容错：失败的数组面板回退 `[]`、对象面板回退 `null`，
 * 原因写进 `errors`。这里再做一次宽容解析，职责有两个：
 * 1. 把传输层 DTO 收敛成 `types.ts` 的领域类型，组件不直接认识接口字段；
 * 2. 后端字段缺失 / 旧版本没有聚合端点时，依然得到可渲染的空态，而不是让整页崩掉。
 *
 * 注意：`errors` 只做转发，不在这里拼接 UI 文案（文案属于页面层）。
 */

import type {
	AskQuestion,
	ApprovalInfo,
	AutomationInfo,
	CustomToolInfo,
	FileInfo,
	GoalInfo,
	McpServerInfo,
	MemoryInfo,
	PlanStep,
	PromptInfo,
	RuleInfo,
	SessionListItem,
	SkillInfo,
} from "../types";
import type { BootstrapKey, BootstrapResponse, ModelsView, SettingsView } from "./api";
import {
	parseAutomations,
	parseCustomTools,
	parseFiles,
	parseMemories,
	parsePrompts,
	parseRules,
	parseSessions,
	parseSkills,
} from "./collections";

export interface BootstrapPanels {
	session: { ok: boolean; name: string };
	entries: unknown[];
	sessions: SessionListItem[];
	files: FileInfo[];
	memories: MemoryInfo[];
	approvals: ApprovalInfo[];
	settings: SettingsView | null;
	plan: PlanStep[];
	goal: GoalInfo | null;
	questions: AskQuestion[];
	prompts: PromptInfo[];
	rules: RuleInfo[];
	customTools: CustomToolInfo[];
	skills: SkillInfo[];
	automations: AutomationInfo[];
	mcpServers: McpServerInfo[];
	models: { models: string[]; default: string };
	/** 后端记录的失败面板：键是面板名，值是截断后的错误摘要。 */
	errors: Partial<Record<BootstrapKey, string>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function records(raw: unknown): Record<string, unknown>[] {
	return (Array.isArray(raw) ? raw : []).filter(isObject);
}

function parseSession(raw: BootstrapResponse["session"]): { ok: boolean; name: string } {
	if (!isObject(raw)) return { ok: false, name: "" };
	return { ok: raw.ok !== false, name: text(raw.name) };
}

/** 兼容旧后端：entries 可能是数组本身，也可能包在 `{ entries: [...] }` 里。 */
function parseEntryList(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isObject(raw) && Array.isArray(raw.entries)) return raw.entries;
	return [];
}

function parsePlan(raw: unknown): PlanStep[] {
	const steps: PlanStep[] = [];
	for (const entry of records(raw)) {
		const title = text(entry.title).trim();
		if (!title) continue;
		const status = entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending";
		steps.push({ title, status });
	}
	return steps;
}

function parseGoal(raw: unknown): GoalInfo | null {
	if (!isObject(raw) || typeof raw.objective !== "string") return null;
	const statuses: GoalInfo["status"][] = ["active", "done", "blocked", "paused", "exhausted"];
	const status = statuses.find((value) => value === raw.status) ?? "active";
	return {
		objective: raw.objective,
		status,
		tokenBudget: num(raw.tokenBudget),
		tokensUsed: num(raw.tokensUsed),
		turns: num(raw.turns),
		maxTurns: num(raw.maxTurns),
		summary: typeof raw.summary === "string" ? raw.summary : undefined,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
	};
}

function parseApprovals(raw: unknown): ApprovalInfo[] {
	const approvals: ApprovalInfo[] = [];
	for (const entry of records(raw)) {
		if (typeof entry.id !== "number" || typeof entry.tool !== "string") continue;
		approvals.push({
			id: entry.id,
			tool: entry.tool,
			category: text(entry.category),
			args: text(entry.args),
			created_at: text(entry.created_at),
		});
	}
	return approvals;
}

function parseQuestions(raw: unknown): AskQuestion[] {
	const questions: AskQuestion[] = [];
	for (const entry of records(raw)) {
		if (typeof entry.id !== "number" || !Array.isArray(entry.questions)) continue;
		questions.push({
			id: entry.id,
			title: typeof entry.title === "string" ? entry.title : undefined,
			questions: entry.questions as AskQuestion["questions"],
			created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
		});
	}
	return questions;
}

function parseMcpServers(raw: unknown): McpServerInfo[] {
	const servers: McpServerInfo[] = [];
	for (const entry of records(raw)) {
		const name = text(entry.name);
		const url = text(entry.url);
		if (!name || !url) continue;
		const created = typeof entry.created_at === "string" ? entry.created_at : undefined;
		servers.push({ id: String(entry.id ?? ""), name, url, created_at: created });
	}
	return servers;
}

function parseModels(raw: ModelsView | null): { models: string[]; default: string } {
	if (!isObject(raw)) return { models: [], default: "" };
	const models = Array.isArray(raw.models) ? raw.models.filter((model): model is string => typeof model === "string") : [];
	const fallback = text(raw.default);
	return { models, default: fallback || models[0] || "" };
}

function parseErrors(raw: BootstrapResponse["errors"]): Partial<Record<BootstrapKey, string>> {
	if (!isObject(raw)) return {};
	const errors: Partial<Record<BootstrapKey, string>> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && value) errors[key as BootstrapKey] = value;
	}
	return errors;
}

export function parseBootstrap(raw: BootstrapResponse): BootstrapPanels {
	return {
		session: parseSession(raw.session),
		entries: parseEntryList(raw.entries),
		sessions: parseSessions(raw.sessions),
		files: parseFiles(raw.files),
		memories: parseMemories(raw.memories),
		approvals: parseApprovals(raw.approvals),
		settings: isObject(raw.settings) ? (raw.settings as SettingsView) : null,
		plan: parsePlan(raw.plan),
		goal: parseGoal(raw.goal),
		questions: parseQuestions(raw.questions),
		prompts: parsePrompts(raw.prompts),
		rules: parseRules(raw.rules),
		customTools: parseCustomTools(raw.customTools),
		skills: parseSkills(raw.skills),
		automations: parseAutomations(raw.automations),
		mcpServers: parseMcpServers(raw.mcpServers),
		models: parseModels(raw.models),
		errors: parseErrors(raw.errors),
	};
}

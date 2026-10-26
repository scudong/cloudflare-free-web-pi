/**
 * 定时任务编辑（NERE-65）：表单草稿、校验、PATCH 载荷与返回值合并。
 *
 * 全部是纯函数，组件只负责渲染与状态；这样「回填 / 非法输入 / 保存载荷 / 取消不改」
 * 都能在 node 环境直接单测（仓库没有 DOM 测试环境）。
 * 接口契约见 NERE-64：PATCH /api/automations 字段均可选，非法 → 400 `{error}`。
 */

import type { AutomationInfo, AutomationPatch, AutomationSchedule } from "../types";
import { DEFAULT_SCHEDULE, automationScheduleLabel, isDailyTime, parseAutomationSchedule } from "./automation-schedule";
import { isObject, pickFreshSession, pickString } from "./collections";
import { formatNextRunAt } from "./format";

/** 与后端 create 一致：name 1–40、prompt 1–2000（按 UTF-16 长度截断）。 */
export const AUTOMATION_NAME_MAX = 40;
export const AUTOMATION_PROMPT_MAX = 2000;

export type AutomationDraft = {
	name: string;
	prompt: string;
	kind: "daily" | "interval";
	/** daily 的 `HH:MM`；切换 kind 时保留，切回来不丢。 */
	time: string;
	/** interval 的分钟数，输入框保持字符串。 */
	minutes: string;
	sessionId: string;
	/** 每轮新建会话（NERE-84）：开关默认开，避免历史上下文越滚越大。 */
	freshSession: boolean;
};

export type AutomationDraftField = "name" | "prompt" | "time" | "minutes";

/** 校验后的可提交值（已 trim）。 */
export type AutomationDraftValue = {
	name: string;
	prompt: string;
	schedule: AutomationSchedule;
	sessionId: string;
	freshSession: boolean;
};

export type DraftValidation =
	| { ok: true; value: AutomationDraftValue }
	| { ok: false; field: AutomationDraftField; error: string };

/** 从列表行生成草稿（打开弹窗即回填当前值）。 */
export function draftFromJob(job: AutomationInfo, fallbackSessionId = ""): AutomationDraft {
	const schedule = job.schedule ?? DEFAULT_SCHEDULE;
	return {
		name: job.name,
		prompt: job.prompt,
		kind: schedule.kind,
		time: schedule.kind === "daily" ? (schedule.time ?? "09:00") : "09:00",
		minutes: String(schedule.kind === "interval" ? (schedule.minutes ?? 60) : 60),
		sessionId: job.sessionId ?? fallbackSessionId,
		// NERE-86：存量任务显示服务端当前值；老服务端没有该字段时按产品默认「开」。
		freshSession: job.freshSession ?? true,
	};
}

/** 前端先拦：空名称 / 空提示词 / 非法时间 / 非法间隔，文案直接可展示。 */
export function validateAutomationDraft(draft: AutomationDraft): DraftValidation {
	const name = draft.name.trim();
	if (!name) return { ok: false, field: "name", error: "名称不能为空。" };
	if (name.length > AUTOMATION_NAME_MAX) {
		return { ok: false, field: "name", error: `名称不能超过 ${AUTOMATION_NAME_MAX} 个字符。` };
	}

	const prompt = draft.prompt.trim();
	if (!prompt) return { ok: false, field: "prompt", error: "提示词不能为空。" };
	if (prompt.length > AUTOMATION_PROMPT_MAX) {
		return { ok: false, field: "prompt", error: `提示词不能超过 ${AUTOMATION_PROMPT_MAX} 个字符。` };
	}

	const sessionId = draft.sessionId.trim();
	if (draft.kind === "interval") {
		const minutes = Number(draft.minutes);
		if (!Number.isInteger(minutes) || minutes < 1) {
			return { ok: false, field: "minutes", error: "间隔分钟需为不小于 1 的整数。" };
		}
		return {
			ok: true,
			value: { name, prompt, sessionId, freshSession: draft.freshSession, schedule: { kind: "interval", minutes } },
		};
	}

	const time = draft.time.trim();
	if (!isDailyTime(time)) return { ok: false, field: "time", error: "执行时间需为 HH:MM（00:00–23:59）。" };
	return {
		ok: true,
		value: { name, prompt, sessionId, freshSession: draft.freshSession, schedule: { kind: "daily", time } },
	};
}

/** 组装 PATCH 载荷。enabled 原样带回：编辑不改启停，也避免旧后端把缺省值当 false。 */
export function buildAutomationPatch(
	job: Pick<AutomationInfo, "id" | "enabled">,
	value: AutomationDraftValue,
): AutomationPatch {
	return {
		id: job.id,
		name: value.name,
		prompt: value.prompt,
		schedule: value.schedule,
		sessionId: value.sessionId,
		enabled: job.enabled,
		// NERE-86：后端契约字段是 snake_case，整表单每次全量提交，开关也随之往返。
		fresh_session: value.freshSession,
	};
}

export type SaveAutomationResult =
	| { ok: true; patch: AutomationPatch }
	| { ok: false; error: string; field?: AutomationDraftField };

/**
 * 保存流程：先校验（不合法不发请求），再调 `save`。
 * 失败时返回可直接展示的文案，调用方保留输入。
 */
export async function submitAutomationDraft(
	job: Pick<AutomationInfo, "id" | "enabled">,
	draft: AutomationDraft,
	save: (patch: AutomationPatch) => Promise<{ ok: boolean; error?: string }>,
): Promise<SaveAutomationResult> {
	const validation = validateAutomationDraft(draft);
	if (!validation.ok) return { ok: false, error: validation.error, field: validation.field };
	const patch = buildAutomationPatch(job, validation.value);
	const result = await save(patch);
	return result.ok ? { ok: true, patch } : { ok: false, error: result.error?.trim() || "保存失败，请重试。" };
}

/** PATCH 返回的 `automation`：字段可能只给更新过的部分，解析成可合并的增量。 */
export type AutomationUpdate = {
	id: string;
	name?: string;
	prompt?: string;
	schedule?: AutomationSchedule;
	sessionId?: string;
	enabled?: boolean;
	nextRunAt?: number;
	/** 每轮新建会话（NERE-86）：PATCH 返回后即时回填，不必等下次刷新。 */
	freshSession?: boolean;
	/** 最近一次执行会话（NERE-86）：服务端随 automation 视图返回。 */
	lastSessionId?: string;
};

/** 宽容解析 PATCH 返回值（含 NERE-86 的 fresh_session / last_session_id）。 */
export function parseAutomationUpdate(raw: unknown): AutomationUpdate | null {
	if (!isObject(raw)) return null;
	const id = pickString(raw, ["id"]);
	if (!id) return null;

	const update: AutomationUpdate = { id };
	const name = pickString(raw, ["name"]);
	if (name) update.name = name;
	if (typeof raw.prompt === "string") update.prompt = raw.prompt;
	if (raw.schedule !== undefined && raw.schedule !== null) update.schedule = parseAutomationSchedule(raw.schedule);
	const sessionId = pickString(raw, ["session_id", "sessionId"]);
	if (sessionId) update.sessionId = sessionId;
	if (typeof raw.enabled === "boolean") update.enabled = raw.enabled;
	else if (typeof raw.enabled === "number") update.enabled = raw.enabled !== 0;
	const next = typeof raw.next_run_at === "number" ? raw.next_run_at : raw.nextRunAt;
	if (typeof next === "number") update.nextRunAt = next;
	const freshSession = pickFreshSession(raw);
	if (freshSession !== undefined) update.freshSession = freshSession;
	const lastSessionId = pickString(raw, ["last_session_id", "lastSessionId"]);
	if (lastSessionId) update.lastSessionId = lastSessionId;
	return update;
}

/** 把 PATCH 返回值落到列表项：保持顺序，未返回的字段沿用旧值。 */
export function mergeAutomationUpdate(items: AutomationInfo[], update: AutomationUpdate): AutomationInfo[] {
	let matched = false;
	const next = items.map((item) => {
		if (item.id !== update.id) return item;
		matched = true;
		return {
			...item,
			...(update.name !== undefined ? { name: update.name } : {}),
			...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
			...(update.sessionId !== undefined ? { sessionId: update.sessionId } : {}),
			...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
			...(update.schedule !== undefined
				? { schedule: update.schedule, scheduleLabel: automationScheduleLabel(update.schedule) }
				: {}),
			...(update.nextRunAt !== undefined ? { nextLabel: formatNextRunAt(update.nextRunAt) } : {}),
			...(update.freshSession !== undefined ? { freshSession: update.freshSession } : {}),
			...(update.lastSessionId !== undefined ? { lastSessionId: update.lastSessionId } : {}),
		};
	});
	return matched ? next : items;
}

/**
 * 「查看产出」的跳转目标（NERE-86）：优先最近一次执行实际用的会话 `last_session_id`，
 * 老数据 / 尚未执行过时回落到任务绑定的 `session_id`（向后兼容）。
 */
export function automationOutputSessionId(
	job: Pick<AutomationInfo, "lastSessionId" | "sessionId">,
): string | undefined {
	return job.lastSessionId || job.sessionId || undefined;
}

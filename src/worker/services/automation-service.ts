import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as automationsRepo from "../repo/automations-repo";
import * as goalsRepo from "../repo/goals-repo";

/**
 * 定时任务与 alarm 调度用例（ADR-0001 §2）：
 * `/automations*` 的 CRUD、下一次执行时间、到点筛选与顺延、目标到点会话。
 *
 * `alarm()` 仍是 DO 入口（包 `agentScope.run`），这里只做业务判断；
 * 真正调用 `chat()` / 写 `ctx.storage.setAlarm` 由 DO 组合根完成。
 */
export type Schedule = { kind: string; time?: string; minutes?: number };

const DAILY_DEFAULT: Schedule = { kind: "daily", time: "09:00" };

/** 计算下一次执行时间（毫秒）；daily 按 UTC+8 的 HH:MM。 */
export function nextRunAt(schedule: Schedule, now = Date.now()): number {
	if (schedule.kind === "interval") {
		const minutes = Math.max(1, Math.floor(Number(schedule.minutes ?? 60)));
		return now + minutes * 60_000;
	}
	const [hh, mm] = String(schedule.time ?? "09:00").split(":").map((v) => Number(v) || 0);
	const offsetMs = 8 * 3600_000;
	const local = new Date(now + offsetMs);
	const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh!, mm!, 0));
	let at = target.getTime() - offsetMs;
	if (at <= now) at += 24 * 3600_000;
	return at;
}

export class AutomationApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "AutomationApiError";
	}
}

export type AutomationInput = {
	name?: string;
	prompt?: string;
	sessionId?: string;
	schedule?: { kind?: string; time?: string; minutes?: number };
};

/** PATCH 请求体（NERE-64）：字段都可选，值来自 JSON，所以按 unknown 校验。 */
export type AutomationPatchInput = {
	name?: unknown;
	prompt?: unknown;
	sessionId?: unknown;
	schedule?: unknown;
	enabled?: unknown;
	/** PATCH `fresh_session`（NERE-84）：每轮新建会话开关。 */
	fresh_session?: unknown;
};

/** PATCH 返回给前端的任务形态；`next_run_at` 与列表同一口径。 */
export type AutomationView = {
	id: string;
	name: string;
	prompt: string;
	sessionId: string;
	schedule: Schedule;
	enabled: boolean;
	last_run_at: number | null;
	/** 上次运行结果（NERE-68）：ok / failed / deferred，老数据为 null。 */
	last_status: automationsRepo.AutomationLastStatus | null;
	/** 上次失败原因（v1.0.4）：仅 failed 时有值，成功 / 顺延 / 老数据为 null。 */
	last_error: string | null;
	/** 每轮新建会话（NERE-84）：1 = 不继承历史，0 = 固定使用 `sessionId`。 */
	fresh_session: boolean;
	/** 最近一次执行实际用的会话（NERE-84）；没有执行过为 null。 */
	last_session_id: string | null;
	next_run_at: number;
};

export const AUTOMATION_NAME_MAX = 40;
export const AUTOMATION_PROMPT_MAX = 2000;
/** `last_error` 上限（NERE-84）：只留错误摘要，够定位即可。 */
export const AUTOMATION_ERROR_MAX = 300;
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 编辑的调度校验：不合法直接 400，不做 create 那种静默兜底。 */
export function parseScheduleInput(raw: unknown): Schedule {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new AutomationApiError(400, "调度格式不正确");
	}
	const input = raw as { kind?: unknown; time?: unknown; minutes?: unknown };
	if (input.kind === "interval") {
		const minutes = Number(input.minutes);
		if (!Number.isInteger(minutes) || minutes < 1) throw new AutomationApiError(400, "间隔需为不小于 1 的整数分钟");
		return { kind: "interval", minutes };
	}
	if (input.kind === "daily") {
		const time = typeof input.time === "string" ? input.time.trim() : "";
		if (!DAILY_TIME.test(time)) throw new AutomationApiError(400, "时间需为 HH:MM（24 小时制）");
		return { kind: "daily", time };
	}
	throw new AutomationApiError(400, "调度类型需为 daily 或 interval");
}

/**
 * 校验 PATCH 并算出仓储增量（纯函数，便于单测）。
 * - 只校验传入的字段，未传的不动；
 * - 传了 schedule → `next_run_at = nextRunAt(newSchedule)`；
 * - 只传 enabled → 沿用旧启停语义（启用时 next_run_at = now+60s，停用不动）；
 * - 传了其他字段时即使带了 enabled 也不改 next_run_at（编辑不该把任务提前到 60 秒后）。
 */
export function buildAutomationPatch(body: AutomationPatchInput, now = Date.now()): automationsRepo.AutomationUpdate {
	const patch: automationsRepo.AutomationUpdate = {};
	if (body.name !== undefined) {
		if (typeof body.name !== "string") throw new AutomationApiError(400, "名称需为字符串");
		const name = body.name.trim();
		if (!name || name.length > AUTOMATION_NAME_MAX) {
			throw new AutomationApiError(400, `名称需为 1–${AUTOMATION_NAME_MAX} 个字符`);
		}
		patch.name = name;
	}
	if (body.prompt !== undefined) {
		if (typeof body.prompt !== "string") throw new AutomationApiError(400, "提示词需为字符串");
		const prompt = body.prompt.trim();
		if (!prompt || prompt.length > AUTOMATION_PROMPT_MAX) {
			throw new AutomationApiError(400, `提示词需为 1–${AUTOMATION_PROMPT_MAX} 个字符`);
		}
		patch.prompt = prompt;
	}
	if (body.sessionId !== undefined) {
		if (typeof body.sessionId !== "string") throw new AutomationApiError(400, "会话 ID 需为字符串");
		patch.sessionId = body.sessionId;
	}
	let schedule: Schedule | undefined;
	if (body.schedule !== undefined) {
		schedule = parseScheduleInput(body.schedule);
		patch.schedule = JSON.stringify(schedule);
	}
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") throw new AutomationApiError(400, "enabled 需为布尔值");
		patch.enabled = body.enabled;
	}
	if (body.fresh_session !== undefined) {
		if (typeof body.fresh_session !== "boolean") throw new AutomationApiError(400, "fresh_session 需为布尔值");
		patch.freshSession = body.fresh_session;
	}

	const onlyEnabled =
		body.enabled !== undefined &&
		body.name === undefined &&
		body.prompt === undefined &&
		body.sessionId === undefined &&
		body.schedule === undefined &&
		body.fresh_session === undefined;
	if (schedule) patch.nextRunAt = nextRunAt(schedule, now);
	else if (onlyEnabled && body.enabled === true) patch.nextRunAt = now + 60_000;
	return patch;
}

function parseStoredSchedule(raw: string): Schedule {
	try {
		const value = JSON.parse(raw) as Schedule;
		return value && typeof value === "object" ? value : DAILY_DEFAULT;
	} catch {
		return DAILY_DEFAULT;
	}
}

export function automationView(row: automationsRepo.AutomationRow): AutomationView {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		sessionId: row.session_id,
		schedule: parseStoredSchedule(row.schedule),
		enabled: row.enabled === 1,
		last_run_at: row.last_run_at,
		last_status: automationsRepo.parseLastStatus(row.last_status),
		last_error: row.last_error ?? null,
		fresh_session: row.fresh_session === 1,
		last_session_id: row.last_session_id ?? null,
		next_run_at: row.next_run_at,
	};
}

export type AutomationService = {
	list(): automationsRepo.AutomationRow[];
	create(body: AutomationInput): { id: string; nextRunAt: number };
	/** 编辑 / 启停（NERE-64）；只传 enabled 时与旧行为一致。 */
	update(id: string, body: AutomationPatchInput, now?: number): AutomationView;
	remove(id: string): void;
	/** alarm：到点且启用的任务。 */
	due(now: number): automationsRepo.AutomationDueRow[];
	/** 会话忙：顺延 5 分钟，只记 `last_status = deferred`（不改 last_run_at）。 */
	defer(id: string, now: number): void;
	/** 执行完一轮：写 last_run_at、last_status（ok / failed）、last_session_id 与下一次 next_run_at；失败附原因（v1.0.4）。 */
	markRun(
		job: { id: string; schedule: string },
		now: number,
		status: "ok" | "failed",
		error?: string,
		sessionId?: string | null,
	): void;
	/** 把任务绑定到实际执行的会话（NERE-84，fresh_session 轮换时调用）。 */
	bindSession(id: string, sessionId: string): void;
	/** 本轮处理过任务时，把仍落在过去的时间统一顺延 60s。 */
	rescheduleOverdue(now: number): void;
	/** alarm：到点且 active 的目标会话。 */
	dueGoals(now: number): string[];
	/** 目标忙：顺延 60s。 */
	deferGoal(sessionId: string, now: number): void;
	/** 任务与目标中最早的闹钟时刻；没有返回 null。 */
	nextAlarmAt(): number | null;
};

/** alarm 每轮需要的执行端口：新建会话、会话忙判断、提交一轮、失败后的会话恢复。 */
export type AutomationRunner = {
	/** 新建一个空会话并返回 id（NERE-84，复用 `/sessions` 的创建路径）。 */
	createSession(): Promise<string>;
	hasActive(sessionId: string): boolean;
	run(job: automationsRepo.AutomationDueRow): Promise<void>;
	recover(): Promise<void>;
};

/**
 * 执行一轮到点任务（NERE-68 三态 + NERE-84 会话隔离）：
 * - `fresh_session = 1` → 先新建空会话并绑定到任务（`session_id` / `last_session_id`），
 *   失败原因与历史长度无关，也不会在下一轮继续累积；
 * - 会话忙 → `deferred` 且不改 last_run_at（顺延不算一次运行）；
 * - 成功 → `ok`；异常 → `failed`（console.warn 保留，原因写入 last_error），两者都更新 last_run_at；
 * - 单个任务的异常不外抛，后续任务照常执行。
 */
export async function runDueAutomations(
	jobs: readonly automationsRepo.AutomationDueRow[],
	now: number,
	service: Pick<AutomationService, "defer" | "markRun" | "bindSession">,
	runner: AutomationRunner,
): Promise<void> {
	for (const job of jobs) {
		let sessionId = job.session_id || "1";
		if (job.fresh_session === 1) {
			// 新建会话失败（Harness/存储故障）→ 记 failed 但保留原会话绑定，下一轮重新尝试。
			try {
				sessionId = await runner.createSession();
				service.bindSession(job.id, sessionId);
			} catch (err) {
				console.warn(`automation ${job.id} create session failed`, String(err).slice(0, 200));
				service.markRun(job, now, "failed", String(err));
				continue;
			}
		}
		// 会话正忙时跳过这一轮，避免并发 submit 破坏会话状态（v0.17.1）
		if (runner.hasActive(sessionId)) {
			service.defer(job.id, now);
			continue;
		}
		let status: "ok" | "failed" = "ok";
		let error: string | undefined;
		try {
			await runner.run({ ...job, session_id: sessionId });
		} catch (err) {
			console.warn(`automation ${job.id} failed`, String(err).slice(0, 200));
			status = "failed";
			// 失败原因落库（v1.0.4）：console.warn 会丢，SQL 里要能查到当时为什么失败。
			error = String(err);
			// recover 失败不能吞掉本次运行结果，也不能中断后续任务。
			try {
				await runner.recover();
			} catch (recoverErr) {
				console.warn(`automation ${job.id} recover failed`, String(recoverErr).slice(0, 200));
			}
		}
		service.markRun(job, now, status, error, sessionId);
	}
}

export function createAutomationService(sql: SqlHandle): AutomationService {
	return {
		list: () => automationsRepo.list(sql),

		create(body) {
			const name = (body.name ?? "").trim().slice(0, 40);
			const prompt = (body.prompt ?? "").trim().slice(0, 2000);
			if (!name || !prompt) throw new AutomationApiError(400, "需要名称与提示词");
			const schedule: Schedule =
				body.schedule?.kind === "interval"
					? { kind: "interval", minutes: Math.max(1, Math.floor(Number(body.schedule.minutes ?? 60))) }
					: {
							kind: "daily",
							time: /^\d{1,2}:\d{2}$/.test(body.schedule?.time ?? "") ? body.schedule!.time! : "09:00",
						};
			const id = `a${Date.now().toString(36)}`;
			const at = nextRunAt(schedule);
			automationsRepo.insert(sql, {
				id,
				name,
				prompt,
				sessionId: body.sessionId ?? "",
				schedule: JSON.stringify(schedule),
				nextRunAt: at,
				createdAt: new Date().toISOString(),
			});
			return { id, nextRunAt: at };
		},

		update(id, body, now = Date.now()) {
			if (!id) throw new AutomationApiError(400, "缺少 id");
			const patch = buildAutomationPatch(body, now);
			if (!automationsRepo.get(sql, id)) throw new AutomationApiError(404, "任务不存在");
			automationsRepo.update(sql, id, patch);
			return automationView(automationsRepo.get(sql, id)!);
		},

		remove(id) {
			automationsRepo.remove(sql, id);
		},

		due: (now) => automationsRepo.listDue(sql, now),

		defer(id, now) {
			automationsRepo.markDeferred(sql, id, now + 5 * 60_000);
		},

		markRun(job, now, status, error, sessionId) {
			let schedule: Schedule = DAILY_DEFAULT;
			try {
				schedule = JSON.parse(job.schedule) as Schedule;
			} catch {
				// 保持默认
			}
			const summary = error ? error.slice(0, AUTOMATION_ERROR_MAX) : null;
			automationsRepo.markRun(sql, job.id, now, nextRunAt(schedule, Date.now()), status, summary, sessionId);
		},

		bindSession(id, sessionId) {
			automationsRepo.bindSession(sql, id, sessionId);
		},

		rescheduleOverdue(now) {
			automationsRepo.rescheduleOverdue(sql, now, now + 60_000);
		},

		dueGoals: (now) => goalsRepo.listDue(sql, now),

		deferGoal(sessionId, now) {
			goalsRepo.update(sql, sessionId, { next_run_at: now + 60_000 });
		},

		nextAlarmAt() {
			const candidates = [automationsRepo.nextScheduledAt(sql), goalsRepo.nextScheduledAt(sql)].filter(
				(value): value is number => typeof value === "number" && Number.isFinite(value),
			);
			return candidates.length ? Math.min(...candidates) : null;
		},
	};
}

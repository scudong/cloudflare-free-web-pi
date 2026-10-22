import type { SqlHandle } from "../db/migrations";
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

export class AutomationApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export type AutomationInput = {
	name?: string;
	prompt?: string;
	sessionId?: string;
	schedule?: { kind?: string; time?: string; minutes?: number };
};

export type AutomationService = {
	list(): automationsRepo.AutomationRow[];
	create(body: AutomationInput): { id: string; nextRunAt: number };
	setEnabled(id: string, enabled: boolean, now?: number): void;
	remove(id: string): void;
	/** alarm：到点且启用的任务。 */
	due(now: number): automationsRepo.AutomationDueRow[];
	/** 会话忙：顺延 5 分钟（不改 last_run_at）。 */
	defer(id: string, now: number): void;
	/** 执行完一轮：写 last_run_at 与下一次 next_run_at。 */
	markRun(job: { id: string; schedule: string }, now: number): void;
	/** 本轮处理过任务时，把仍落在过去的时间统一顺延 60s。 */
	rescheduleOverdue(now: number): void;
	/** alarm：到点且 active 的目标会话。 */
	dueGoals(now: number): string[];
	/** 目标忙：顺延 60s。 */
	deferGoal(sessionId: string, now: number): void;
	/** 任务与目标中最早的闹钟时刻；没有返回 null。 */
	nextAlarmAt(): number | null;
};

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

		setEnabled(id, enabled, now = Date.now()) {
			if (!id) throw new AutomationApiError(400, "缺少 id");
			automationsRepo.setEnabled(sql, id, enabled, now + 60_000);
		},

		remove(id) {
			automationsRepo.remove(sql, id);
		},

		due: (now) => automationsRepo.listDue(sql, now),

		defer(id, now) {
			automationsRepo.markDeferred(sql, id, now + 5 * 60_000);
		},

		markRun(job, now) {
			let schedule: Schedule = DAILY_DEFAULT;
			try {
				schedule = JSON.parse(job.schedule) as Schedule;
			} catch {
				// 保持默认
			}
			automationsRepo.markRun(sql, job.id, now, nextRunAt(schedule, Date.now()));
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

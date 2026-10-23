import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import * as automationsRepo from "../../src/worker/repo/automations-repo";
import {
	automationView,
	createAutomationService,
	runDueAutomations,
	type AutomationRunner,
} from "../../src/worker/services/automation-service";

/** 与 migrations.test.ts 相同的 SqlHandle 包装：DDL 走 exec，查询走 prepare().all()。 */
function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

/** 2026-10-22 08:00 UTC+8。 */
const NOW = Date.parse("2026-10-22T00:00:00Z");
const SCHEDULE = JSON.stringify({ kind: "interval", minutes: 30 });

function harness() {
	const db = new DatabaseSync(":memory:");
	const sql = sqlHandle(db);
	migrate(sql);
	automationsRepo.insert(sql, {
		id: "a1",
		name: "早报",
		prompt: "跑",
		sessionId: "42",
		schedule: SCHEDULE,
		nextRunAt: NOW - 1000,
		createdAt: "2026-10-21T00:00:00Z",
	});
	return { db, sql, service: createAutomationService(sql) };
}

function row(sql: SqlHandle, id = "a1") {
	return automationsRepo.get(sql, id)!;
}

/** 记录调用的假执行端口；`fail` 里的任务 id 会抛错。 */
function runner(overrides: Partial<AutomationRunner> & { fail?: string[] } = {}) {
	const calls = { run: [] as string[], recover: 0 };
	const impl: AutomationRunner = {
		hasActive: () => false,
		run: async (job) => {
			calls.run.push(job.id);
			if (overrides.fail?.includes(job.id)) throw new Error("boom");
		},
		recover: async () => {
			calls.recover += 1;
		},
	};
	return { impl: { ...impl, ...overrides, run: overrides.run ?? impl.run, recover: overrides.recover ?? impl.recover }, calls };
}

describe("last_status 落库（NERE-68）", () => {
	it("新任务的 last_run_at / last_status 都是空", () => {
		const { sql, service } = harness();
		expect(service.list()[0]).toMatchObject({ last_run_at: null, last_status: null });
		expect(automationView(row(sql))).toMatchObject({ last_run_at: null, last_status: null });
	});

	it("成功写 ok，并更新 last_run_at 与 next_run_at；last_error 一并清空", () => {
		const { sql, service } = harness();
		service.markRun({ id: "a1", schedule: SCHEDULE }, NOW - 60_000, "failed", "Error: boom");
		service.markRun({ id: "a1", schedule: SCHEDULE }, NOW, "ok");
		const stored = row(sql);
		expect(stored.last_status).toBe("ok");
		expect(stored.last_run_at).toBe(NOW);
		expect(stored.next_run_at).toBeGreaterThan(NOW);
		expect(stored.last_error).toBeNull();
	});

	it("异常写 failed，仍记这次运行时间；原因写入 last_error（v1.0.4）", () => {
		const { sql, service } = harness();
		service.markRun({ id: "a1", schedule: SCHEDULE }, NOW, "failed", "Error: boom");
		expect(row(sql)).toMatchObject({ last_status: "failed", last_run_at: NOW, last_error: "Error: boom" });
	});

	it("顺延写 deferred，且不覆盖上一次的 last_run_at", () => {
		const { sql, service } = harness();
		service.markRun({ id: "a1", schedule: SCHEDULE }, NOW - 60_000, "ok");
		service.defer("a1", NOW);
		expect(row(sql)).toMatchObject({
			last_status: "deferred",
			last_run_at: NOW - 60_000,
			next_run_at: NOW + 5 * 60_000,
		});
	});

	it("从未跑过就顺延：last_status = deferred，last_run_at 保持 null", () => {
		const { sql, service } = harness();
		service.defer("a1", NOW);
		expect(row(sql)).toMatchObject({ last_status: "deferred", last_run_at: null });
	});
});

describe("automationView 的 last_status 收口", () => {
	const base: automationsRepo.AutomationRow = {
		id: "a1",
		name: "日报",
		prompt: "跑",
		session_id: "",
		schedule: '{"kind":"daily","time":"09:00"}',
		enabled: 1,
		last_run_at: 123,
		last_status: "failed",
		last_error: "Error: boom",
		next_run_at: 456,
	};

	it("三种已知值原样透出", () => {
		for (const status of ["ok", "failed", "deferred"] as const) {
			expect(automationView({ ...base, last_status: status }).last_status).toBe(status);
		}
	});

	it("NULL 与脏值都收敛成 null", () => {
		expect(automationView({ ...base, last_status: null }).last_status).toBeNull();
		expect(automationView({ ...base, last_status: "bogus" }).last_status).toBeNull();
		expect(automationsRepo.parseLastStatus(undefined)).toBeNull();
	});
});

describe("runDueAutomations 三态（NERE-68）", () => {
	const jobs: automationsRepo.AutomationDueRow[] = [
		{ id: "a1", prompt: "跑", session_id: "42", schedule: SCHEDULE },
		{ id: "a2", prompt: "再跑", session_id: "", schedule: SCHEDULE },
	];

	function twoJobs() {
		const { sql, service } = harness();
		automationsRepo.insert(sql, {
			id: "a2",
			name: "晚报",
			prompt: "再跑",
			sessionId: "",
			schedule: SCHEDULE,
			nextRunAt: NOW - 1000,
			createdAt: "2026-10-21T00:00:00Z",
		});
		return { sql, service };
	}

	it("成功 → ok；会话忙 → deferred 且 last_run_at 不变", async () => {
		const { sql, service } = twoJobs();
		const busy = runner({ hasActive: (sessionId) => sessionId === "1" });
		await runDueAutomations(jobs, NOW, service, busy.impl);
		// a2 的 session_id 为空 → 落到根会话 "1"，被判忙
		expect(row(sql, "a1")).toMatchObject({ last_status: "ok", last_run_at: NOW });
		expect(row(sql, "a2")).toMatchObject({ last_status: "deferred", last_run_at: null, next_run_at: NOW + 5 * 60_000 });
		expect(busy.calls.run).toEqual(["a1"]);
	});

	it("异常 → failed（保留 console.warn）+ recover，后续任务照常执行", async () => {
		const { sql, service } = twoJobs();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const failing = runner({ fail: ["a1"] });
			await runDueAutomations(jobs, NOW, service, failing.impl);
			expect(row(sql, "a1")).toMatchObject({ last_status: "failed", last_run_at: NOW, last_error: "Error: boom" });
			expect(row(sql, "a2")).toMatchObject({ last_status: "ok", last_run_at: NOW, last_error: null });
			expect(failing.calls).toEqual({ run: ["a1", "a2"], recover: 1 });
			expect(warn).toHaveBeenCalledWith("automation a1 failed", "Error: boom");
		} finally {
			warn.mockRestore();
		}
	});

	it("recover 自身失败不吞掉 failed 状态，也不阻断后续任务", async () => {
		const { sql, service } = twoJobs();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const failing = runner({
				fail: ["a1"],
				recover: async () => {
					throw new Error("harness rebuild failed");
				},
			});
			await runDueAutomations(jobs, NOW, service, failing.impl);
			expect(row(sql, "a1")).toMatchObject({ last_status: "failed", last_run_at: NOW });
			expect(row(sql, "a2")).toMatchObject({ last_status: "ok", last_run_at: NOW });
			expect(failing.calls.run).toEqual(["a1", "a2"]);
			expect(warn).toHaveBeenCalledWith("automation a1 recover failed", "Error: harness rebuild failed");
		} finally {
			warn.mockRestore();
		}
	});
});

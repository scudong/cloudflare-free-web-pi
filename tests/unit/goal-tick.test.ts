import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { createChatGate, type ChatRuntime } from "../../src/worker/http/ports";
import { createAutomationService } from "../../src/worker/services/automation-service";
import { createChatService } from "../../src/worker/services/chat-service";
import { readGoal, startGoal, writeGoal } from "../../src/worker/services/goal-service";

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

/** 只记录调用次数的最小 Harness：goalTick → chat() 的路径要全部走通。 */
function fakeRuntime(calls: { submit: number; recover: number }): ChatRuntime {
	return {
		gate: createChatGate(),
		conversation: async (sessionId) => ({ id: sessionId ?? "1" }),
		configure: async () => {},
		instructions: async () => ({ instructions: "", kbRefs: [] }),
		skillInvocation: () => null,
		toolNames: async () => [],
		lastEntryId: async () => 0,
		submit: async () => {
			calls.submit += 1;
			return { id: `sub-${calls.submit}`, raw: null };
		},
		wait: async () => ({ status: "done", type: "input", answer: "ok" }),
		commit: async () => ({ id: calls.submit, kind: "pi.assistant", model: [{ content: "ok" }] }),
		entries: async () => [],
		watch: async () => ({ stop: async () => {} }),
		abort: async () => {},
		reset: async () => {},
		compact: async () => "",
		reflect: async () => 0,
		usageTokens: async () => 100,
		recover: async () => {
			calls.recover += 1;
		},
		scheduleAlarm: async () => {},
		waitUntil: () => {},
	};
}

function harness() {
	const db = new DatabaseSync(":memory:");
	const sql = sqlHandle(db);
	migrate(sql);
	startGoal(sql, { sessionId: "42", objective: "把活干完", tokenBudget: 1_000, maxTurns: 5, baseline: 0 });
	const calls = { submit: 0, recover: 0 };
	const service = createChatService({ sql, runtime: fakeRuntime(calls) });
	return { db, sql, service, calls, automations: createAutomationService(sql) };
}

describe("goalTick", () => {
	it("active 目标续转一轮不抛错，并把下次续转排到未来", async () => {
		const { db, sql, service, calls } = harness();
		try {
			await expect(service.goalTick("42")).resolves.toBeUndefined();

			const row = readGoal(sql, "42")!;
			expect(calls.submit).toBe(1);
			expect(row.turns).toBe(1);
			expect(row.status).toBe("active");
			expect(row.next_run_at).toBeGreaterThan(Date.now());
			expect(calls.recover).toBe(0);
		} finally {
			db.close();
		}
	});

	it("连续两次 alarm 只烧一轮：第二次调度未到点", async () => {
		const { db, sql, service, calls, automations } = harness();
		try {
			// 模拟到点：alarm 的 dueGoals 只取 next_run_at > 0 且已到点的 active 目标。
			writeGoal(sql, "42", { next_run_at: Date.now() - 1 });
			const runDue = async (now: number) => {
				for (const sessionId of automations.dueGoals(now)) await service.goalTick(sessionId);
			};

			await runDue(Date.now());
			expect(calls.submit).toBe(1);

			await runDue(Date.now());
			expect(calls.submit).toBe(1);
			expect(automations.dueGoals(Date.now())).toEqual([]);
		} finally {
			db.close();
		}
	});
});

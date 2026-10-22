import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { createChatGate, type ChatRuntime } from "../../src/worker/http/ports";
import { createChatService } from "../../src/worker/services/chat-service";

/**
 * NERE-82 P2-7 验收：同一会话并发的第二个 `/chat` 立即 409（chat_busy），
 * 不再两个都进入、只靠 alarm 事后 defer；`/interject` 不受闸门影响。
 */

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

function deferred() {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function harness() {
	const db = new DatabaseSync(":memory:");
	const sql = sqlHandle(db);
	migrate(sql);
	const gate = createChatGate();
	const release = deferred();
	const started = deferred();
	const calls = { submit: 0, recover: 0 };
	let failInstructions = false;

	const runtime: ChatRuntime = {
		gate,
		conversation: async (sessionId) => ({ id: sessionId ?? "1" }),
		configure: async () => {},
		instructions: async () => {
			if (failInstructions) throw new Error("SessionFailed");
			return { instructions: "", kbRefs: [] };
		},
		skillInvocation: () => null,
		toolNames: async () => [],
		lastEntryId: async () => 0,
		submit: async (_handle, input) => {
			if (input.whenBusy === "steer") return { id: "steer-1", raw: null };
			calls.submit += 1;
			started.resolve();
			await release.promise;
			return { id: "s1", raw: null };
		},
		wait: async () => ({ status: "done", type: "input", answer: "ok" }),
		commit: async () => ({ id: 1, kind: "pi.assistant", model: [{ content: "ok" }] }),
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

	return {
		db,
		gate,
		release,
		started,
		calls,
		service: createChatService({ sql, runtime }),
		runtime,
		setFailInstructions: (value: boolean) => {
			failInstructions = value;
		},
	};
}

describe("并发闸门（NERE-82 P2-7）", () => {
	it("同会话并发第二条 /chat → 409 chat_busy；结束后闸门释放", async () => {
		const { db, release, started, service } = harness();
		const first = service.chat({ message: "第一问", sessionId: "7" });
		await started.promise;

		await expect(service.chat({ message: "第二问", sessionId: "7" })).rejects.toMatchObject({
			status: 409,
			code: "chat_busy",
		});

		release.resolve();
		await expect(first).resolves.toMatchObject({ answer: "ok" });
		// 上一轮已释放：同会话可以继续提交。
		await expect(service.chat({ message: "第三问", sessionId: "7" })).resolves.toMatchObject({ answer: "ok" });
		db.close();
	});

	it("对话进行中 /interject 不受影响", async () => {
		const { db, release, started, service } = harness();
		const first = service.chat({ message: "第一问", sessionId: "8" });
		await started.promise;

		await expect(service.interject("补充一句", "8")).resolves.toEqual({ ok: true, id: "steer-1" });

		release.resolve();
		await expect(first).resolves.toMatchObject({ answer: "ok" });
		db.close();
	});

	it("流式的 prepare 同样拒绝并发，且 prepare 失败会释放闸门", async () => {
		const { db, gate, service, setFailInstructions } = harness();
		await service.prepare({ message: "流式一", sessionId: "9" });
		await expect(service.prepare({ message: "流式二", sessionId: "9" })).rejects.toMatchObject({
			status: 409,
			code: "chat_busy",
		});
		gate.exit("9");

		setFailInstructions(true);
		await expect(service.prepare({ message: "失败", sessionId: "10" })).rejects.toThrow("SessionFailed");
		expect(gate.has("10")).toBe(false);

		setFailInstructions(false);
		await expect(service.prepare({ message: "重试", sessionId: "10" })).resolves.toMatchObject({ sessionId: "10" });
		gate.exit("10");
		db.close();
	});
});

import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as questionsRepo from "../repo/questions-repo";

/**
 * 交互式问答用例（ADR-0001 §2）：ask_user 落库与 `/questions` 回答编排。
 * 端点失败体保留 `{ ok:false, error }` 兼容字段，统一经 `toResponse` 输出（NERE-79）。
 */
export type AskOption = { label: string; description?: string; recommended?: boolean };
export type AskItem = { id: string; question: string; options?: AskOption[]; allowText?: boolean };
export type AskPayload = { title?: string; questions: AskItem[] };
export type QuestionAnswer = { id?: string; choice?: string; text?: string };

/** 待回答的问题清单（GET /questions、/bootstrap 共用）。 */
export function listPending(sql: SqlHandle, sessionId: string) {
	return questionsRepo.listPending(sql, sessionId).map((row) => ({
		id: row.id,
		created_at: row.created_at,
		...(JSON.parse(row.payload) as AskPayload),
	}));
}

/** 最近一条待回答问题；目标续转据此暂停。损坏的 payload 视为没有问题。 */
export function readPending(sql: SqlHandle, sessionId: string): { id: number; payload: AskPayload } | null {
	try {
		const row = questionsRepo.latestPending(sql, sessionId);
		if (!row) return null;
		return { id: row.id, payload: JSON.parse(row.payload) as AskPayload };
	} catch {
		return null;
	}
}

/** 工具 ask_user 落库；失败不阻塞工具（返回 null）。 */
export function record(sql: SqlHandle, sessionId: string, payload: AskPayload): number | null {
	try {
		return questionsRepo.insert(sql, {
			sessionId,
			payload: JSON.stringify(payload),
			now: new Date().toISOString(),
		});
	} catch {
		return null;
	}
}

export class QuestionApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "QuestionApiError";
	}
}

export type QuestionResolution = { ok: true; id: number; resume: string };

export function answer(sql: SqlHandle, rawId: unknown, answers: QuestionAnswer[] | undefined): QuestionResolution {
	const id = Math.floor(Number(rawId));
	if (!Number.isFinite(id) || id <= 0) throw new QuestionApiError(400, "缺少问题 id");
	const row = questionsRepo.get(sql, id);
	if (!row) throw new QuestionApiError(404, "问题不存在");
	if (row.status !== "pending") throw new QuestionApiError(409, "该问题已回答");
	const payload = JSON.parse(row.payload) as AskPayload;
	const given = Array.isArray(answers) ? answers : [];
	const lines: string[] = [];
	for (const q of payload.questions) {
		const hit = given.find((a) => String(a.id ?? "") === q.id);
		const choice = String(hit?.choice ?? "").trim();
		const text = String(hit?.text ?? "").trim();
		const answer = text || choice || "（未回答）";
		lines.push(`- ${q.id}「${q.question}」：${answer}`);
	}
	if (!lines.length) throw new QuestionApiError(400, "没有有效回答");
	questionsRepo.markAnswered(sql, id, new Date().toISOString());
	const resume = `用户回答了你的问题${payload.title ? `（${payload.title}）` : ""}：\n${lines.join("\n")}\n\n请据此继续。`;
	return { ok: true, id, resume };
}

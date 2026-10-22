import type { SqlHandle } from "../db/migrations";
import { getContent, listAll, listBySession, remove, removeSession, write } from "../repo/files-repo";
import type { AllFileRow, FileContent, FileSummary } from "../repo/files-repo";

/**
 * 文件域用例（ADR-0001 §2）：只依赖显式 sql 句柄，不读请求级隐式作用域。
 * `listAll` 承担查询归一化（旧 GET /files/all 的行为）。
 */
export type FileServiceDeps = {
	sql: SqlHandle;
	/** 可注入时钟，便于测试；默认取当前 ISO 时间。 */
	now?: () => string;
};

export interface FileService {
	list(sessionId: string): FileSummary[];
	read(sessionId: string, name: string): FileContent | undefined;
	write(sessionId: string, name: string, content: string): void;
	delete(sessionId: string, name: string): void;
	deleteSession(sessionId: string): void;
	/** `query` 原样传入，归一化（trim/截断/小写）在 Service 内完成。 */
	listAll(query: string): AllFileRow[];
}

export function createFileService({ sql, now = () => new Date().toISOString() }: FileServiceDeps): FileService {
	return {
		list(sessionId) {
			return listBySession(sql, sessionId);
		},
		read(sessionId, name) {
			return getContent(sql, sessionId, name);
		},
		write(sessionId, name, content) {
			write(sql, sessionId, name, content, now());
		},
		delete(sessionId, name) {
			remove(sql, sessionId, name);
		},
		deleteSession(sessionId) {
			removeSession(sql, sessionId);
		},
		listAll(query) {
			return listAll(sql, (query ?? "").trim().slice(0, 100).toLowerCase());
		},
	};
}

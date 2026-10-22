import type { SqlHandle } from "../db/migrations";
import * as memoryRepo from "../repo/memory-repo";

/**
 * 记忆域用例（ADR-0001 §2）：`pi_mem` 的读写。
 * 直接 SQL 在 `repo/memory-repo.ts`；LLM 抽取在 `services/reflect-service.ts`。
 */
export type MemoryService = {
	list(): memoryRepo.MemoryRow[];
	remove(id: number): void;
	clearAll(): number;
};

export function createMemoryService(sql: SqlHandle): MemoryService {
	return {
		list: () => memoryRepo.list(sql),
		// 旧端点对未命中 id 静默成功；这里保持同样语义。
		remove: (id) => memoryRepo.remove(sql, id),
		clearAll: () => {
			const before = memoryRepo.count(sql);
			memoryRepo.removeAll(sql);
			return before;
		},
	};
}

/**
 * SQLite-backed Durable Object 每条查询最多 100 个绑定参数，超了直接抛错。
 * 拼 `IN (?,…)` 时按 90 个一批切，给其它占位符（doc_id、limit 等）留余量。
 */
export const ID_BIND_LIMIT = 90;

/** 去重后按 `size` 切批；空输入返回空数组，调用方不需要额外判空。 */
export function chunkIds(ids: readonly number[], size = ID_BIND_LIMIT): number[][] {
	const unique = [...new Set(ids)];
	const batches: number[][] = [];
	for (let start = 0; start < unique.length; start += size) batches.push(unique.slice(start, start + size));
	return batches;
}

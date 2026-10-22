import type { SqlHandle } from "../db/migrations";
import { deleteAll as deleteAllShares } from "../repo/shares-repo";
import type { BackupPayload } from "./data-service";

/**
 * 用户吊销生命周期（NERE-24）。
 *
 * 产品语义（ADR-0004）：吊销 = 立即失效访问，不删除数据。
 * - `revoke()` 删除该用户 DO 内的全部分享，`/s/*` 随即 404；其余数据保留。
 * - `purge()` 是显式、二次确认后的不可逆清空；调用前必须能导出（`backup()`）。
 *
 * 两个操作都幂等：重复调用只返回 0，不报错。
 */

export type UserDataCounts = {
	sessions: number;
	files: number;
	shares: number;
	kbDocs: number;
	kbChunks: number;
	plans: number;
	approvals: number;
	approvalGrants: number;
	questions: number;
	goals: number;
	automations: number;
	memories: number;
	skills: number;
	customTools: number;
	prompts: number;
	rules: number;
	mcpServers: number;
	providers: number;
	settings: number;
	entryKbRefs: number;
	skillAudits: number;
	skillEvents: number;
	reflectState: number;
};

/** 汇总口径：全部是 DO 内的业务表；pi-durable 会话条目不在这里，由 `purge()` 整体清空。 */
const COUNTED_TABLES: readonly (readonly [keyof UserDataCounts, string])[] = [
	["sessions", "sessions_meta"],
	["files", "vfs_v2"],
	["shares", "shares"],
	["kbDocs", "kb_docs"],
	["kbChunks", "kb_chunks"],
	["plans", "plans"],
	["approvals", "approvals"],
	["approvalGrants", "approval_grants"],
	["questions", "questions"],
	["goals", "goals"],
	["automations", "automations"],
	["memories", "pi_mem"],
	["skills", "skills"],
	["customTools", "custom_tools"],
	["prompts", "prompts"],
	["rules", "rules"],
	["mcpServers", "mcp_servers"],
	["providers", "providers"],
	["settings", "app_settings"],
	["entryKbRefs", "entry_kb_refs"],
	["skillAudits", "skill_audits"],
	["skillEvents", "skill_events"],
	["reflectState", "reflect_state"],
];

export function emptyUserDataCounts(): UserDataCounts {
	return Object.fromEntries(COUNTED_TABLES.map(([key]) => [key, 0])) as UserDataCounts;
}

/** 表名来自本文件的冻结清单，不接受外部输入。 */
export function countUserData(sql: SqlHandle): UserDataCounts {
	const counts = emptyUserDataCounts();
	for (const [key, table] of COUNTED_TABLES) {
		const rows = sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray() as { n: number }[];
		counts[key] = Number(rows[0]?.n ?? 0);
	}
	return counts;
}

export type RevokeResult = {
	/** 本次实际删除的分享行数。 */
	shares: number;
	/** 仍保留在该用户 DO 内的数据（吊销不删数据）。 */
	retained: UserDataCounts;
};

export type UserLifecycleDeps = {
	sql: SqlHandle;
	/** 导出与 `/backup` 同形的载荷；purge 前给 owner 留出可回滚的窗口。 */
	backup: () => BackupPayload;
	/** 关闭 Harness 并清空该 DO 的全部存储（SQL 与 pi-durable 数据）。 */
	purge: () => Promise<void>;
};

export type UserLifecycleService = {
	revoke(): RevokeResult;
	backup(): BackupPayload;
	purge(): Promise<UserDataCounts>;
};

export function createUserLifecycleService({ sql, backup, purge }: UserLifecycleDeps): UserLifecycleService {
	return {
		revoke() {
			const retained = countUserData(sql);
			const shares = deleteAllShares(sql);
			// 吊销后该用户的分享行清零；其余计数如实反映仍保留的数据。
			retained.shares = 0;
			return { shares, retained };
		},

		backup,

		async purge() {
			const counts = countUserData(sql);
			await purge();
			return counts;
		},
	};
}

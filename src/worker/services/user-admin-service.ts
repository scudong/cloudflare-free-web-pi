import { AppError } from "../http/errors";
import { USER_ID_RE } from "../http/ports";
import type { BackupPayload } from "./data-service";
import { emptyUserDataCounts, type RevokeResult, type UserDataCounts } from "./user-lifecycle-service";

/**
 * 用户注销编排（NERE-24）：注册表与用户 DO 的跨 DO 协议顺序在这里固定。
 *
 * 1. 删除注册表行：`/api/*` 的旧 token 立即 401；
 * 2. 删除用户 DO 内全部分享：`/s/*` 旧链接立即 404；
 * 3. 数据默认保留；purge 是独立的显式动作，要求先吊销且 `confirm` 等于用户 id。
 *
 * 每个端口都幂等，重复调用不会重复扣减或报错。
 */
export type UserAdminPorts = {
	deleteRegistryUser(id: string): Promise<{ deleted: boolean }>;
	registryHas(id: string): Promise<boolean>;
	revoke(id: string): Promise<RevokeResult>;
	backup(id: string): Promise<BackupPayload>;
	purge(id: string): Promise<UserDataCounts>;
};

export type UserAdminService = {
	remove(id: string): Promise<{ ok: true; id: string; deleted: boolean; shares: number; retained: UserDataCounts }>;
	exportData(id: string): Promise<BackupPayload>;
	purge(id: string, confirm: string | null): Promise<UserDataCounts>;
};

export function createUserAdminService(ports: UserAdminPorts): UserAdminService {
	return {
		async remove(id) {
			// 非邀请用户 id（空值、owner）历史语义是「什么都没删也返回 ok」；不创建用户 DO。
			if (!USER_ID_RE.test(id)) {
				return { ok: true, id, deleted: false, shares: 0, retained: emptyUserDataCounts() };
			}
			const { deleted } = await ports.deleteRegistryUser(id);
			const { shares, retained } = await ports.revoke(id);
			return { ok: true, id, deleted, shares, retained };
		},

		async exportData(id) {
			assertUserId(id);
			return ports.backup(id);
		},

		async purge(id, confirm) {
			assertUserId(id);
			if (confirm !== id) {
				throw new AppError("bad_request", 400, "二次确认失败：confirm 必须等于用户 id");
			}
			if (await ports.registryHas(id)) {
				throw new AppError("conflict", 409, "用户仍在注册表中，请先吊销访问（DELETE /api/users）");
			}
			return ports.purge(id);
		},
	};
}

function assertUserId(id: string): void {
	if (!USER_ID_RE.test(id)) throw new AppError("bad_request", 400, "缺少有效的用户 id");
}

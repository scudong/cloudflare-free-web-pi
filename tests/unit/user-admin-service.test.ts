import { describe, expect, it, vi } from "vitest";
import type { BackupPayload } from "../../src/worker/services/data-service";
import { createUserAdminService, type UserAdminPorts } from "../../src/worker/services/user-admin-service";
import { emptyUserDataCounts, type RevokeResult } from "../../src/worker/services/user-lifecycle-service";

const USER_ID = "u_ab12cd34";

function ports(overrides: Partial<UserAdminPorts> = {}): UserAdminPorts {
	return {
		deleteRegistryUser: vi.fn(async () => ({ deleted: true })),
		registryHas: vi.fn(async () => true),
		revoke: vi.fn(async (): Promise<RevokeResult> => ({ shares: 2, retained: emptyUserDataCounts() })),
		backup: vi.fn(async () => ({ version: 1, exportedAt: "", data: {} }) as BackupPayload),
		purge: vi.fn(async () => emptyUserDataCounts()),
		...overrides,
	};
}

describe("用户吊销顺序（NERE-77）", () => {
	it("先删分享再删注册表：吊销失败时注册表保留、接口报错，重试幂等", async () => {
		const revoke = vi
			.fn(async (): Promise<RevokeResult> => ({ shares: 3, retained: emptyUserDataCounts() }))
			.mockRejectedValueOnce(new Error("用户 DO 不可用"));
		const deleteRegistryUser = vi.fn(async () => ({ deleted: true }));
		const service = createUserAdminService(ports({ revoke, deleteRegistryUser }));

		await expect(service.remove(USER_ID)).rejects.toThrow("用户 DO 不可用");
		// 失败方向是可用性：注册表行还在，但分享没删成功时不能假装成功。
		expect(deleteRegistryUser).not.toHaveBeenCalled();

		await expect(service.remove(USER_ID)).resolves.toMatchObject({ ok: true, deleted: true, shares: 3 });
		expect(revoke).toHaveBeenCalledTimes(2);
		expect(deleteRegistryUser).toHaveBeenCalledTimes(1);
	});

	it("成功路径按 revoke → deleteRegistryUser 顺序调用", async () => {
		const calls: string[] = [];
		const service = createUserAdminService(
			ports({
				revoke: async () => {
					calls.push("revoke");
					return { shares: 1, retained: emptyUserDataCounts() };
				},
				deleteRegistryUser: async () => {
					calls.push("deleteRegistryUser");
					return { deleted: true };
				},
			}),
		);
		await service.remove(USER_ID);
		expect(calls).toEqual(["revoke", "deleteRegistryUser"]);
	});
});

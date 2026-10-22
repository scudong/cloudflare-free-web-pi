import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { listBackupDocs } from "../repo/kb-repo";
import { buildBackup } from "../services/data-service";
import { createKbService } from "../services/kb-service";
import { createUserLifecycleService } from "../services/user-lifecycle-service";

/**
 * 内部跨 DO 协议（NERE-24）：只由 Worker 用 `x-pi-internal: 1` 调用，
 * 不进入公开路由表；`SpikeAgent.fetch` 在分发前校验并拒绝其它请求。
 *
 * 协议只做数据处置，不理解注册表：删注册表行由 Worker 侧完成。
 */
function service(ctx: RequestContext) {
	return createUserLifecycleService({
		sql: ctx.sql(),
		backup: () => buildBackup({ sql: ctx.sql(), kbDocs: listBackupDocs(ctx.sql()) }),
		purge: async () => {
			// 知识库向量是全局索引里的派生数据；逐文档删除（失败不阻塞 DO 清空）。
			const kb = createKbService({
				sql: ctx.sql(),
				env: ctx.env,
				scopeId: ctx.scopeId,
				settings: ctx.settings,
				webFetch: ctx.webFetch,
			});
			for (const doc of kb.listDocs()) {
				await kb.remove(doc.id).catch(() => {});
			}
			await ctx.userLifecycleRuntime.purge();
		},
	});
}

export const internalRoutes: readonly Route[] = [
	{
		// 吊销：删除该用户 DO 的全部分享，返回实际删除数与保留的其它数据规模。
		method: "POST",
		path: "/internal/revoke-user",
		needsHarness: false,
		handle: async (ctx) => Response.json({ ok: true, ...service(ctx).revoke() }),
	},
	{
		// 导出：与 `/api/backup` 同形，供 owner 在 purge 前留档。
		method: "GET",
		path: "/internal/user-backup",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).backup()),
	},
	{
		// 清空：不可逆。调用方必须先完成确认与注册表删除。
		method: "POST",
		path: "/internal/purge-user",
		needsHarness: false,
		handle: async (ctx) => Response.json({ ok: true, purged: await service(ctx).purge() }),
	},
];

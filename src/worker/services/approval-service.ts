import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as approvalsRepo from "../repo/approvals-repo";
import { isHidden } from "../repo/sessions-repo";
import { approvalSettings as readApprovalSettings, type ApprovalPolicy, type GetSetting } from "./settings-service";

/**
 * 工具审批用例（ADR-0001 §2）：分级策略、闸门读取、待审批决定。
 *
 * - 闸门在工具边界调用（`withApproval`），Service 不感知 HTTP；
 * - 扣许可仍是 `approvalsRepo.consumeGrant` 一条读-写路径，不引入读-改-写竞态；
 * - `/tools` 与 `/approvals` 共用同一份策略解析。
 */
export type ApprovalCategory = approvalsRepo.ApprovalCategory;

export const APPROVAL_LABEL: Record<ApprovalCategory, string> = { read: "读取", write: "写入", exec: "执行" };

/** 已知工具的默认分级。MCP 工具按写操作、未知工具按读取处理。 */
export const TOOL_CATEGORY: Record<string, ApprovalCategory> = {
	now: "read",
	recall: "read",
	list_skills: "read",
	load_skill: "read",
	install_skill: "write",
	read_file: "read",
	list_files: "read",
	kb_search: "read",
	kb_list: "read",
	kb_add: "write",
	kb_delete: "write",
	web_search: "read",
	web_fetch_page: "read",
	http_fetch: "read",
	tool_search: "read",
	update_plan: "read",
	set_goal: "read",
	complete_goal: "read",
	report_goal: "read",
	write_file: "write",
	share_file: "write",
	share_conversation: "write",
	remember: "write",
	codemode: "exec",
	dispatch_tasks: "exec",
};

/** 自定义工具统一按 exec 级处理；集合由调用方传入（DO 实例字段，R5）。 */
export function toolCategory(name: string, customToolNames?: ReadonlySet<string>): ApprovalCategory {
	const known = TOOL_CATEGORY[name];
	if (known) return known;
	if (customToolNames?.has(name)) return "exec";
	if (name.startsWith("mcp__")) return "write";
	return "read";
}

/** 生效策略：逐工具覆盖 > 分级策略 > 默认放行。 */
export function toolPolicy(
	get: GetSetting,
	name: string,
	customToolNames?: ReadonlySet<string>,
): ApprovalPolicy {
	const override = get(`approval_tool_${name}`, "follow");
	if (override === "allow" || override === "ask" || override === "deny") return override;
	const level = get(`approval_${toolCategory(name, customToolNames)}`, "allow");
	return level === "ask" || level === "deny" ? level : "allow";
}

export function approvalSettings(get: GetSetting) {
	return readApprovalSettings(get);
}

export function listPending(sql: SqlHandle, sessionId: string) {
	return approvalsRepo.listPending(sql, sessionId);
}

/** 记录一条待审批；同一会话同一工具已有待审批时不重复插入。失败不阻塞工具。 */
export function recordApproval(
	sql: SqlHandle,
	sessionId: string,
	tool: string,
	category: ApprovalCategory,
	args: unknown,
): number | null {
	try {
		const existing = approvalsRepo.findPendingId(sql, sessionId, tool);
		if (existing != null) return existing;
		const preview = (() => {
			try {
				return JSON.stringify(args ?? {}).slice(0, 800);
			} catch {
				return "";
			}
		})();
		return approvalsRepo.insertPending(sql, {
			sessionId,
			tool,
			category,
			args: preview,
			now: new Date().toISOString(),
		});
	} catch {
		return null;
	}
}

/** 给工具套上审批闸门：放行 / 询问（无许可时记一条待审批并让模型等待）/ 禁止。 */
export type ToolGateDeps = {
	/** 延迟解析当前请求的 SQL（模块级扩展在 execute 时才需要）。 */
	sql(): SqlHandle;
	get: GetSetting;
};

export function withApproval<T extends { name: string; execute?: (...args: never[]) => unknown }>(
	tool: T,
	deps: ToolGateDeps,
	customToolNames?: ReadonlySet<string>,
): T {
	const original = tool.execute;
	if (typeof original !== "function") return tool;
	return {
		...tool,
		// 必须把 execute 的全部参数（args, api, context）原样转发：codemode 等工具依赖第三个 context.abortSignal
		execute: async (...rest: never[]) => {
			const policy = toolPolicy(deps.get, tool.name, customToolNames);
			const run = () => (original as (...a: never[]) => unknown)(...rest);
			const args = rest[0];
			const api = rest[1];
			if (policy === "allow") return run();
			const sid = String((api as unknown as { conversationId?: unknown })?.conversationId ?? "1");
			if (isHidden(deps.sql(), sid)) return run();
			const category = toolCategory(tool.name, customToolNames);
			if (policy === "deny") {
				return {
					output: [{
						type: "text",
						text: `「${tool.name}」属于${APPROVAL_LABEL[category]}级操作，当前策略为禁止。请告诉用户：可在 设置 → 工具审批 中调整。`,
					}],
				};
			}
			if (approvalsRepo.consumeGrant(deps.sql(), sid, tool.name)) return run();
			const id = recordApproval(deps.sql(), sid, tool.name, category, args);
			return {
				output: [{
					type: "text",
					text: `「${tool.name}」属于${APPROVAL_LABEL[category]}级操作，需要用户确认后才能执行。已提交待审批${id ? `（#${id}）` : ""}：不要重复调用本工具，等用户批准后再继续。`,
				}],
			};
		},
	} as T;
}

export class ApprovalApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "ApprovalApiError";
	}
}

export type ApprovalAction = "once" | "always" | "deny";
export type ApprovalDecision = { ok: true; id: number; action: ApprovalAction; tool: string; resume: string };

/** POST /approvals：once / always / deny；已 decided 的条目只返回 resume（与旧行为一致）。 */
export function decide(sql: SqlHandle, rawId: unknown, action: unknown): ApprovalDecision {
	const id = Math.floor(Number(rawId));
	if (!Number.isFinite(id) || id <= 0) throw new ApprovalApiError(400, "缺少待审批 id");
	if (action !== "once" && action !== "always" && action !== "deny") {
		throw new ApprovalApiError(400, "action 必须是 once / always / deny");
	}
	const row = approvalsRepo.get(sql, id);
	if (!row) throw new ApprovalApiError(404, "待审批不存在");
	if (row.status === "pending") {
		const now = new Date().toISOString();
		if (action === "deny") {
			approvalsRepo.markDecided(sql, id, "denied", now);
			approvalsRepo.deleteGrant(sql, row.session_id, row.tool);
		} else {
			approvalsRepo.markDecided(sql, id, "approved", now);
			approvalsRepo.upsertGrant(sql, {
				sessionId: row.session_id,
				tool: row.tool,
				uses: action === "always" ? -1 : 1,
				now,
			});
		}
	}
	const resume =
		action === "deny"
			? row.tool === "share_file" || row.tool === "share_conversation"
				? `用户拒绝了对工具「${row.tool}」的调用，本次分享已取消：不要声称链接已生成，简短回复「已取消分享」即可。`
				: `用户拒绝了对工具「${row.tool}」的调用，请不要再用它，改换方案或向用户说明。`
			: `已批准工具「${row.tool}」（${action === "always" ? "以后允许" : "本次"}），请继续刚才的操作。`;
	return { ok: true, id, action, tool: row.tool, resume };
}

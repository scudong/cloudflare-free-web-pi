import type { SqlHandle } from "../db/migrations";
import * as mcpRepo from "../repo/mcp-repo";
import * as panelsRepo from "../repo/panels-repo";
import * as providersRepo from "../repo/providers-repo";
import * as skillsRepo from "../repo/skills-repo";
import type { SettingsView } from "./settings-service";

/**
 * 能力注册表用例（ADR-0001 §2）：`GET /capabilities` 把三类来源汇总成一张表。
 * 只读：设置视图由 Route 从 settings-service 传入，计数全部走仓储。
 */
export type CapabilityItem = {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	count?: number;
	detail?: string;
};

export type CapabilityGroup = { key: string; label: string; items: CapabilityItem[] };

export type CapabilityDeps = { sql: SqlHandle; settings: SettingsView };

export function capabilities({ sql, settings }: CapabilityDeps): { groups: CapabilityGroup[] } {
	const approvalOn =
		settings.approval.read !== "allow" || settings.approval.write !== "allow" || settings.approval.exec !== "allow";
	const builtin: CapabilityItem[] = [
		{ id: "codemode", name: "Code Mode", description: "QuickJS 沙箱里写 JS 调工具", enabled: true },
		{ id: "tool_search", name: "工具搜索", description: "工具多时按需检索加载", enabled: true },
		{
			id: "compaction",
			name: "上下文压缩",
			description: "接近上下文上限时自动摘要旧内容",
			enabled: settings.compaction.enabled,
			detail: `保留 ${settings.compaction.keepRecentTokens} tokens / 预留 ${settings.compaction.reserveTokens}`,
		},
		{ id: "plan", name: "计划清单", description: "update_plan 维护分步计划", enabled: true },
		{ id: "share", name: "分享链接", description: "share_file / share_conversation 生成只读链接", enabled: true },
		{ id: "subagents", name: "子代理", description: "dispatch_tasks 并行分派子任务", enabled: true },
		{ id: "goal", name: "目标模式", description: "目标 + token 预算 + 自动续转 + 完成校验", enabled: true },
		{
			id: "approval",
			name: "工具审批",
			description: "read/write/exec 三档 + 逐工具覆盖",
			enabled: approvalOn,
			detail: `读 ${settings.approval.read} / 写 ${settings.approval.write} / 执行 ${settings.approval.exec}`,
		},
		{ id: "web_search", name: "联网搜索", description: "web_search / web_fetch_page", enabled: settings.webSearch },
	];
	const data: CapabilityItem[] = [
		{
			id: "skills",
			name: "技能",
			description: "SKILL.md 说明书，按需 load_skill",
			enabled: true,
			count: skillsRepo.countVisibleSkills(sql),
		},
		{ id: "prompts", name: "提示模板", description: "输入 / 展开的常用指令", enabled: true, count: panelsRepo.countPrompts(sql) },
		{
			id: "rules",
			name: "规则文件",
			description: "每轮注入的项目约定",
			enabled: true,
			count: panelsRepo.countEnabledRules(sql),
		},
	];
	const protocol: CapabilityItem[] = [
		{
			id: "mcp",
			name: "MCP 服务器",
			description: "Streamable HTTP 工具接入",
			enabled: true,
			count: mcpRepo.count(sql),
		},
		{
			id: "providers",
			name: "模型供应商",
			description: "OpenAI 兼容端点",
			enabled: true,
			count: providersRepo.list(sql).length,
		},
	];
	return {
		groups: [
			{ key: "builtin", label: "内置能力", items: builtin },
			{ key: "data", label: "数据能力", items: data },
			{ key: "protocol", label: "协议接入", items: protocol },
		],
	};
}

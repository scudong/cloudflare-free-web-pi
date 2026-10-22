import type { SqlHandle } from "../db/migrations";
import type { SettingsPort } from "../http/ports";
import type { KbRef } from "../lib/kb";
import { listSkillRows } from "../repo/skills-repo";
import type { KbService } from "./kb-service";
import { enabledRuleContents } from "./prompts-service";
import { goalInstructionsBlock, readGoal } from "./goal-service";

/**
 * 组装本轮 instructions（ADR-0001 §2 / v0.46.0）：
 * 基础规则 + 技能索引 + 显式技能 + 进行中的目标 + 知识库预检索。
 * 纯装配，SQL 经 repo，知识库经 `KbService` 注入。
 */
export type InstructionsDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	kb: KbService;
};

export type SkillInvocation = { name: string; content: string; rest: string };

/** 已安装技能索引（blocked 不进入模型视野）。读取失败时回退空数组。 */
function skillIndex(sql: SqlHandle): { name: string; description: string }[] {
	try {
		return listSkillRows(sql)
			.filter((skill) => skill.auditStatus !== "blocked")
			.map((skill) => ({ name: skill.name, description: skill.description }));
	} catch {
		return [];
	}
}

const BASE =
	"你在 Cloudflare Free Web Pi（GitHub: scudong/cloudflare-free-web-pi，界面名 π Harness）里运行：一个部署在 Cloudflare Workers 上的 pi-durable harness，个人用量在 Cloudflare 免费额度内。被问到本项目时以上面的仓库为准。\n" +
	"凡是需要计算、批量处理、解析或转换数据时，必须调用 codemode 工具写 JavaScript 执行（脚本内可用 await tools.<name>(args) 调用其它工具），不要心算或声称没有该工具。";

function withSkillInstructions(base: string, sql: SqlHandle, settings: SettingsPort): string {
	let out = base;
	const index = skillIndex(sql);
	if (index.length) {
		const lines = index.map((s) => `- ${s.name}：${s.description || "（无描述）"}`).join("\n");
		out = `${out}\n\n可用技能（需要时调用 load_skill 读取完整说明后再执行）：\n${lines}`;
	}
	out += "\n安装技能：用户给出 SKILL.md 链接时，直接调用 install_skill({ url }) 安装；不要用 write_file 往工作台复制技能文件，工作台文件不会被注册。";
	// 用户知识库（v0.45.0）：每个用户独立，和工作台文件是两套存储
	out +=
		"\n用户资料与长期知识用知识库：先 kb_search 检索；用户要求「存到知识库 / 记到资料库」时用 kb_add。工作台文件不会被知识库检索到。";
	// 网页搜索开启时才在提示词里引导模型使用；关闭时工具会返回开启指引。
	if (settings.get("web_search", "1") === "1") {
		out += "\n需要联网查资料时优先用 web_search 搜索、web_fetch_page 抓取正文（比 http_fetch 更干净）。";
	}
	// 分步计划（v0.22.0）：多步任务先 update_plan，用户在聊天里实时看到清单。
	out +=
		"\n任务需要 3 步以上（多次检索、多文件产出、先计算后写作等）时，先用 update_plan 列出步骤并在每完成一步后更新；单步问题不要调用它。";
	// 规则文件（v0.31.0）：用户维护的项目约定，每轮注入
	const rules = enabledRuleContents(sql);
	if (rules.length) {
		out += "\n\n## 项目规则（必须遵守）\n" + rules.map((r) => `- ${r}`).join("\n");
	}
	// 交互式问答（v0.37.0）：需要用户决策时用卡片而不是纯文本罗列
	out +=
		"\n需要用户在方案之间做选择、或缺少关键偏好无法继续时，用 ask_user 提结构化问题（一次 1–6 题，每题给 recommended 选项），比在正文里罗列问题更好用；能从环境查到的信息不要问用户。";
	// 子代理（v0.29.0）：可并行的独立子任务交给它们
	out +=
		"\n当有 2–4 个**互不依赖**的子任务（如分别调研几个对象再做对比）时，用 dispatch_tasks 并行分派给子代理，比串行逐个做更快；子代理看不到主对话，每个 prompt 要自包含。";
	// 分享（v0.55.0）：模型能直接生成链接，不能把用户推给配置项
	out +=
		"\n用户说「分享 / 发我个链接 / 转给同事 / 生成公开链接」时，直接调用 share_file（工作台文件）或 share_conversation（当前对话），并把返回的完整 URL 原样写进回复；不要回答「做不到」，也不要让用户去别处配置。";
	// 产出即给链接（NERE-73）：可交付文档收尾时问一句，别自动分享
	out +=
		"\n产出是可交付文档（报告、周报、清单等）时，在回复结尾用一句话问是否需要分享链接；用户确认后再调用 share_file，不要自动分享。";
	return out;
}

export async function buildInstructions(
	{ sql, settings, kb }: InstructionsDeps,
	inv: SkillInvocation | null,
	sessionId?: string,
	message?: string,
): Promise<{ instructions: string; kbRefs: KbRef[] }> {
	const withSkills = withSkillInstructions(BASE, sql, settings);
	const goal = sessionId ? readGoal(sql, sessionId) : null;
	const goalBlock = goalInstructionsBlock(goal);
	const prefetch = message ? await kb.prefetch(message) : { block: "", refs: [] };
	// 只有真正注入了检索块才记引用（NERE-40）：未命中/开关关闭时 kbRefs 为空。
	const kbRefs = prefetch.block ? prefetch.refs : [];
	const instructions = !inv
		? withSkills + goalBlock + prefetch.block
		: `${withSkills}${goalBlock}\n\n## 用户显式调用的技能：${inv.name}\n下面是该技能的完整说明，请严格按照它执行，不要声称找不到该技能：\n\n${inv.content}${prefetch.block}`;
	return { instructions, kbRefs };
}

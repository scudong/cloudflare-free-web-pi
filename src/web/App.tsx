import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { Rail, type RailView } from "./components/Rail";
import { AutomationPanel, McpPanel, SkillPanel } from "./components/LeftPanels";
import { SettingsDialog } from "./components/SettingsDialog";
import { GoalBar, GoalDialog } from "./components/GoalBar";
import { ApprovalBar } from "./components/ApprovalBar";
import { AskUserCard } from "./components/AskUserCard";
import { UsersPanel } from "./components/UsersPanel";
import { FilesPanel } from "./components/FilesPanel";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { SharesPanel } from "./components/SharesPanel";
import { LoginGate } from "./components/LoginGate";
import { Icon } from "./components/Icon";
import { api, type BootstrapKey } from "./lib/api";
import { useBootstrap } from "./hooks/useBootstrap";
import { shareUrlFor } from "./lib/format";
import { parseEntries, parseKbRefs, truncateOneLine } from "./lib/entries";
import { loadBoolOrNull, saveBool } from "./lib/localStore";
import { applyTheme, readTheme, type ThemeId } from "./lib/theme";
import { useMediaQuery } from "./lib/useMediaQuery";
import type { ApprovalInfo, AskQuestion, AutomationInfo, ChatMessage, CustomToolInfo, FileArtifact, FileInfo, GoalInfo, KbFocus, KbRef, McpServerInfo, MemoryInfo, PlanStep, PromptInfo, RuleInfo, SessionListItem, ShareLink, SkillInfo, ToolCallInfo } from "./types";

const TOOL_SUMMARY_MAX = 60;
const DESKTOP_QUERY = "(min-width: 768px)";
const LEFT_OPEN_KEY = "pi-harness.left-open";
const RIGHT_OPEN_KEY = "pi-harness.right-open";

/** 工具结果 details → 分享链接卡数据（v0.55.0）。宽容解析，缺字段就返回 null。 */
function shareFromToolDetails(details: unknown): ShareLink | null {
	if (!details || typeof details !== "object" || !("share" in details)) return null;
	const share = details.share;
	if (!share || typeof share !== "object" || !("url" in share) || typeof share.url !== "string") return null;
	const kind = "kind" in share && share.kind === "conversation" ? "conversation" : "file";
	const name = "name" in share && typeof share.name === "string" ? share.name : "";
	return {
		url: share.url,
		title: name || (kind === "conversation" ? "对话分享" : "文件分享"),
		kind,
		expiresAt: "expiresAt" in share && typeof share.expiresAt === "number" ? share.expiresAt : 0,
		createdAt: "createdAt" in share && typeof share.createdAt === "string" ? share.createdAt : undefined,
		reused: "reused" in share && share.reused === true,
	};
}

/** 历史回放里的分享链接：域名统一换成当前页面的 origin。 */
function withAbsoluteShareLinks(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((message) =>
		message.role === "assistant" && message.shares?.length
			? {
					...message,
					shares: message.shares.map((link) => ({
						...link,
						url: shareUrlFor(link.url, window.location.origin, readTheme()),
					})),
				}
			: message,
	);
}
type PanelState = "loading" | "ready" | "error";
type MobileTab = "chat" | "files";

export default function App() {
	const isDesktop = useMediaQuery(DESKTOP_QUERY);

	// Layout: persisted panel toggles (desktop), mobile tab + drawer
	// 自动扩展（v0.15.0）：首次进入按视口宽度决定两栏默认展开；
	// 用户手动切换后写入 localStorage，此后以用户选择为准。
	const [leftOpen, setLeftOpen] = useState(() => {
		const saved = loadBoolOrNull(LEFT_OPEN_KEY);
		if (saved !== null) return saved;
		return typeof window === "undefined" ? true : window.innerWidth >= 1024;
	});
	const [rightOpen, setRightOpen] = useState(() => {
		const saved = loadBoolOrNull(RIGHT_OPEN_KEY);
		if (saved !== null) return saved;
		return typeof window === "undefined" ? true : window.innerWidth >= 1280;
	});
	const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// 左侧 Rail 当前展示的面板（v0.21.0）：会话 / 连接 / 定时 / 技能
	const [railView, setRailView] = useState<RailView>("sessions");
	// 从消息里的参考资料跳到知识库（NERE-41）：nonce 让「重复点同一篇」也能再次触发
	const [kbFocus, setKbFocus] = useState<KbFocus | null>(null);
	const kbFocusSeq = useRef(0);
	// 右栏宽度（v0.16.0）：可拖拽分隔条、打开文档时自动加宽、可最大化阅读
	const [rightWidth, setRightWidth] = useState(() => {
		const saved = typeof window === "undefined" ? null : Number(localStorage.getItem("pi-right-width") ?? "");
		return Number.isFinite(saved) && saved && saved >= 260 ? saved : 340;
	});
	const [workbenchWide, setWorkbenchWide] = useState(false);
	const rightWidthRef = useRef(rightWidth);
	rightWidthRef.current = rightWidth;
	// 左栏宽度（v0.32.0）：可拖拽
	const [leftWidth, setLeftWidth] = useState(() => {
		const saved = typeof window === "undefined" ? null : Number(localStorage.getItem("pi-left-width") ?? "");
		return Number.isFinite(saved) && saved && saved >= 200 ? saved : 240;
	});
	/** 打开文件前的右栏宽度：关闭文件时还原（null = 无需还原）。 */
	const widthBeforeFileRef = useRef<number | null>(null);

	// Session list
	const [sessionId, setSessionId] = useState("1");
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [theme, setTheme] = useState<ThemeId>(() => readTheme());
	const [auth, setAuth] = useState<{ required: boolean; authenticated: boolean; owner?: boolean; demoUrl?: string } | null>(null);
	const [loginError, setLoginError] = useState<string | null>(null);
	const [models, setModels] = useState<string[]>([]);
	/** 供应商变更后重新拉取模型列表（v0.27.0）。 */
	const [modelsTick, setModelsTick] = useState(0);
	const [model, setModel] = useState("deepseek-flash");
	// 网页搜索开关（v0.20.0）：null 表示尚未读到后端设置
	const [webSearch, setWebSearch] = useState<boolean | null>(null);
	// 知识库预检索开关（v0.46.0）：null = 尚未读取
	const [kbPrefetch, setKbPrefetch] = useState<boolean | null>(null);
	// 知识库检索模式（v0.53.0）：fts / vector / hybrid
	const [kbRetrieval, setKbRetrieval] = useState("fts");
	// 思考档位（v0.22.0）：off / low / high
	const [thinkingLevel, setThinkingLevel] = useState<string>("low");
	// 分享页署名与默认有效期（v0.55.0）
	const [displayName, setDisplayName] = useState("");
	const [shareTtlSeconds, setShareTtlSeconds] = useState(604800);
	// 上下文压缩策略（v0.30.0）
	const [compaction, setCompaction] = useState<{
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		backgroundTokens: number;
	} | null>(null);
	// 当前会话的分步计划（v0.22.0）
	const [plan, setPlan] = useState<PlanStep[]>([]);
	// 上下文占用刷新信号（v0.42.0）：每轮结束 / 压缩完成 +1
	const [contextTick, setContextTick] = useState(0);
	// 目标模式（v0.31.0）
	const [goal, setGoal] = useState<GoalInfo | null>(null);
	const [goalDialogOpen, setGoalDialogOpen] = useState(false);
	// 工具审批（v0.33.0）
	const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
	const [approvalBusy, setApprovalBusy] = useState(false);
	const [approvalSettings, setApprovalSettings] = useState<{ read: string; write: string; exec: string } | null>(null);
	// 交互式问答（v0.37.0）
	const [askQuestions, setAskQuestions] = useState<AskQuestion[]>([]);
	const [askBusy, setAskBusy] = useState(false);
	/** 从聊天里的文件卡打开右栏预览（v0.22.0）。 */
	const [fileRequest, setFileRequest] = useState<{ name: string; tick: number } | null>(null);
	const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	// 提示模板与规则（v0.31.0）
	const [prompts, setPrompts] = useState<PromptInfo[]>([]);
	const [customTools, setCustomTools] = useState<CustomToolInfo[]>([]);
	const [rules, setRules] = useState<RuleInfo[]>([]);
	const [skillsLoading, setSkillsLoading] = useState(true);
	const [skillsError, setSkillsError] = useState<string | null>(null);
	const [automations, setAutomations] = useState<AutomationInfo[]>([]);
	const [automationsLoading, setAutomationsLoading] = useState(true);
	const [automationsError, setAutomationsError] = useState<string | null>(null);
	const [mcpLoading, setMcpLoading] = useState(true);
	const [mcpError, setMcpError] = useState<string | null>(null);
	const [sessionsLoading, setSessionsLoading] = useState(true);
	const [sessionQuery, setSessionQuery] = useState("");

	// Workbench data
	const [files, setFiles] = useState<FileInfo[]>([]);
	/** files 数组对应的会话：跨会话打开文件时避免被「文件不存在」守卫误关（v0.45.0）。 */
	const [filesForSession, setFilesForSession] = useState(sessionId);
	const [filesState, setFilesState] = useState<PanelState>("loading");
	const [filesError, setFilesError] = useState<string | null>(null);
	const [memories, setMemories] = useState<MemoryInfo[]>([]);
	const [memoriesState, setMemoriesState] = useState<PanelState>("loading");
	const [memoriesError, setMemoriesError] = useState<string | null>(null);
	const [panelTick, setPanelTick] = useState(0);

	// Chat state
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	/** 空会话起步卡写入 Composer 的草稿。 */
	const [starterDraft, setStarterDraft] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const [online, setOnline] = useState(true);
	const [sessionName, setSessionName] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	/** In-flight /api/chat request, aborted by the 停止 button. */
	const abortRef = useRef<AbortController | null>(null);
	/** Session generation: bumped on 新会话 / switch so stale responses are dropped. */
	const generationRef = useRef(0);
	const idRef = useRef(0);
	const nextId = useCallback(() => `m${++idRef.current}-${Date.now().toString(36)}`, []);

	// 首屏聚合（NERE-26）：17 个只读面板走一次 /api/bootstrap。
	// panelTick = 面板增删后刷新；reloadKey = 用户点重试；modelsTick = 设置弹窗里换了供应商。
	const bootstrap = useBootstrap(sessionId, `${reloadKey}:${panelTick}:${modelsTick}`);
	/** 当前会话还没有可用的 bootstrap 数据：面板显示加载态（后台刷新时不闪）。 */
	const bootstrapPending = bootstrap.loading && (bootstrap.dataSessionId !== sessionId || !bootstrap.data);
	/** 已经整份落地过的 (会话, 重试, 模型变更) 组合：只有它变化时才覆盖消息 / 设置 / 计划等会与本地状态竞争的数据。 */
	const bootstrapHydratedRef = useRef<{ sessionId: string; reloadKey: number; modelsTick: number } | null>(null);

	// While waiting for a reply, tick the elapsed counter every second
	useEffect(() => {
		if (!pending) return;
		const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
		return () => window.clearInterval(timer);
	}, [pending]);

	/**
	 * 首屏聚合落地（NERE-26）：一次 bootstrap 覆盖 17 个只读面板。
	 *
	 * 分两档写状态：
	 * - 面板数据（会话列表 / 文件 / 记忆 / 技能 / 模板 / 规则 / MCP / 定时任务）每次成功都跟随服务端，
	 *   等价于原先 panelTick 的逐端点刷新；
	 * - 会话、消息、设置、计划、目标、审批、问答只在「整份数据首次落地 / 用户重试 / 换供应商」时覆盖，
	 *   避免每轮结束后的刷新把流式消息、本地提示和乐观更新冲掉。
	 * 单个面板失败只把对应状态置空并给出该面板的错误文案，其它面板照常渲染。
	 */
	useEffect(() => {
		const data = bootstrap.data;
		if (!data || bootstrap.dataSessionId !== sessionId) return;
		const failures = data.errors;
		const panelError = (key: BootstrapKey, label: string) =>
			failures[key] ? `${label}加载失败：${failures[key]}` : null;

		// 会话列表：失败时保留上一份；首次失败用当前会话兜底，侧栏结构不塌。
		if (!failures.sessions) setSessions(data.sessions);
		else setSessions((prev) => (prev.length > 0 ? prev : [{ id: sessionId, title: "当前会话", createdAt: "" }]));
		setSessionsLoading(false);

		// 工作台文件 + 记忆库。
		setFiles(data.files);
		setFilesForSession(sessionId);
		setFilesError(panelError("files", "文件"));
		setFilesState(failures.files ? "error" : "ready");
		setMemories(data.memories);
		setMemoriesError(panelError("memories", "记忆"));
		setMemoriesState(failures.memories ? "error" : "ready");

		// 左侧面板：技能 / 模板 / 规则 / 自定义工具 / MCP / 定时任务。
		setPrompts(data.prompts);
		setRules(data.rules);
		setCustomTools(data.customTools);
		setSkills(data.skills);
		setSkillsError(panelError("skills", "技能"));
		setSkillsLoading(false);
		setAutomations(data.automations);
		setAutomationsError(panelError("automations", "定时任务"));
		setAutomationsLoading(false);
		setMcpServers(data.mcpServers);
		setMcpError(panelError("mcpServers", "MCP"));
		setMcpLoading(false);

		const last = bootstrapHydratedRef.current;
		const full = last?.sessionId !== sessionId || last?.reloadKey !== reloadKey || last?.modelsTick !== modelsTick;
		if (!full) return;
		bootstrapHydratedRef.current = { sessionId, reloadKey, modelsTick };

		setOnline(data.session.ok);
		setSessionName(data.session.name);
		setLoading(false);
		setLoadError(panelError("entries", "会话记录"));
		setMessages(withAbsoluteShareLinks(parseEntries(data.entries)));

		const settings = data.settings;
		if (settings) {
			setWebSearch(settings.webSearch !== false);
			if (typeof settings.kbPrefetch === "boolean") setKbPrefetch(settings.kbPrefetch);
			if (typeof settings.kbRetrieval === "string") setKbRetrieval(settings.kbRetrieval);
			if (typeof settings.thinkingLevel === "string") setThinkingLevel(settings.thinkingLevel);
			if (typeof settings.displayName === "string") setDisplayName(settings.displayName);
			if (typeof settings.shareTtlSeconds === "number") setShareTtlSeconds(settings.shareTtlSeconds);
			if (settings.compaction) setCompaction(settings.compaction);
			if (settings.approval) setApprovalSettings(settings.approval);
		} else {
			// 设置面板失败时沿用原 api.settings 失败分支的默认值
			setWebSearch(true);
		}

		if (!failures.models) {
			if (data.models.models.length > 0) setModels(data.models.models);
			if (data.models.default) setModel(data.models.default);
		}

		setPlan(data.plan);
		setGoal(data.goal);
		setApprovals(data.approvals);
		setAskQuestions(data.questions);
	}, [bootstrap.data, bootstrap.dataSessionId, sessionId, reloadKey, modelsTick]);

	/**
	 * 整份 bootstrap 失败（网络 / 401 / 5xx）：只有当前会话还没有可用数据时才降级成错误态；
	 * 同一会话的后台刷新失败保留上一份面板，不打断正在看的内容。
	 */
	useEffect(() => {
		if (!bootstrap.error) return;
		if (bootstrap.dataSessionId === sessionId && bootstrap.data) return;
		const detail = bootstrap.error;
		setOnline(false);
		setLoading(false);
		setLoadError(detail);
		setSessionsLoading(false);
		setFilesState("error");
		setFilesError(detail);
		setMemoriesState("error");
		setMemoriesError(detail);
		setSkillsLoading(false);
		setSkillsError("加载技能失败。");
		setAutomationsLoading(false);
		setAutomationsError("加载定时任务失败。");
		setMcpLoading(false);
		setMcpError("加载 MCP 服务器失败。");
	}, [bootstrap.error, bootstrap.dataSessionId, bootstrap.data, sessionId]);

	/** 拉取待审批列表（工具被拦下后调用）。 */
	const refreshApprovals = useCallback(async () => {
		try {
			const data = await api.approvals(sessionId);
			setApprovals(data.approvals ?? []);
		} catch {
			// 忽略：下一次事件会再拉
		}
	}, [sessionId]);

	/** Send one message (event handler, not an effect). */
	const handleSend = useCallback(
		(text: string, images: string[] = []) => {
			if (pending) return;
			const generation = generationRef.current;
			const controller = new AbortController();
			abortRef.current = controller;

			setMessages((prev) => [...prev, { id: nextId(), role: "user", text: text || "（图片）", images: images.length ? images : undefined }]);
			setPending(true);
			setElapsed(0);

			void (async () => {
				// Streaming bubble: created on first delta / tool event so an empty wait shows nothing.
				let bubbleId = nextId();
				let bubbleShown = false;
				let buffered = "";
				let thinkingBuf = "";
				const tools: ToolCallInfo[] = [];
				const artifacts: FileArtifact[] = [];
				const shareLinks: ShareLink[] = [];
				/** 压缩提示（v0.31.0）：start 时插一条 notice，end 时把它改成完成态。 */
				let compactionNoticeId: string | null = null;
				const ensureBubble = () => {
					if (bubbleShown) return;
					bubbleShown = true;
					setMessages((prev) => [...prev, { id: bubbleId, role: "assistant", text: "", tools: [] }]);
				};
				const syncBubble = () => {
					setMessages((prev) =>
						prev.map((m) =>
							m.id === bubbleId
								? {
										...m,
										text: buffered || " ",
										thinking: thinkingBuf || undefined,
										tools: tools.length ? tools.map((t) => ({ ...t })) : [],
										files: artifacts.length ? [...artifacts] : undefined,
										shares: shareLinks.length ? [...shareLinks] : undefined,
									}
								: m,
						),
					);
				};
				// 目标续转（v0.31.0）：新一轮从一条空气泡重新开始，上一轮的内容保持不动
				const startNewRound = (label: string) => {
					bubbleShown = false;
					bubbleId = nextId();
					buffered = "";
					thinkingBuf = "";
					tools.length = 0;
					artifacts.length = 0;
					shareLinks.length = 0;
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: label }]);
				};
				// update_plan 的入参就是最新计划：聊天里实时渲染，不用等工具结果
				const applyPlan = (args: unknown) => {
					const steps = (args as { steps?: unknown })?.steps;
					if (!Array.isArray(steps)) return;
					const parsed: PlanStep[] = [];
					for (const item of steps) {
						const o = (item ?? {}) as { title?: unknown; status?: unknown };
						const title = String(o.title ?? "").trim();
						if (!title) continue;
						const s = String(o.status ?? "pending");
						parsed.push({ title, status: s === "completed" || s === "in_progress" ? s : "pending" });
					}
					if (parsed.length) setPlan(parsed);
				};
				try {
					await api.streamChat(
						text,
						sessionId,
						images,
						(event) => {
							if (generationRef.current !== generation) return;
							if (event.type === "thinking") {
								thinkingBuf += typeof event.delta === "string" ? event.delta : "";
								ensureBubble();
								syncBubble();
							} else if (event.type === "thinking_start") {
								ensureBubble();
							} else if (event.type === "text") {
								buffered += typeof event.delta === "string" ? event.delta : "";
								ensureBubble();
								syncBubble();
							} else if (event.type === "compaction") {
								// 上下文压缩（v0.31.0）：开始 → 插提示；结束 → 改成完成态
								const status = typeof event.status === "string" ? event.status : "";
								if (status === "start") {
									const id = nextId();
									compactionNoticeId = id;
									setMessages((prev) => [...prev, { id, role: "notice", text: "上下文较长，正在压缩更早的内容…" }]);
								} else if (status === "end") {
									const id = compactionNoticeId;
									setMessages((prev) =>
										prev.map((m) =>
											id && m.id === id ? { ...m, text: "上下文已压缩：更早的对话被摘要为一条记录。" } : m,
										),
									);
									setContextTick((tick) => tick + 1);
								}
							} else if (event.type === "goal") {
								// 目标状态（v0.31.0）：更新目标条；续转时开新一轮气泡
								const next = (event.goal ?? null) as GoalInfo | null;
								if (next) setGoal(next);
								if (event.continuing) {
									startNewRound(`继续推进目标（第 ${Number(event.round ?? 0) + 1} 轮）`);
								} else if (event.finished) {
									setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "目标已结束。" }]);
								} else if (event.paused) {
									setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "目标已暂停：等你回答问题后继续。" }]);
								} else if (event.scheduled) {
									setMessages((prev) => [
										...prev,
										{ id: nextId(), role: "notice", text: "本轮自动续转结束，目标仍在进行：稍后会自动接着跑。" },
									]);
								}
							} else if (event.type === "tool_start") {
								const name = typeof event.name === "string" ? event.name : "tool";
								tools.push({
									name,
									summary: "执行中…",
									id: typeof event.id === "string" ? event.id : undefined,
									parentId: typeof event.parentId === "string" ? event.parentId : undefined,
									status: "running",
									args: event.args,
								});
								if (name === "update_plan") applyPlan(event.args);
								// write_file 的入参里就有文件名 → 直接出文件卡
								const fileName = (event.args as { name?: unknown } | undefined)?.name;
								if (name === "write_file" && typeof fileName === "string" && fileName.trim()) {
									if (!artifacts.some((f) => f.name === fileName)) artifacts.push({ name: fileName });
								}
								ensureBubble();
								syncBubble();
							} else if (event.type === "tool_end") {
								const id = typeof event.id === "string" ? event.id : undefined;
								const name = typeof event.name === "string" ? event.name : "tool";
								const target = id
									? tools.find((t) => t.id === id)
									: [...tools].reverse().find((t) => t.name === name && t.status === "running");
								// 工具被审批拦下时会在摘要里说明：立刻刷新待审批列表
								if (typeof event.summary === "string" && event.summary.includes("待审批")) void refreshApprovals();
								if (typeof event.summary === "string" && event.summary.includes("等待回答")) void refreshQuestions();
								if (target) {
									target.status = event.error ? "error" : "done";
									target.summary =
										typeof event.summary === "string" && event.summary
											? truncateOneLine(event.summary, TOOL_SUMMARY_MAX)
											: "完成";
								}
								// 分享工具：details 里带链接 → 直接渲染链接卡（v0.55.0）
								const share = shareFromToolDetails(event.details);
								if (share) {
									const url = shareUrlFor(share.url, window.location.origin, readTheme());
									if (!shareLinks.some((link) => link.url === url)) shareLinks.push({ ...share, url });
								}
								syncBubble();
							} else if (event.type === "done") {
								void refreshApprovals();
								void refreshQuestions();
								setContextTick((tick) => tick + 1);
								const answer = typeof event.answer === "string" ? event.answer : "";
								// 流式补齐（NERE-41）：done 事件与 entry 同一份 kbRefs；缺省不追请求
								const kbRefs = parseKbRefs(event.kbRefs ?? []);
								if (!bubbleShown) ensureBubble();
								setMessages((prev) => {
									const next = prev.map((m) =>
										m.id === bubbleId
											? {
													...m,
													text: answer || "（空回复）",
													thinking: thinkingBuf || undefined,
													tools: tools.length ? tools.map((t) => ({ ...t, status: (t.status === "running" ? "done" : t.status) as ToolCallInfo["status"] })) : [],
													files: artifacts.length ? [...artifacts] : undefined,
													shares: shareLinks.length ? [...shareLinks] : undefined,
													kbRefs: kbRefs.length ? kbRefs : undefined,
												}
											: m,
									);
									return next;
								});
							} else if (event.type === "error") {
								ensureBubble();
								setMessages((prev) =>
									prev.map((m) =>
										m.id === bubbleId
											? { ...m, text: `出错了：${String(event.message ?? "未知错误")}`, error: true }
											: m,
									),
								);
							}
						},
						controller.signal,
					);
				} catch (err) {
					if (generationRef.current !== generation) return; // invalidated by 新会话 / session switch
					if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
						setMessages((prev) => [
							...prev,
							{ id: nextId(), role: "notice", text: "已停止等待本次回复（服务端可能仍在处理）。" },
						]);
					} else {
						const detail = err instanceof Error ? err.message : String(err);
						setMessages((prev) => [...prev, { id: nextId(), role: "assistant", text: `请求失败：${detail}`, error: true }]);
					}
				} finally {
					if (abortRef.current === controller) abortRef.current = null;
					if (generationRef.current === generation) {
						setPending(false);
						// New files / memories may have been produced by this round — refresh the workbench
						setPanelTick((tick) => tick + 1);
					}
				}
			})();
		},
		[pending, nextId, sessionId],
	);

	/** 建立目标并立刻发出第一轮（v0.31.0）。 */
	const handleCreateGoal = useCallback(
		async (objective: string, tokenBudget: number, maxTurns: number): Promise<boolean> => {
			try {
				const res = await api.setGoal({ sessionId, objective, tokenBudget, maxTurns });
				if (!res.goal) return false;
				setGoal(res.goal);
				handleSend(objective, []);
				return true;
			} catch {
				return false;
			}
		},
		[sessionId, handleSend],
	);

	/** 从某条用户消息分叉出新会话（v0.32.0）。 */
	const handleBranch = useCallback(
		(entryId: number) => {
			if (resetting || pending) return;
			abortRef.current?.abort();
			generationRef.current += 1;
			void (async () => {
				try {
					const res = await api.branch(sessionId, entryId);
					if (!res.id) throw new Error(res.error || "分支创建失败");
					setSessionId(res.id);
					setMessages([]);
					setPending(false);
					setElapsed(0);
					setPanelTick((tick) => tick + 1);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `分支出错：${detail}` }]);
				}
			})();
		},
		[sessionId, resetting, pending, nextId],
	);

	/** 审批决定（v0.33.0）：允许后自动让模型继续，拒绝则让它改方案。 */
	const handleDecideApproval = useCallback(
		(id: number, action: "once" | "always" | "deny") => {
			setApprovalBusy(true);
			void (async () => {
				try {
					const res = await api.decideApproval(id, action);
					setApprovals((prev) => prev.filter((a) => a.id !== id));
					if (res.resume) handleSend(res.resume, []);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `审批失败：${detail}` }]);
				} finally {
					setApprovalBusy(false);
				}
			})();
		},
		[sessionId, handleSend, nextId],
	);

	/** 拉取待回答问题（ask_user 触发后调用）。 */
	const refreshQuestions = useCallback(async () => {
		try {
			const data = await api.questions(sessionId);
			setAskQuestions((data.questions ?? []) as AskQuestion[]);
		} catch {
			// 忽略：下一次事件会再拉
		}
	}, [sessionId]);

	/** 提交问答卡片的回答（v0.37.0）：把答案发回给模型继续。 */
	const handleAnswerQuestion = useCallback(
		(id: number, answers: { id: string; choice?: string; text?: string }[]) => {
			setAskBusy(true);
			void (async () => {
				try {
					const res = await api.answerQuestion(id, answers);
					setAskQuestions((prev) => prev.filter((q) => q.id !== id));
					if (res.resume) handleSend(res.resume, []);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `提交回答失败：${detail}` }]);
				} finally {
					setAskBusy(false);
				}
			})();
		},
		[sessionId, handleSend, nextId],
	);

	/** 生成中插话（v0.34.0）：消息进入当前这轮，不打断。 */
	const handleInterject = useCallback(
		(text: string) => {
			if (!text.trim()) return;
			setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
			void (async () => {
				try {
					await api.interject(sessionId, text);
					setMessages((prev) => [
						...prev,
						{ id: nextId(), role: "notice", text: "已插入本轮：模型会在下一次工具调用后看到。" },
					]);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `插话失败：${detail}` }]);
				}
			})();
		},
		[sessionId, nextId],
	);

	/** 审批策略（v0.33.0）：分级或逐工具覆盖。 */
	const handleChangeApproval = useCallback(
		(patch: Partial<{ read: string; write: string; exec: string }>) => {
			setApprovalSettings((prev) => ({ read: "allow", write: "allow", exec: "allow", ...(prev ?? {}), ...patch }));
			void api.setSettings({ approval: patch }).catch(() => {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "审批策略保存失败。" }]);
			});
		},
		[nextId],
	);

	const handleChangeApprovalTool = useCallback(
		(name: string, policy: string) => {
			void api.setSettings({ approvalTools: { [name]: policy } }).catch(() => {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "逐工具策略保存失败。" }]);
			});
		},
		[nextId],
	);

	/** 停止目标的自动续转（保留记录）。 */
	/** 自定义工具（v0.36.0）：增删后刷新能力面板。 */
	const handleAddCustomTool = useCallback(
		async (name: string, description: string, parameters: string, code: string) => {
			try {
				await api.addCustomTool({ name, description, parameters, code });
				setPanelTick((tick) => tick + 1);
				return true;
			} catch {
				return false;
			}
		},
		[],
	);

	const handleDeleteCustomTool = useCallback(async (name: string) => {
		try {
			await api.deleteCustomTool(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleStopGoal = useCallback(async () => {
		try {
			const res = await api.stopGoal(sessionId);
			setGoal(res.goal ?? null);
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "已停止目标的自动续转。" }]);
		} catch {
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "停止目标失败，请重试。" }]);
		}
	}, [sessionId, nextId]);

	/** 停止：先让服务端真正中止生成（省 token），再断开本地流（v0.19.0）。 */
	const handleStop = useCallback(() => {
		abortRef.current?.abort();
		void api.abort(sessionId).catch(() => {});
	}, [sessionId]);

	// 访问控制（一次）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.auth();
				if (alive) setAuth({ required: !!data.required, authenticated: !!data.authenticated, owner: !!data.owner, demoUrl: data.demoUrl });
			} catch {
				if (alive) setAuth({ required: false, authenticated: true, owner: true });
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	const handleLogin = useCallback(async (password: string) => {
		setLoginError(null);
		try {
			const result = await api.login(password);
			if (result.ok === false) {
				setLoginError(result.error ?? "密码不正确");
				return;
			}
			setAuth({ required: true, authenticated: true, owner: !!result.owner });
			// 登录前页面已在无 cookie 状态拉过面板数据，直接重载清掉 401 缓存（v0.43.2）
			window.location.reload();
		} catch {
			setLoginError("密码不正确");
		}
	}, []);

	// 切换会话时，从会话列表带出该会话的模型（若无则默认）
	useEffect(() => {
		const listed = sessions.find((s) => s.id === sessionId);
		if (listed?.model) setModel(listed.model);
	}, [sessions, sessionId]);

	const handleModelChange = useCallback(
		(next: string) => {
			setModel(next);
			void api.setModel(sessionId, next).catch(() => {});
		},
		[sessionId],
	);

	const handleAddSkill = useCallback(async (name: string, description: string, content: string) => {
		try {
			await api.addSkill(name, description, content);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			setSkillsError("保存技能失败。");
			return false;
		}
	}, []);

	const handleImportSkill = useCallback(async (url: string) => {
		try {
			const result = await api.importSkill(url);
			if (result.ok) {
				setMessages((prev) => [
					...prev,
					{ id: nextId(), role: "notice", text: `已安装技能：${result.name ?? "（未命名）"}` },
				]);
				setPanelTick((tick) => tick + 1);
				return true;
			}
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `安装失败：${result.error ?? "未知错误"}` }]);
			return false;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `安装失败：${detail}` }]);
			return false;
		}
	}, [nextId]);

	const handleAddPrompt = useCallback(async (name: string, description: string, content: string) => {
		try {
			await api.addPrompt(name, description, content);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeletePrompt = useCallback(async (name: string) => {
		try {
			await api.deletePrompt(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleAddRule = useCallback(async (name: string, content: string) => {
		try {
			await api.addRule(name, content);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleToggleRule = useCallback(async (name: string, enabled: boolean) => {
		try {
			await api.toggleRule(name, enabled);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeleteRule = useCallback(async (name: string) => {
		try {
			await api.deleteRule(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeleteSkill = useCallback(async (name: string) => {
		try {
			await api.deleteSkill(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleAddAutomation = useCallback(
		async (name: string, prompt: string, schedule: { kind: string; time?: string; minutes?: number }) => {
			try {
				await api.addAutomation(name, prompt, sessionId, schedule);
				setPanelTick((tick) => tick + 1);
				return true;
			} catch {
				setAutomationsError("创建失败。");
				return false;
			}
		},
		[sessionId],
	);

	const handleToggleAutomation = useCallback(async (id: string, enabled: boolean) => {
		try {
			await api.toggleAutomation(id, enabled);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeleteAutomation = useCallback(async (id: string) => {
		try {
			await api.deleteAutomation(id);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleAddMcp = useCallback(async (name: string, url: string, headers?: Record<string, string>) => {
		try {
			const result = await api.addMcp(name, url, headers);
			setPanelTick((tick) => tick + 1);
			setMessages((prev) => [
				...prev,
				{ id: nextId(), role: "notice", text: `已连接 MCP「${name}」：${result.tools ?? 0} 个工具` },
			]);
			return true;
		} catch {
			setMcpError("添加失败，请检查地址或密钥。");
			return false;
		}
	}, [nextId]);

	const handleDeleteMcp = useCallback(async (id: string) => {
		try {
			await api.deleteMcp(id);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	/** 新会话：abort in-flight wait → POST /api/sessions → switch to the new conversation. */
	const handleNewSession = useCallback(() => {
		if (resetting) return;
		abortRef.current?.abort();
		generationRef.current += 1;
		setResetting(true);

		void (async () => {
			let created: { id?: string } | null = null;
			try {
				created = await api.createSession();
			} catch {
				created = null;
			}
			setResetting(false);
			const id = created?.id;
			if (!id) {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "新建会话失败，请重试。" }]);
				return;
			}
			setSessionId(id);
			setMessages([]);
			setPending(false);
			setElapsed(0);
			setPanelTick((tick) => tick + 1); // refresh the session list
		})();
	}, [resetting, nextId]);

	/** Switch to another session from the sidebar (v3). */
	const handleSelectSession = useCallback(
		(id: string) => {
			setDrawerOpen(false);
			if (id === sessionId) return;
			abortRef.current?.abort();
			generationRef.current += 1;
			setSessionId(id);
			setMessages([]);
			setPending(false);
			setElapsed(0);
			setLoading(true);
			setLoadError(null);
		},
		[sessionId],
	);

	/** 主题切换（v0.24.0）：深色/浅色/米黄/午夜蓝，写入 localStorage 供首屏脚本使用。 */
	const handleThemeChange = useCallback((next: ThemeId) => {
		setTheme(next);
		applyTheme(next);
	}, []);

	/** 从聊天里的文件卡打开右栏预览。 */
	const handleOpenFileFromChat = useCallback((name: string) => {
		if (!name) return;
		setFileRequest((prev) => ({ name, tick: (prev?.tick ?? 0) + 1 }));
		setWorkbenchWide(false);
		setRightOpen(true);
		saveBool(RIGHT_OPEN_KEY, true);
	}, []);

	/** 从「全部文件」跨会话打开：先切会话，再请求右栏打开（v0.45.0）。 */
	const handleOpenFileAcrossSessions = useCallback(
		(targetSession: string, name: string) => {
			if (!name) return;
			if (targetSession && targetSession !== sessionId) handleSelectSession(targetSession);
			setFileRequest((prev) => ({ name, tick: (prev?.tick ?? 0) + 1 }));
			setWorkbenchWide(false);
			setRightOpen(true);
			saveBool(RIGHT_OPEN_KEY, true);
			if (!isDesktop) setMobileTab("files");
		},
		[sessionId, handleSelectSession, isDesktop],
	);

	/** 从消息里的参考资料跳到知识库（NERE-41）：切到知识库栏并打开原文，手机端顺带展开抽屉。 */
	const handleOpenKbRef = useCallback(
		(ref: KbRef) => {
			kbFocusSeq.current += 1;
			setRailView("kb");
			setLeftOpen(true);
			if (!isDesktop) setDrawerOpen(true);
			setKbFocus({ docId: ref.docId, chunkSeq: ref.chunkSeq, nonce: kbFocusSeq.current });
		},
		[isDesktop],
	);

	/** 拖拽分隔条调整右栏宽度（限制在 260px ~ 视口 65%）。 */
	const handleRightResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = rightWidth;
		let current = startWidth;
		const onMove = (e: PointerEvent) => {
			current = Math.min(Math.max(260, startWidth - (e.clientX - startX)), Math.round(window.innerWidth * 0.65));
			setRightWidth(current);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			// 用户手动调过宽度：关闭文件时不要再还原成打开前的值
			widthBeforeFileRef.current = null;
			try {
				localStorage.setItem("pi-right-width", String(current));
			} catch {
				// 忽略存储失败
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [rightWidth]);

	/** 拖拽分隔条调整左栏宽度（限制在 200px ~ 视口 45%）。 */
	const handleLeftResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = leftWidth;
		let current = startWidth;
		const onMove = (e: PointerEvent) => {
			current = Math.min(Math.max(200, startWidth + (e.clientX - startX)), Math.round(window.innerWidth * 0.45));
			setLeftWidth(current);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			try {
				localStorage.setItem("pi-left-width", String(current));
			} catch {
				// 忽略存储失败
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [leftWidth]);

	/**
	 * 打开文件时自动加宽，保证文档可读（v0.16.0）；
	 * 关闭文件时还原到打开前的宽度并退出全宽阅读（v0.22.1 修复「关掉标签页后右栏没恢复」）。
	 */
	const handleFileOpenChange = useCallback((open: boolean) => {
		if (open) {
			if (widthBeforeFileRef.current === null) widthBeforeFileRef.current = rightWidthRef.current;
			setRightWidth((w) => (w < 560 ? 560 : w));
			return;
		}
		const before = widthBeforeFileRef.current;
		widthBeforeFileRef.current = null;
		if (before !== null) setRightWidth(before);
		setWorkbenchWide(false);
	}, []);

	/** 备份：下载全量 JSON。 */
	const handleBackup = useCallback(() => {
		const link = document.createElement("a");
		link.href = "/api/backup";
		link.download = `pi-harness-backup-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(link);
		link.click();
		link.remove();
	}, []);

	/** 恢复：读取上传的 JSON 并回传后端。 */
	const handleRestore = useCallback((file: File) => {
		void (async () => {
			try {
				const payload = JSON.parse(await file.text()) as unknown;
				const result = await api.restore(payload);
				const counts = result.counts ?? {};
				const text = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("，");
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `恢复完成：${text || "无新增"}` }]);
				setPanelTick((tick) => tick + 1);
			} catch {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "恢复失败，文件格式不正确。" }]);
			}
		})();
	}, [nextId]);

	/** 分享：生成只读链接并复制到剪贴板。 */
	const handleShare = useCallback(() => {
		void (async () => {
			try {
				// 已有未过期的会话分享链接就直接复用（v0.40.0）
				const existing = await api.shares(sessionId, "conversation").catch(() => null);
				const reused = existing?.shares?.[0];
				let url = reused?.url ?? "";
				if (!url) {
					const data = await api.share(sessionId, readTheme());
					url = data.url ?? "";
				}
				if (!url) throw new Error("no url");
				// 域名一律用当前页面：pages.dev 反代下服务端看到的是 workers.dev 地址
				const absolute = shareUrlFor(url, window.location.origin, readTheme());
				try {
					await navigator.clipboard.writeText(absolute);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `只读分享链接已复制：${absolute}` }]);
				} catch {
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `只读分享链接：${absolute}` }]);
				}
			} catch {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "生成分享链接失败。" }]);
			}
		})();
	}, [sessionId, nextId]);

	/** 导出当前会话：直接下载 Markdown 文件。 */
	const handleExport = useCallback(() => {
		const url = `/api/export?format=md&sessionId=${encodeURIComponent(sessionId)}`;
		const link = document.createElement("a");
		link.href = url;
		link.download = `session-${sessionId}.md`;
		document.body.appendChild(link);
		link.click();
		link.remove();
	}, [sessionId]);

	/** 重命名会话：乐观更新侧栏，失败回滚由下一次刷新兜底。 */
	const handleRenameSession = useCallback(
		(id: string, title: string) => {
			setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
			void api.renameSession(id, title).catch(() => setPanelTick((tick) => tick + 1));
		},
		[],
	);

	/** 删除会话：删掉后若删的是当前会话，切到第一个剩余会话（没有就新建）。 */
	const handleDeleteSession = useCallback(
		(id: string) => {
			void (async () => {
				try {
					await api.deleteSession(id);
				} catch {
					setPanelTick((tick) => tick + 1);
					return;
				}
				const rest = sessions.filter((s) => s.id !== id);
				setSessions(rest);
				if (id === sessionId) {
					const next = rest[0]?.id;
					if (next) {
						abortRef.current?.abort();
						generationRef.current += 1;
						setSessionId(next);
						setMessages([]);
						setLoading(true);
					} else {
						setMessages([]);
						setPanelTick((tick) => tick + 1);
					}
				}
			})();
		},
		[sessions, sessionId],
	);

	const handleRetry = useCallback(() => {
		setLoading(true);
		setLoadError(null);
		setReloadKey((key) => key + 1);
	}, []);

	const toggleLeft = useCallback(() => {
		setLeftOpen((prev) => {
			const next = !prev;
			saveBool(LEFT_OPEN_KEY, next);
			return next;
		});
	}, []);

	const toggleRight = useCallback(() => {
		setRightOpen((prev) => {
			const next = !prev;
			saveBool(RIGHT_OPEN_KEY, next);
			return next;
		});
	}, []);

	/** 网页搜索开关：乐观更新，失败回滚并提示。 */
	const handleToggleWebSearch = useCallback(
		(next: boolean) => {
			setWebSearch(next);
			void api.setSettings({ webSearch: next }).catch(() => {
				setWebSearch(!next);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "网页搜索设置保存失败。" }]);
			});
		},
		[nextId],
	);

	/** 知识库预检索开关（v0.46.0）：乐观更新，失败回滚。 */
	const handleToggleKbPrefetch = useCallback(
		(next: boolean) => {
			setKbPrefetch(next);
			void api.setSettings({ kbPrefetch: next }).catch(() => {
				setKbPrefetch(!next);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "知识库预检索设置保存失败。" }]);
			});
		},
		[nextId],
	);

	/** 分享页署名（v0.55.0）：失焦保存，失败回滚并提示。 */
	const handleSaveDisplayName = useCallback(
		(next: string) => {
			const previous = displayName;
			const value = next.trim().slice(0, 40);
			setDisplayName(value);
			void api.setSettings({ displayName: value }).catch(() => {
				setDisplayName(previous);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "分享署名保存失败。" }]);
			});
		},
		[displayName, nextId],
	);

	/** 分享默认有效期（v0.55.0）：tool 不传 ttlSeconds 时使用。 */
	const handleChangeShareTtl = useCallback(
		(next: number) => {
			const previous = shareTtlSeconds;
			setShareTtlSeconds(next);
			void api.setSettings({ shareTtlSeconds: next }).catch(() => {
				setShareTtlSeconds(previous);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "分享有效期设置保存失败。" }]);
			});
		},
		[shareTtlSeconds, nextId],
	);

	/** 知识库检索模式（v0.53.0）：乐观更新，失败回滚。 */
	const handleChangeKbRetrieval = useCallback(
		(next: string) => {
			const previous = kbRetrieval;
			setKbRetrieval(next);
			void api.setSettings({ kbRetrieval: next }).catch(() => {
				setKbRetrieval(previous);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "知识库检索模式保存失败。" }]);
			});
		},
		[kbRetrieval, nextId],
	);

	/** 思考档位（v0.22.0）：off/低/高，后端在下一次对话生效。 */
	const handleChangeThinkingLevel = useCallback((next: string) => {
		const prev = thinkingLevel;
		setThinkingLevel(next);
		void api.setSettings({ thinkingLevel: next }).catch(() => {
			setThinkingLevel(prev);
			setMessages((m) => [...m, { id: nextId(), role: "notice", text: "思考档位保存失败。" }]);
		});
	}, [thinkingLevel, nextId]);

	/** 一键清空记忆库（v0.26.0）。 */
	const handleClearMemories = useCallback(async (): Promise<number | null> => {
		try {
			const result = await api.clearMemories();
			setPanelTick((tick) => tick + 1);
			setMessages((prev) => [
				...prev,
				{ id: nextId(), role: "notice", text: `已清空记忆库（${result.deleted ?? 0} 条）。` },
			]);
			return result.deleted ?? 0;
		} catch {
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "清空记忆库失败。" }]);
			return null;
		}
	}, [nextId]);

	/** 压缩策略（v0.30.0）：改动后后端会重建 Harness，下一轮生效。 */
	const handleChangeCompaction = useCallback(
		(patch: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>) => {
			setCompaction((prev) => ({
				enabled: patch.enabled ?? prev?.enabled ?? true,
				reserveTokens: patch.reserveTokens ?? prev?.reserveTokens ?? 16384,
				keepRecentTokens: patch.keepRecentTokens ?? prev?.keepRecentTokens ?? 20000,
				backgroundTokens: patch.backgroundTokens ?? prev?.backgroundTokens ?? 32768,
			}));
			void api.setSettings({ compaction: patch }).catch(() => {
				setMessages((m) => [...m, { id: nextId(), role: "notice", text: "压缩设置保存失败。" }]);
			});
		},
		[nextId],
	);

	/** 退出登录：清 cookie 并回到登录闸门。 */
	const handleLogout = useCallback(() => {
		setSettingsOpen(false);
		void (async () => {
			try {
				await api.logout();
			} catch {
				// 忽略网络错误，本地同样回到登录页
			}
			setAuth({ required: true, authenticated: false });
		})();
	}, []);

	/** Sidebar 记忆库入口已移除（v0.21.0）：记忆列表在设置弹窗里。 */

	// 窗口尺寸跨越断点时自动展开/收起（用户手动设置过则不干预）
	useEffect(() => {
		const onResize = () => {
			if (loadBoolOrNull(LEFT_OPEN_KEY) === null) setLeftOpen(window.innerWidth >= 1024);
			if (loadBoolOrNull(RIGHT_OPEN_KEY) === null) setRightOpen(window.innerWidth >= 1280);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const handleDeleteFile = useCallback(
		async (name: string): Promise<boolean> => {
			try {
				await api.deleteFile(sessionId, name);
				setPanelTick((tick) => tick + 1);
				return true;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `删除文件失败：${detail}` }]);
				return false;
			}
		},
		[sessionId, nextId],
	);

	const handleDeleteMemory = useCallback(
		async (id: number): Promise<boolean> => {
			try {
				await api.deleteMemory(id);
				setPanelTick((tick) => tick + 1);
				return true;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `删除记忆失败：${detail}` }]);
				return false;
			}
		},
		[sessionId, nextId],
	);

	// 未登录：整屏登录闸门（登录成功后同一组件继续渲染）
	if (auth && auth.required && !auth.authenticated) {
		return <LoginGate onSubmit={handleLogin} error={loginError} demoUrl={auth.demoUrl} />;
	}
	if (!auth) {
		return (
			<div className="flex h-dvh items-center justify-center bg-slate-950 text-sm text-slate-500">正在检查访问权限…</div>
		);
	}

	const currentSession = sessions.find((s) => s.id === sessionId);
	const sessionLabel = sessionName || (currentSession ? currentSession.title : "");
	// Rail 常驻（v0.21.0），leftOpen 只控制左侧内容栏
	const showLeftContent = isDesktop && leftOpen;
	// 全宽阅读时让文档独占（v0.16.0）：桌面上隐藏聊天栏，避免被挤成窄条
	const showChat = isDesktop ? !workbenchWide : mobileTab === "chat";
	const showWorkbench = isDesktop ? rightOpen : mobileTab === "files";

	/** 左侧内容：随 Rail 切换（会话 / 连接 / 定时 / 技能）。 */
	const sidebar = (
		<Sidebar
			sessions={sessions}
			currentId={sessionId}
			query={sessionQuery}
			sessionsLoading={sessionsLoading}
			onQueryChange={setSessionQuery}
			onSelect={handleSelectSession}
			onRename={handleRenameSession}
			onDelete={handleDeleteSession}
			onCollapse={toggleLeft}
		/>
	);

	// 邀请用户没有用户管理入口；切回会话栏（v0.43.0）
	const activeRailView = railView === "users" && !auth?.owner ? "sessions" : railView;
	const leftContent =
		activeRailView === "sessions" ? (
			sidebar
		) : activeRailView === "files" ? (
			<FilesPanel
				refreshTick={panelTick}
				onOpen={handleOpenFileAcrossSessions}
				onChanged={() => setPanelTick((tick) => tick + 1)}
				onCollapse={toggleLeft}
			/>
		) : activeRailView === "kb" ? (
			<KnowledgePanel onCollapse={toggleLeft} focus={kbFocus} />
		) : activeRailView === "shares" ? (
			<SharesPanel onCollapse={toggleLeft} />
		) : activeRailView === "mcp" ? (
			<McpPanel servers={mcpServers} loading={mcpLoading} error={mcpError} onAdd={handleAddMcp} onDelete={handleDeleteMcp} onCollapse={toggleLeft} />
		) : activeRailView === "automations" ? (
			<AutomationPanel
				items={automations}
				loading={automationsLoading}
				error={automationsError}
				onAdd={handleAddAutomation}
				onToggle={handleToggleAutomation}
				onDelete={handleDeleteAutomation}
				onCollapse={toggleLeft}
			/>
		) : activeRailView === "users" ? (
			<UsersPanel onCollapse={toggleLeft} />
		) : (
			<SkillPanel
				items={skills}
				loading={skillsLoading}
				error={skillsError}
				onAdd={handleAddSkill}
				onDelete={handleDeleteSkill}
				onImport={handleImportSkill}
				prompts={prompts}
				rules={rules}
				onAddPrompt={handleAddPrompt}
				onDeletePrompt={handleDeletePrompt}
				onAddRule={handleAddRule}
				onToggleRule={handleToggleRule}
				onDeleteRule={handleDeleteRule}
				customTools={customTools}
				onAddCustomTool={handleAddCustomTool}
				onDeleteCustomTool={handleDeleteCustomTool}
				onCollapse={toggleLeft}
			/>
		);

	const rail = (
		<Rail
			view={activeRailView}
			onViewChange={setRailView}
			onNewSession={handleNewSession}
			newSessionDisabled={resetting}
			onOpenSettings={() => setSettingsOpen(true)}
			isOwner={!!auth?.owner}
		/>
	);

	return (
		<div className="relative flex h-dvh flex-col bg-slate-950 text-slate-100">
			<TopBar
				online={online}
				sessionLabel={sessionLabel}
				onOpenDrawer={() => setDrawerOpen(true)}
				onOpenSettings={() => setSettingsOpen(true)}
			/>

			<div className="flex min-h-0 flex-1">
				{isDesktop && rail}
				{showLeftContent && (
					<>
						<div
							className="min-w-0 shrink-0"
							style={{ width: railView === "sessions" ? leftWidth : Math.max(leftWidth, 300) }}
						>
							{leftContent}
						</div>
						<div
							role="separator"
							aria-orientation="vertical"
							aria-label="调整会话栏宽度"
							onPointerDown={handleLeftResizeStart}
							className="w-1 shrink-0 cursor-col-resize bg-slate-800/40 transition-colors hover:bg-sky-500/50"
						/>
					</>
				)}

				{showChat && (
					<section className="flex min-w-0 flex-1 flex-col" aria-label="聊天">
						<ChatHeader
							sessionId={sessionId}
							sessionTitle={currentSession?.title ?? ""}
							pending={pending}
							onOpenGoal={() => setGoalDialogOpen(true)}
							goalActive={goal?.status === "active"}
							leftCollapsed={!leftOpen}
							rightCollapsed={!rightOpen}
							onToggleLeft={toggleLeft}
							onToggleRight={toggleRight}
						/>
						<MessageList
							messages={messages}
							pending={pending}
							elapsed={elapsed}
							loading={loading}
							loadError={loadError}
							onRetry={handleRetry}
							plan={plan}
							files={files}
							onOpenFile={handleOpenFileFromChat}
							onBranch={handleBranch}
							onOpenKbRef={handleOpenKbRef}
							onStartPrompt={setStarterDraft}
						/>
						{goal && <GoalBar goal={goal} onStop={() => void handleStopGoal()} onNew={() => setGoalDialogOpen(true)} />}
						<ApprovalBar approvals={approvals} busy={approvalBusy || pending} onDecide={handleDecideApproval} />
						{askQuestions.slice(0, 1).map((q) => (
							<AskUserCard key={q.id} question={q} busy={askBusy || pending} onSubmit={handleAnswerQuestion} />
						))}
						<Composer
							pending={pending}
							onSend={handleSend}
							onStop={handleStop}
							onInterject={handleInterject}
							skills={skills}
							prompts={prompts}
							sessionId={sessionId}
							models={models}
							model={model}
							onModelChange={handleModelChange}
							thinkingLevel={thinkingLevel}
							onThinkingLevelChange={handleChangeThinkingLevel}
							contextTick={contextTick}
							draft={starterDraft}
						/>
					</section>
				)}

				{showWorkbench && isDesktop && (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="调整工作台宽度"
						onPointerDown={handleRightResizeStart}
						className="w-1 shrink-0 cursor-col-resize bg-slate-800/40 transition-colors hover:bg-sky-500/50"
					/>
				)}
				{showWorkbench && (
					<div
						className={
							isDesktop
								? workbenchWide
									? "min-w-0 flex-1 border-l border-slate-800"
									: "shrink-0 border-l border-slate-800"
								: "min-w-0 flex-1"
						}
						style={isDesktop && !workbenchWide ? { width: rightWidth } : undefined}
					>
						<Workbench
							sessionId={sessionId}
							files={files}
							filesForSession={filesForSession}
							filesLoading={filesState === "loading" || bootstrapPending}
							filesError={filesError}
							wide={workbenchWide}
							onToggleWide={() => setWorkbenchWide((v) => !v)}
							onFileOpenChange={handleFileOpenChange}
							refreshTick={panelTick}
							onDeleteFile={handleDeleteFile}
							openRequest={fileRequest}
							onCollapse={toggleRight}
						/>
					</div>
				)}
			</div>

			{/* 目标弹窗（v0.31.0） */}
			<GoalDialog open={goalDialogOpen} onClose={() => setGoalDialogOpen(false)} onSubmit={handleCreateGoal} />

			{/* 设置弹窗（v0.20.0）：顶栏菜单收纳于此 */}
			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				theme={theme}
				onThemeChange={handleThemeChange}
				leftOpen={leftOpen}
				rightOpen={rightOpen}
				onToggleLeft={toggleLeft}
				onToggleRight={toggleRight}
				onExport={handleExport}
				onShare={handleShare}
				onBackup={handleBackup}
				onRestore={handleRestore}
				webSearch={webSearch}
				onToggleWebSearch={handleToggleWebSearch}
				kbPrefetch={kbPrefetch}
				onToggleKbPrefetch={handleToggleKbPrefetch}
				kbRetrieval={kbRetrieval}
				onChangeKbRetrieval={handleChangeKbRetrieval}
				thinkingLevel={thinkingLevel}
				onChangeThinkingLevel={handleChangeThinkingLevel}
				displayName={displayName}
				onSaveDisplayName={handleSaveDisplayName}
				shareTtlSeconds={shareTtlSeconds}
				onChangeShareTtl={handleChangeShareTtl}
				compaction={compaction}
				onChangeCompaction={handleChangeCompaction}
				sessionId={sessionId}
				approval={approvalSettings}
				onChangeApproval={handleChangeApproval}
				onChangeApprovalTool={handleChangeApprovalTool}
				memories={memories}
				memoriesLoading={memoriesState === "loading" || bootstrapPending}
				memoriesError={memoriesError}
				onDeleteMemory={handleDeleteMemory}
				onClearMemories={handleClearMemories}
				onModelsChanged={() => setModelsTick((t) => t + 1)}
				authRequired={!!auth?.required}
				onLogout={handleLogout}
			/>

			{/* Mobile drawer: the session sidebar slides over the chat */}
			{!isDesktop && drawerOpen && (
				<div className="absolute inset-0 z-30 md:hidden">
					<button
						type="button"
						aria-label="关闭会话列表"
						onClick={() => setDrawerOpen(false)}
						className="absolute inset-0 bg-black/60"
					/>
					<div className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] border-r border-slate-800 bg-slate-900 shadow-xl">
						{rail}
						<div className="min-w-0 flex-1">{leftContent}</div>
					</div>
				</div>
			)}

			{/* Mobile bottom tab bar: chat / files / memories */}
			{!isDesktop && (
				<nav
					aria-label="底部导航"
					className="z-20 grid shrink-0 grid-cols-3 border-t border-slate-800 bg-slate-900/95 pb-[env(safe-area-inset-bottom)]"
				>
					{(
						[
							{ key: "chat", label: "聊天", icon: "chat" },
							{ key: "files", label: "文件", icon: "file" },
						] as const
					).map(({ key, label, icon }) => (
						<button
							key={key}
							type="button"
							onClick={() => setMobileTab(key)}
							aria-current={mobileTab === key ? "page" : undefined}
							className={`flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
								mobileTab === key ? "text-sky-300" : "text-slate-400 hover:text-slate-200"
							}`}
						>
							<span aria-hidden className="leading-none">
								<Icon name={icon} className="h-5 w-5" />
							</span>
							{label}
						</button>
					))}
					<button
						type="button"
						onClick={() => setSettingsOpen(true)}
						className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-slate-400 transition-colors hover:text-slate-200"
					>
						<span aria-hidden className="leading-none">
							<Icon name="settings" className="h-5 w-5" />
						</span>
						设置
					</button>
				</nav>
			)}
		</div>
	);
}

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
import { api } from "./lib/api";
import { parseEntries, truncateOneLine } from "./lib/entries";
import { parseAutomations, parseFiles, parseMemories, parseSessions, parseSkills } from "./lib/collections";
import { loadBoolOrNull, saveBool } from "./lib/localStore";
import { useMediaQuery } from "./lib/useMediaQuery";
import type { AutomationInfo, ChatMessage, FileInfo, McpServerInfo, MemoryInfo, SessionListItem, SkillInfo, ToolCallInfo } from "./types";

const TOOL_SUMMARY_MAX = 60;
const DESKTOP_QUERY = "(min-width: 768px)";
const LEFT_OPEN_KEY = "pi-harness.left-open";
const RIGHT_OPEN_KEY = "pi-harness.right-open";
type PanelState = "loading" | "ready" | "error";
type MobileTab = "chat" | "files";

/** Tolerantly extract the tool list from a /api/chat response. */
function toToolInfos(raw: unknown): ToolCallInfo[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
		.map((item) => {
			const full = typeof item.summary === "string" ? item.summary : "";
			return {
				name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "工具",
				summary: truncateOneLine(full, TOOL_SUMMARY_MAX),
				full,
			};
		});
}

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
	// 右栏宽度（v0.16.0）：可拖拽分隔条、打开文档时自动加宽、可最大化阅读
	const [rightWidth, setRightWidth] = useState(() => {
		const saved = typeof window === "undefined" ? null : Number(localStorage.getItem("pi-right-width") ?? "");
		return Number.isFinite(saved) && saved && saved >= 260 ? saved : 340;
	});
	const [workbenchWide, setWorkbenchWide] = useState(false);
	const rightWidthRef = useRef(rightWidth);
	rightWidthRef.current = rightWidth;

	// Session list
	const [sessionId, setSessionId] = useState("1");
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [light, setLight] = useState(() => {
		try {
			return document.documentElement.classList.contains("theme-light");
		} catch {
			return false;
		}
	});
	const [auth, setAuth] = useState<{ required: boolean; authenticated: boolean } | null>(null);
	const [loginError, setLoginError] = useState<string | null>(null);
	const [models, setModels] = useState<string[]>([]);
	const [model, setModel] = useState("deepseek-flash");
	// 网页搜索开关（v0.20.0）：null 表示尚未读到后端设置
	const [webSearch, setWebSearch] = useState<boolean | null>(null);
	const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
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
	const [filesState, setFilesState] = useState<PanelState>("loading");
	const [filesError, setFilesError] = useState<string | null>(null);
	const [memories, setMemories] = useState<MemoryInfo[]>([]);
	const [memoriesState, setMemoriesState] = useState<PanelState>("loading");
	const [memoriesError, setMemoriesError] = useState<string | null>(null);
	const [panelTick, setPanelTick] = useState(0);

	// Chat state
	const [messages, setMessages] = useState<ChatMessage[]>([]);
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

	// While waiting for a reply, tick the elapsed counter every second
	useEffect(() => {
		if (!pending) return;
		const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
		return () => window.clearInterval(timer);
	}, [pending]);

	// Initial load per session: session status + history transcript in parallel;
	// every setState lives in an async continuation guarded by an alive flag
	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const [session, entries] = await Promise.all([api.session(), api.entries(sessionId)]);
				if (!alive) return;
				setOnline(session.ok !== false);
				setSessionName(typeof session.name === "string" ? session.name : "");
				// 后端直接返回数组；兼容旧格式 { entries: [...] }
				const list = Array.isArray(entries) ? entries : (entries as { entries?: unknown[] } | null)?.entries;
				setMessages(parseEntries(list));
				setLoadError(null);
			} catch (err) {
				if (!alive) return;
				setOnline(false);
				setLoadError(err instanceof Error ? err.message : String(err));
			} finally {
				if (alive) setLoading(false);
			}
		};
		void load();
		return () => {
			alive = false;
		};
	}, [reloadKey, sessionId]);

	// Session list (v3: all sessions; v1: only the current one — parseSessions tolerates both).
	// If the endpoint is unavailable, fall back to a synthetic current session so the list keeps its structure.
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.sessions();
				if (!alive) return;
				setSessions(parseSessions(data.sessions));
			} catch {
				if (!alive) return;
				setSessions((prev) => (prev.length > 0 ? prev : [{ id: sessionId, title: "当前会话", createdAt: "" }]));
			} finally {
				if (alive) setSessionsLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [reloadKey, sessionId, panelTick]);

	// Workbench data: files (per session) + memories (global). Refreshed by panelTick after each chat round.
	useEffect(() => {
		let alive = true;
		setFilesState("loading");
		setMemoriesState("loading");
		void (async () => {
			const [filesRes, memoriesRes] = await Promise.allSettled([api.files(sessionId), api.memories()]);
			if (!alive) return;
			if (filesRes.status === "fulfilled") {
				setFiles(parseFiles(filesRes.value.files));
				setFilesError(null);
				setFilesState("ready");
			} else {
				const detail = filesRes.reason instanceof Error ? filesRes.reason.message : String(filesRes.reason);
				setFilesError(detail);
				setFilesState("error");
			}
			if (memoriesRes.status === "fulfilled") {
				setMemories(parseMemories(memoriesRes.value.memories));
				setMemoriesError(null);
				setMemoriesState("ready");
			} else {
				const detail = memoriesRes.reason instanceof Error ? memoriesRes.reason.message : String(memoriesRes.reason);
				setMemoriesError(detail);
				setMemoriesState("error");
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, panelTick]);

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
				const bubbleId = nextId();
				let bubbleShown = false;
				let buffered = "";
				const toolNames: { name: string; summary: string }[] = [];
				const ensureBubble = () => {
					if (bubbleShown) return;
					bubbleShown = true;
					setMessages((prev) => [...prev, { id: bubbleId, role: "assistant", text: "", tools: [] }]);
				};
				const syncBubble = () => {
					setMessages((prev) =>
						prev.map((m) =>
							m.id === bubbleId
								? { ...m, text: buffered || " ", tools: toolNames.length ? toToolInfos(toolNames) : [] }
								: m,
						),
					);
				};
				try {
					await api.streamChat(
						text,
						sessionId,
						images,
						(event) => {
							if (generationRef.current !== generation) return;
							if (event.type === "text") {
								buffered += typeof event.delta === "string" ? event.delta : "";
								ensureBubble();
								syncBubble();
							} else if (event.type === "tool_start") {
								toolNames.push({ name: typeof event.name === "string" ? event.name : "tool", summary: "执行中…" });
								ensureBubble();
								syncBubble();
							} else if (event.type === "done") {
								const answer = typeof event.answer === "string" ? event.answer : "";
								const tools = Array.isArray(event.tools) ? (event.tools as { name: string; summary: string }[]) : toolNames;
								if (!bubbleShown) {
									ensureBubble();
								}
								setMessages((prev) => {
									const next = prev.map((m) =>
										m.id === bubbleId ? { ...m, text: answer || "（空回复）", tools: toToolInfos(tools) } : m,
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
				if (alive) setAuth({ required: !!data.required, authenticated: !!data.authenticated });
			} catch {
				if (alive) setAuth({ required: false, authenticated: true });
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
			setAuth({ required: true, authenticated: true });
		} catch {
			setLoginError("密码不正确");
		}
	}, []);

	// 可用模型（一次）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.models();
				if (!alive) return;
				const list = Array.isArray(data.models) ? data.models : [];
				setModels(list);
				if (data.default) setModel(data.default);
			} catch {
				// 保持默认
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	// 网页搜索开关（一次；后端无该接口时保持默认开启）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.settings();
				if (alive) setWebSearch(data.webSearch !== false);
			} catch {
				if (alive) setWebSearch(true);
			}
		})();
		return () => {
			alive = false;
		};
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

	// 技能列表（全局，随 panelTick 刷新）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.skills();
				if (alive) {
					setSkills(parseSkills(data.skills));
					setSkillsError(null);
				}
			} catch {
				if (alive) setSkillsError("加载技能失败。");
			} finally {
				if (alive) setSkillsLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [panelTick]);

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

	const handleDeleteSkill = useCallback(async (name: string) => {
		try {
			await api.deleteSkill(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	// 定时任务列表（全局，随 panelTick 刷新）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.automations();
				if (alive) {
					setAutomations(parseAutomations(data.automations));
					setAutomationsError(null);
				}
			} catch {
				if (alive) setAutomationsError("加载定时任务失败。");
			} finally {
				if (alive) setAutomationsLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [panelTick]);

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

	// MCP 服务器列表（全局，随 panelTick 刷新）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.mcpServers();
				if (!alive) return;
				const list = Array.isArray(data.servers) ? (data.servers as McpServerInfo[]) : [];
				setMcpServers(list);
				setMcpError(null);
			} catch {
				if (alive) setMcpError("加载 MCP 服务器失败。");
			} finally {
				if (alive) setMcpLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [panelTick]);

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

	/** 主题切换：浅色/深色，写入 localStorage 供首屏脚本使用。 */
	const handleToggleTheme = useCallback(() => {
		setLight((prev) => {
			const next = !prev;
			try {
				document.documentElement.classList.toggle("theme-light", next);
				localStorage.setItem("pi-theme", next ? "light" : "dark");
				const scheme = document.querySelector('meta[name="color-scheme"]');
				if (scheme) scheme.setAttribute("content", next ? "light" : "dark");
				const themeColor = document.querySelector('meta[name="theme-color"]');
				if (themeColor) themeColor.setAttribute("content", next ? "#f8fafc" : "#020617");
			} catch {
				// 无 localStorage 时仅本次会话生效
			}
			return next;
		});
	}, []);

	/** 拖拽分隔条调整右栏宽度（限制在 260px ~ 视口 65%）。 */
	const handleRightResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = rightWidth;
		const onMove = (e: PointerEvent) => {
			const next = Math.min(Math.max(260, startWidth - (e.clientX - startX)), Math.round(window.innerWidth * 0.65));
			setRightWidth(next);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			try {
				localStorage.setItem("pi-right-width", String(rightWidthRef.current));
			} catch {
				// 忽略存储失败
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [rightWidth]);

	/** 打开文件时自动加宽，保证文档可读（v0.16.0）。 */
	const handleFileOpenChange = useCallback((open: boolean) => {
		if (!open) return;
		setRightWidth((w) => (w < 560 ? 560 : w));
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
				const data = await api.share(sessionId);
				if (!data.url) throw new Error("no url");
				const absolute = `${window.location.origin}${data.url}`;
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
		return <LoginGate onSubmit={handleLogin} error={loginError} />;
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
		/>
	);

	const leftContent =
		railView === "sessions" ? (
			sidebar
		) : railView === "mcp" ? (
			<McpPanel servers={mcpServers} loading={mcpLoading} error={mcpError} onAdd={handleAddMcp} onDelete={handleDeleteMcp} />
		) : railView === "automations" ? (
			<AutomationPanel
				items={automations}
				loading={automationsLoading}
				error={automationsError}
				onAdd={handleAddAutomation}
				onToggle={handleToggleAutomation}
				onDelete={handleDeleteAutomation}
			/>
		) : (
			<SkillPanel
				items={skills}
				loading={skillsLoading}
				error={skillsError}
				onAdd={handleAddSkill}
				onDelete={handleDeleteSkill}
				onImport={handleImportSkill}
			/>
		);

	const rail = (
		<Rail
			view={railView}
			onViewChange={setRailView}
			onNewSession={handleNewSession}
			newSessionDisabled={resetting}
			onOpenSettings={() => setSettingsOpen(true)}
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
					<div className={`min-w-0 shrink-0 border-r border-slate-800 ${railView === "sessions" ? "w-60" : "w-80"}`}>
						{leftContent}
					</div>
				)}

				{showChat && (
					<section className="flex min-w-0 flex-1 flex-col" aria-label="聊天">
						<ChatHeader
							sessionId={sessionId}
							sessionTitle={currentSession?.title ?? ""}
							pending={pending}
							models={models}
							model={model}
							onModelChange={handleModelChange}
						/>
						<MessageList
							messages={messages}
							pending={pending}
							elapsed={elapsed}
							loading={loading}
							loadError={loadError}
							onRetry={handleRetry}
						/>
						<Composer pending={pending} onSend={handleSend} onStop={handleStop} />
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
							filesLoading={filesState === "loading"}
							filesError={filesError}
							wide={workbenchWide}
							onToggleWide={() => setWorkbenchWide((v) => !v)}
							onFileOpenChange={handleFileOpenChange}
							refreshTick={panelTick}
							onDeleteFile={handleDeleteFile}
						/>
					</div>
				)}
			</div>

			{/* 设置弹窗（v0.20.0）：顶栏菜单收纳于此 */}
			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				light={light}
				onToggleTheme={handleToggleTheme}
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
				memories={memories}
				memoriesLoading={memoriesState === "loading"}
				memoriesError={memoriesError}
				onDeleteMemory={handleDeleteMemory}
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
							{ key: "chat", label: "聊天", icon: "💬" },
							{ key: "files", label: "文件", icon: "📄" },
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
							<span aria-hidden className="text-base leading-none">
								{icon}
							</span>
							{label}
						</button>
					))}
					<button
						type="button"
						onClick={() => setSettingsOpen(true)}
						className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-slate-400 transition-colors hover:text-slate-200"
					>
						<span aria-hidden className="text-base leading-none">
							⚙️
						</span>
						设置
					</button>
				</nav>
			)}
		</div>
	);
}

/** 访问密码登录闸门（v0.10.0）。 */
function LoginGate({ onSubmit, error }: { onSubmit: (password: string) => Promise<void>; error: string | null }) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex h-dvh items-center justify-center bg-slate-950 px-4">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (!password.trim() || busy) return;
					setBusy(true);
					void onSubmit(password.trim()).finally(() => setBusy(false));
				}}
				className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-7 shadow-xl"
			>
				<h1 className="mb-1 text-lg font-semibold text-slate-100">π Harness</h1>
				<p className="mb-5 text-sm text-slate-400">请输入访问密码</p>
				{error && <p className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
				<input
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					placeholder="访问密码"
					aria-label="访问密码"
					autoFocus
					className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500"
				/>
				<button
					type="submit"
					disabled={busy || !password.trim()}
					className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
				>
					{busy ? "验证中…" : "进入"}
				</button>
			</form>
		</div>
	);
}

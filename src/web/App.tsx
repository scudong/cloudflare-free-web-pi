import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import type { WorkbenchTab } from "./components/Workbench";
import { api } from "./lib/api";
import { parseEntries, truncateOneLine } from "./lib/entries";
import { parseAutomations, parseFiles, parseMemories, parseSessions } from "./lib/collections";
import { loadBool, saveBool } from "./lib/localStore";
import { useMediaQuery } from "./lib/useMediaQuery";
import type { AutomationInfo, ChatMessage, FileInfo, McpServerInfo, MemoryInfo, SessionListItem, ToolCallInfo } from "./types";

const TOOL_SUMMARY_MAX = 60;
const DESKTOP_QUERY = "(min-width: 768px)";
const LEFT_OPEN_KEY = "pi-harness.left-open";
const RIGHT_OPEN_KEY = "pi-harness.right-open";
type PanelState = "loading" | "ready" | "error";
type MobileTab = "chat" | "files" | "memories";

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
	const [leftOpen, setLeftOpen] = useState(() => loadBool(LEFT_OPEN_KEY, true));
	const [rightOpen, setRightOpen] = useState(() => loadBool(RIGHT_OPEN_KEY, true));
	const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("files");

	// Session list
	const [sessionId, setSessionId] = useState("1");
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [models, setModels] = useState<string[]>([]);
	const [model, setModel] = useState("deepseek-flash");
	const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
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
				setMessages(parseEntries(entries.entries));
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
		(text: string) => {
			if (pending) return;
			const generation = generationRef.current;
			const controller = new AbortController();
			abortRef.current = controller;

			setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
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

	/** 停止：only abort the wait; the in-flight request's catch/finally does the cleanup. */
	const handleStop = useCallback(() => {
		abortRef.current?.abort();
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

	const handleAddMcp = useCallback(async (name: string, url: string) => {
		try {
			await api.addMcp(name, url);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			setMcpError("添加失败，请检查地址。");
			return false;
		}
	}, []);

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

	/** Sidebar 记忆库 entry: reveal the workbench on the memories tab. */
	const handleOpenMemories = useCallback(() => {
		setDrawerOpen(false);
		setWorkbenchTab("memories");
		if (isDesktop) {
			setRightOpen(true);
			saveBool(RIGHT_OPEN_KEY, true);
		} else {
			setMobileTab("memories");
		}
	}, [isDesktop]);

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

	const currentSession = sessions.find((s) => s.id === sessionId);
	const sessionLabel = sessionName || (currentSession ? currentSession.title : "");
	const showSidebar = isDesktop && leftOpen;
	const showChat = isDesktop || mobileTab === "chat";
	const showWorkbench = isDesktop ? rightOpen : mobileTab !== "chat";

	const sidebar = (
		<Sidebar
			sessions={sessions}
			currentId={sessionId}
			query={sessionQuery}
			sessionsLoading={sessionsLoading}
			memoryCount={memories.length}
			onQueryChange={setSessionQuery}
			onSelect={handleSelectSession}
			onNewSession={handleNewSession}
			onRename={handleRenameSession}
			onDelete={handleDeleteSession}
			onOpenMemories={handleOpenMemories}
		/>
	);

	return (
		<div className="relative flex h-dvh flex-col bg-slate-950 text-slate-100">
			<TopBar
				online={online}
				sessionLabel={sessionLabel}
				leftOpen={leftOpen}
				rightOpen={rightOpen}
				onToggleLeft={toggleLeft}
				onToggleRight={toggleRight}
				onOpenDrawer={() => setDrawerOpen(true)}
				onExport={handleExport}
			/>

			<div className="flex min-h-0 flex-1">
				{showSidebar && <div className="w-60 shrink-0 border-r border-slate-800">{sidebar}</div>}

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

				{showWorkbench && (
					<div className={isDesktop ? "w-80 shrink-0 border-l border-slate-800" : "min-w-0 flex-1"}>
						<Workbench
							tab={workbenchTab}
							onTabChange={setWorkbenchTab}
							sessionId={sessionId}
							files={files}
							filesLoading={filesState === "loading"}
							filesError={filesError}
							memories={memories}
							memoriesLoading={memoriesState === "loading"}
							memoriesError={memoriesError}
							refreshTick={panelTick}
							onDeleteFile={handleDeleteFile}
							onDeleteMemory={handleDeleteMemory}
							mcpServers={mcpServers}
							mcpLoading={mcpLoading}
							mcpError={mcpError}
							onAddMcp={handleAddMcp}
							onDeleteMcp={handleDeleteMcp}
							automations={automations}
							automationsLoading={automationsLoading}
							automationsError={automationsError}
							onAddAutomation={handleAddAutomation}
							onToggleAutomation={handleToggleAutomation}
							onDeleteAutomation={handleDeleteAutomation}
						/>
					</div>
				)}
			</div>

			{/* Mobile drawer: the session sidebar slides over the chat */}
			{!isDesktop && drawerOpen && (
				<div className="absolute inset-0 z-30 md:hidden">
					<button
						type="button"
						aria-label="关闭会话列表"
						onClick={() => setDrawerOpen(false)}
						className="absolute inset-0 bg-black/60"
					/>
					<div className="absolute inset-y-0 left-0 w-60 border-r border-slate-800 bg-slate-900 shadow-xl">{sidebar}</div>
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
							{ key: "chat", label: "聊天" },
							{ key: "files", label: "文件" },
							{ key: "memories", label: "记忆" },
						] as const
					).map(({ key, label }) => (
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
								{key === "chat" ? "💬" : key === "files" ? "📄" : "🧠"}
							</span>
							{label}
							{key === "files" && files.length > 0 && (
								<span className="sr-only">{`${files.length} 个文件`}</span>
							)}
						</button>
					))}
				</nav>
			)}
		</div>
	);
}

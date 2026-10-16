import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { api } from "./lib/api";
import { parseEntries, truncateOneLine } from "./lib/entries";
import type { ChatMessage, ToolCallInfo } from "./types";

const TOOL_SUMMARY_MAX = 60;

/** 从 /api/chat 响应宽容提取工具调用列表。 */
function toToolInfos(raw: unknown): ToolCallInfo[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
		.map((item) => ({
			name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "工具",
			summary: truncateOneLine(typeof item.summary === "string" ? item.summary : "", TOOL_SUMMARY_MAX),
		}));
}

export default function App() {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [pending, setPending] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const [online, setOnline] = useState(true);
	const [sessionName, setSessionName] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	/** 进行中的 /api/chat 请求，供「停止」按钮中止。 */
	const abortRef = useRef<AbortController | null>(null);
	/** 会话代数：新会话（reset）后 +1，使在途请求的回包作废。 */
	const generationRef = useRef(0);
	const idRef = useRef(0);
	const nextId = useCallback(() => `m${++idRef.current}-${Date.now().toString(36)}`, []);

	// 等待回复时每秒更新已等待秒数（setState 位于定时器回调，非 effect 同步体）
	useEffect(() => {
		if (!pending) return;
		const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
		return () => window.clearInterval(timer);
	}, [pending]);

	// 首次加载：并行拉取会话状态与历史转录；全部 setState 都在 await 之后的异步续体里，用 alive 标志防卸载后写入
	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const [session, entries] = await Promise.all([api.session(), api.entries()]);
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
	}, [reloadKey]);

	/** 发送一条消息（事件处理器，非 effect）。 */
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
				try {
					const result = await api.chat(text, controller.signal);
					if (generationRef.current !== generation || controller.signal.aborted) return;
					const tools = toToolInfos(result.tools);
					const answer = typeof result.answer === "string" ? result.answer : "";
					if (result.error) {
						setMessages((prev) => [
							...prev,
							{ id: nextId(), role: "assistant", text: `出错了：${result.error}`, tools, error: true },
						]);
					} else {
						setMessages((prev) => [
							...prev,
							{ id: nextId(), role: "assistant", text: answer || "（空回复）", tools },
						]);
					}
				} catch (err) {
					if (generationRef.current !== generation) return; // 已被「新会话」重置
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
					}
				}
			})();
		},
		[pending, nextId],
	);

	/** 「停止」：只中止等待，状态收尾交给在途请求的 catch/finally。 */
	const handleStop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	/** 「新会话」：中止在途等待 → POST /api/reset → 清空界面。 */
	const handleReset = useCallback(() => {
		if (resetting) return;
		abortRef.current?.abort();
		generationRef.current += 1;
		setResetting(true);

		void (async () => {
			let ok = true;
			try {
				await api.reset();
			} catch {
				ok = false;
			}
			setMessages([]);
			setPending(false);
			setElapsed(0);
			setResetting(false);
			if (!ok) {
				setMessages([{ id: nextId(), role: "notice", text: "重置请求失败，已清空本地界面。" }]);
			}
		})();
	}, [resetting, nextId]);

	const handleRetry = useCallback(() => {
		setLoading(true);
		setLoadError(null);
		setReloadKey((key) => key + 1);
	}, []);

	return (
		<div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
			<TopBar online={online} sessionName={sessionName} resetting={resetting} onReset={handleReset} />
			<MessageList
				messages={messages}
				pending={pending}
				elapsed={elapsed}
				loading={loading}
				loadError={loadError}
				onRetry={handleRetry}
			/>
			<Composer pending={pending} onSend={handleSend} onStop={handleStop} />
		</div>
	);
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../lib/api";
import {
	INGEST_ACCEPT,
	INGEST_FORMAT_HINT,
	LOCAL_TEXT_FALLBACK_CHARS,
	checkIngestFile,
	checkIngestUrl,
	ingestErrorMessage,
	isTextKind,
	titleFromFileName,
	titleFromUrl,
	type IngestSuccess,
} from "../lib/ingest";
import { Icon } from "./Icon";

/**
 * 知识库导入（v0.54.3）：文件（PDF / MD / TXT / DOCX，拖拽或点选）与网页链接。
 *
 * 状态机：idle → selecting → uploading → parsing → success | error。
 * 本地能判断的错误（格式 / 25MB / 空文件 / 链接格式）在发请求前就给出文案；
 * 服务端错误按 code 映射，接口未上线时 Markdown / TXT 退回现有的 POST /api/kb。
 */

type Phase = "idle" | "selecting" | "uploading" | "parsing" | "success" | "error";

/** 面板级拖拽转发进来的一次投放；对象引用变化 = 一次新的投放。 */
export interface IncomingDrop {
	file: File;
}

interface KbImportProps {
	onImported: (info: { title: string; chunks: number }) => void;
	/** 面板级拖拽悬停中：高亮投放区。 */
	dropActive?: boolean;
	incoming?: IncomingDrop | null;
	onIncomingConsumed?: () => void;
}

interface SuccessInfo {
	title: string;
	chunks: number;
	chars: number;
	note?: string;
}

const inputClass =
	"w-full min-w-0 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-60";

export function KbImport({ onImported, dropActive = false, incoming, onIncomingConsumed }: KbImportProps) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [progress, setProgress] = useState(0);
	const [label, setLabel] = useState("");
	const [success, setSuccess] = useState<SuccessInfo | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [link, setLink] = useState("");

	const inputRef = useRef<HTMLInputElement | null>(null);
	/** 同步互斥：setState 是异步的，连点 / 连续拖拽靠它挡住第二次提交。 */
	const busyRef = useRef(false);
	const phaseRef = useRef<Phase>("idle");
	const focusHandlerRef = useRef<(() => void) | null>(null);
	const cancelTimerRef = useRef<number | null>(null);

	const moveTo = useCallback((next: Phase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);

	useEffect(
		() => () => {
			if (focusHandlerRef.current) window.removeEventListener("focus", focusHandlerRef.current);
			if (cancelTimerRef.current) window.clearTimeout(cancelTimerRef.current);
		},
		[],
	);

	const succeed = useCallback(
		(result: IngestSuccess, fallbackTitle: string, note?: string) => {
			const info = {
				title: result.title || fallbackTitle,
				chunks: result.chunks,
				chars: result.chars,
				...(note ? { note } : {}),
			};
			setSuccess(info);
			setFailure(null);
			setProgress(0);
			moveTo("success");
			onImported({ title: info.title, chunks: info.chunks });
		},
		[moveTo, onImported],
	);

	const fail = useCallback(
		(message: string, sourceLabel?: string) => {
			if (sourceLabel !== undefined) setLabel(sourceLabel);
			setFailure(message || ingestErrorMessage("unknown"));
			setSuccess(null);
			setProgress(0);
			moveTo("error");
		},
		[moveTo],
	);

	const importFile = useCallback(
		async (file: File) => {
			if (busyRef.current) return;
			setSuccess(null);
			setFailure(null);
			setProgress(0);
			setLabel(file.name);

			// 格式 / 体积 / 空文件：本地判掉，绝不发请求。
			const check = checkIngestFile(file);
			if (!check.ok) {
				setFailure(check.message);
				moveTo("error");
				return;
			}

			busyRef.current = true;
			moveTo("uploading");
			try {
				const result = await api.kbIngestFile(file, {
					onProgress: (percent) => setProgress(percent),
					onUploaded: () => {
						if (phaseRef.current === "uploading") moveTo("parsing");
					},
				});
				if (result.ok) {
					succeed(result, titleFromFileName(file.name));
					return;
				}
				// 接口未上线时，纯文本还能走既有的 POST /api/kb；PDF / DOCX 只能如实告知。
				if (result.unavailable && isTextKind(check.kind)) {
					moveTo("parsing");
					const text = await file.text();
					if (!text.trim()) {
						fail(ingestErrorMessage("empty_content"), file.name);
						return;
					}
					const content = text.slice(0, LOCAL_TEXT_FALLBACK_CHARS);
					const added = await api.kbAdd(titleFromFileName(file.name), content, file.name, "");
					if (!added.id) {
						fail(added.error || "本地文本通道入库失败。", file.name);
						return;
					}
					const truncated = text.length > LOCAL_TEXT_FALLBACK_CHARS;
					succeed(
						{
							ok: true,
							docId: String(added.id),
							title: titleFromFileName(file.name),
							chunks: added.chunks ?? 0,
							chars: content.length,
						},
						file.name,
						`导入接口未上线，已用本地文本通道入库${truncated ? `（超出 ${LOCAL_TEXT_FALLBACK_CHARS} 字的部分未导入）` : ""}。`,
					);
					return;
				}
				fail(result.message, file.name);
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err), file.name);
			} finally {
				busyRef.current = false;
			}
		},
		[fail, moveTo, succeed],
	);

	const importLink = useCallback(async () => {
		if (busyRef.current) return;
		setSuccess(null);
		setFailure(null);
		const check = checkIngestUrl(link);
		if (!check.ok) {
			setLabel(link.trim());
			setFailure(check.message);
			moveTo("error");
			return;
		}
		setLabel(check.url);
		setProgress(0);
		busyRef.current = true;
		moveTo("parsing");
		try {
			const result = await api.kbIngestUrl(check.url);
			if (result.ok) {
				succeed(result, titleFromUrl(check.url));
				setLink("");
				return;
			}
			fail(
				result.code === "unavailable"
					? "链接导入需要后端接口 /api/kb/ingest，该接口还没上线。可以先把网页正文粘贴进来。"
					: result.message,
				check.url,
			);
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err), check.url);
		} finally {
			busyRef.current = false;
		}
	}, [fail, link, moveTo, succeed]);

	// 面板任意位置拖入的文件：父组件只负责转发，导入逻辑仍在这里。
	useEffect(() => {
		if (!incoming) return;
		onIncomingConsumed?.();
		void importFile(incoming.file);
	}, [incoming, importFile, onIncomingConsumed]);

	const openPicker = useCallback(() => {
		if (busyRef.current) return;
		setSuccess(null);
		setFailure(null);
		setProgress(0);
		setLabel("");
		moveTo("selecting");
		const input = inputRef.current;
		if (!input) {
			moveTo("idle");
			return;
		}
		// 关闭文件选择框（取消）时窗口重新获得焦点；选中文件时 change 会先改走状态。
		const onFocus = () => {
			focusHandlerRef.current = null;
			if (cancelTimerRef.current) window.clearTimeout(cancelTimerRef.current);
			cancelTimerRef.current = window.setTimeout(() => {
				if (phaseRef.current === "selecting") moveTo("idle");
			}, 250);
		};
		focusHandlerRef.current = onFocus;
		window.addEventListener("focus", onFocus, { once: true });
		input.click();
	}, [moveTo]);

	const onPickFile = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		// 清空 value：同一个文件失败后还能再选一次。
		event.target.value = "";
		if (file) void importFile(file);
	};

	const busy = phase === "uploading" || phase === "parsing";
	const running = phase === "selecting" || phase === "uploading" || phase === "parsing";
	const statusText =
		phase === "selecting"
			? "等待选择文件…"
			: phase === "uploading"
				? `上传中${progress > 0 ? ` ${progress}%` : ""}…`
				: phase === "parsing"
					? "解析中，正在切块并建索引…"
					: "";

	return (
		<div className="space-y-1.5">
			<div
				className={`rounded-lg border border-dashed px-2.5 py-3 text-center transition-colors ${
					dropActive ? "border-sky-400 bg-sky-500/10" : "border-slate-700 bg-slate-800/30"
				}`}
			>
				<input
					ref={inputRef}
					type="file"
					accept={INGEST_ACCEPT}
					className="hidden"
					onChange={onPickFile}
					tabIndex={-1}
					aria-hidden
				/>
				<button
					type="button"
					onClick={openPicker}
					disabled={busy}
					aria-label={`导入文件（${INGEST_FORMAT_HINT}，单个不超过 25MB）`}
					className="inline-flex items-center gap-1.5 rounded-md bg-slate-700/80 px-2.5 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Icon name={dropActive ? "download" : "upload"} className="h-3.5 w-3.5" />
					{dropActive ? "松手即可导入" : "导入文件"}
				</button>
				<p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-500">
					拖到面板任意位置，或点选文件
					<br />
					{INGEST_FORMAT_HINT} · 单个不超过 25MB
				</p>
			</div>

			<form
				className="flex gap-1.5"
				onSubmit={(event) => {
					event.preventDefault();
					void importLink();
				}}
			>
				<input
					value={link}
					onChange={(event) => setLink(event.target.value)}
					placeholder="从链接导入：粘贴网页地址"
					aria-label="从链接导入的网页地址"
					disabled={busy}
					className={inputClass}
				/>
				<button
					type="submit"
					disabled={busy || !link.trim()}
					className="shrink-0 rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
				>
					导入
				</button>
			</form>

			{phase !== "idle" && (
				<div
					role={phase === "error" ? "alert" : "status"}
					className={`rounded-md px-2 py-1.5 text-[11px] ${
						phase === "success"
							? "bg-emerald-950/40 text-emerald-300"
							: phase === "error"
								? "bg-red-950/40 text-red-300"
								: "bg-slate-800/60 text-slate-300"
					}`}
				>
					{running && (
						<div className="flex items-start gap-1.5">
							<Icon name="loader" className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sky-400" />
							<span className="min-w-0 flex-1">
								<span className="block leading-relaxed">{statusText}</span>
								{label && (
									<span className="block truncate text-[10.5px] text-slate-500" title={label}>
										{label}
									</span>
								)}
								{phase === "uploading" && (
									<span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-slate-700">
										<span
											className="block h-full rounded-full bg-sky-500 transition-[width] duration-200"
											style={{ width: `${Math.max(5, progress)}%` }}
										/>
									</span>
								)}
							</span>
						</div>
					)}
					{phase === "success" && success && (
						<div className="flex items-start gap-1.5">
							<Icon name="done" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							<span className="min-w-0 flex-1">
								<span className="block break-words leading-relaxed">已入库《{success.title}》</span>
								<span className="block text-[10.5px] text-emerald-400/80">
									{success.chunks} 个片段{success.chars > 0 ? ` · ${success.chars} 字` : ""}
								</span>
								{success.note && (
									<span className="mt-0.5 block text-[10.5px] leading-relaxed text-amber-300/90">{success.note}</span>
								)}
							</span>
						</div>
					)}
					{phase === "error" && (
						<div className="flex items-start gap-1.5">
							<Icon name="error" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							<span className="min-w-0 flex-1">
								<span className="block break-words leading-relaxed">{failure}</span>
								{label && (
									<span className="mt-0.5 block truncate text-[10.5px] text-red-300/80" title={label}>
										{label}
									</span>
								)}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

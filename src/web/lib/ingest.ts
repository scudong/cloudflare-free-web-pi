/**
 * 知识库导入（v0.54.3）：文件 / 链接 → 后端解析、切块、入库。
 *
 * 前端只做能在本地判断的校验（扩展名、25MB 上限、空文件、URL 形态），
 * 真正的格式解析与切块交给 `POST /api/kb/ingest`；服务端返回的 code 决定失败文案。
 * 纯函数集中在这里，组件只负责状态机与渲染。
 */
import { formatSize } from "./format";

/** 与需求约定一致：超过 25MB 直接拦在前端，不浪费一次上传。 */
export const MAX_INGEST_BYTES = 25 * 1024 * 1024;

/** 文件选择器 / 拖拽提示里展示的可用格式。 */
export const INGEST_ACCEPT = ".pdf,.md,.markdown,.txt,.docx";
export const INGEST_FORMAT_HINT = "PDF / MD / TXT / DOCX";

/** 导入接口未上线（404/405/501）时，纯文本可以退回既有的 `POST /api/kb`。 */
export const LOCAL_TEXT_FALLBACK_CHARS = 200_000;

export type IngestFileKind = "pdf" | "md" | "txt" | "docx";

/** 契约里的四种失败 + 传输层补充的三种（网络 / 服务端 / 接口未上线）。 */
export type IngestErrorCode =
	| "too_large"
	| "unsupported_type"
	| "empty_content"
	| "ai_unavailable"
	| "unavailable"
	| "network"
	| "server"
	| "unknown";

export interface IngestSuccess {
	ok: true;
	docId: string;
	title: string;
	chunks: number;
	chars: number;
}

export interface IngestFailure {
	ok: false;
	code: IngestErrorCode;
	message: string;
	/** 接口本身没上线：可以尝试本地文本兜底，而不是把它当成文件的问题。 */
	unavailable?: boolean;
}

export type IngestResult = IngestSuccess | IngestFailure;

/** 扩展名 → 支持的类别；大小写不敏感。 */
const EXTENSIONS: Record<string, IngestFileKind> = {
	pdf: "pdf",
	md: "md",
	markdown: "md",
	txt: "txt",
	docx: "docx",
};

/** 纯文本文件在前端就能读，接口未上线时可以走本地兜底。 */
export function isTextKind(kind: IngestFileKind): boolean {
	return kind === "md" || kind === "txt";
}

export function ingestFileKind(name: string): IngestFileKind | null {
	const base = name.trim().toLowerCase();
	const dot = base.lastIndexOf(".");
	if (dot < 0 || dot === base.length - 1) return null;
	return EXTENSIONS[base.slice(dot + 1)] ?? null;
}

/** 用于报错文案：`.zip`，没有扩展名时给空串。 */
export function ingestFileExtension(name: string): string {
	const base = name.trim();
	const dot = base.lastIndexOf(".");
	return dot > 0 && dot < base.length - 1 ? `.${base.slice(dot + 1).toLowerCase()}` : "";
}

/** 文件名去掉扩展名当标题，和「粘贴正文」时的标题语义一致。 */
export function titleFromFileName(name: string): string {
	const base = name.trim().replace(/^.*[\\/]/, "");
	const dot = base.lastIndexOf(".");
	// ".pdf" 这种只有扩展名的文件没有可用标题
	const title = (dot > 0 ? base.slice(0, dot) : base.startsWith(".") ? "" : base).trim();
	return title.slice(0, 120) || "未命名文档";
}

/** 后端没回标题时的兜底：域名 + 路径，比空白更容易认出来源。 */
export function titleFromUrl(raw: string): string {
	try {
		const url = new URL(raw);
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.hostname}${path}`.slice(0, 120) || url.hostname || "链接导入";
	} catch {
		return "链接导入";
	}
}

export interface IngestFileLike {
	name: string;
	size: number;
}

export type IngestFileCheck =
	| { ok: true; kind: IngestFileKind }
	| { ok: false; code: "too_large" | "unsupported_type" | "empty_content"; message: string };

/** 本地校验：顺序与需求一致 —— 格式 → 体积 → 空文件。失败时绝不发请求。 */
export function checkIngestFile(file: IngestFileLike): IngestFileCheck {
	const kind = ingestFileKind(file.name);
	if (!kind) {
		const ext = ingestFileExtension(file.name);
		return {
			ok: false,
			code: "unsupported_type",
			message: `不支持${ext ? ` ${ext} ` : "这个"}格式，只能导入 ${INGEST_FORMAT_HINT}。`,
		};
	}
	if (file.size > MAX_INGEST_BYTES) {
		return {
			ok: false,
			code: "too_large",
			message: `文件超过 25MB（${formatSize(file.size)}），请压缩或拆分后再导入。`,
		};
	}
	if (file.size <= 0) {
		return { ok: false, code: "empty_content", message: "这个文件是空的，没有可导入的正文。" };
	}
	return { ok: true, kind };
}

export type IngestUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/** 链接只接受 http(s)：别的协议后端也抓不到。 */
export function checkIngestUrl(input: string): IngestUrlCheck {
	const value = input.trim();
	if (!value) return { ok: false, message: "请先粘贴要导入的网页链接。" };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, message: "链接格式不对，需要以 http:// 或 https:// 开头。" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, message: "只支持 http(s) 链接。" };
	}
	return { ok: true, url: url.toString() };
}

const CONTRACT_CODES = new Set<IngestErrorCode>(["too_large", "unsupported_type", "empty_content", "ai_unavailable"]);

/** 契约 code 缺失或不认识时，退化成服务端错误，但保留后端给的人话 message。 */
function normalizeCode(raw: unknown): IngestErrorCode | null {
	if (typeof raw !== "string") return null;
	const code = raw.trim().toLowerCase() as IngestErrorCode;
	return CONTRACT_CODES.has(code) || code === "unavailable" || code === "network" || code === "server" ? code : null;
}

/** 每种失败都给一句能指导下一步的中文文案；服务端 message 优先。 */
export function ingestErrorMessage(code: IngestErrorCode, detail?: string): string {
	switch (code) {
		case "too_large":
			return `文件超过 25MB，请压缩或拆分后再导入。`;
		case "unsupported_type":
			return `不支持这种格式，只能导入 ${INGEST_FORMAT_HINT}。`;
		case "empty_content":
			return "没有解析出正文，请检查文件或链接内容后重试。";
		case "ai_unavailable":
			return "解析服务暂时不可用，请稍后重试。";
		case "unavailable":
			return "导入接口还没上线（/api/kb/ingest），PDF / DOCX 暂时无法解析。可以先导入 Markdown / TXT，或等后端合并。";
		case "network":
			return "网络请求失败，请检查网络后重试。";
		case "server":
			return detail?.trim() || "导入失败，服务返回异常，请稍后重试。";
		default:
			return detail?.trim() || "导入失败，请稍后重试。";
	}
}

export function ingestNetworkFailure(): IngestFailure {
	return { ok: false, code: "network", message: ingestErrorMessage("network") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCount(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 宽容解析 `POST /api/kb/ingest` 的响应：
 * - `{ok:true, docId, title, chunks, chars}`
 * - `{ok:false, code, message}`（HTTP 200 或 4xx 都可能）
 * - 既有的 `{error}` 风格，以及 404/405/501 的「路由不存在」
 */
export function parseIngestResponse(raw: unknown, status = 200): IngestResult {
	const unavailable = status === 404 || status === 405 || status === 501;
	if (!isRecord(raw)) {
		if (unavailable) return { ok: false, code: "unavailable", message: ingestErrorMessage("unavailable"), unavailable: true };
		if (status >= 500) return { ok: false, code: "server", message: ingestErrorMessage("server") };
		return { ok: false, code: "unknown", message: ingestErrorMessage("unknown") };
	}

	const serverMessage = typeof raw.message === "string" ? raw.message.trim() : "";

	if (raw.ok === false || (raw.ok === undefined && typeof raw.error === "string")) {
		const code = normalizeCode(raw.code) ?? (unavailable ? "unavailable" : "server");
		const fallback = typeof raw.error === "string" && raw.error.trim() ? raw.error.trim() : "";
		return {
			ok: false,
			code,
			message: serverMessage || (code === "server" ? ingestErrorMessage("server", fallback) : ingestErrorMessage(code)),
			unavailable,
		};
	}

	const docIdRaw = raw.docId ?? raw.doc_id ?? raw.id;
	const docId = typeof docIdRaw === "string" || typeof docIdRaw === "number" ? String(docIdRaw).trim() : "";
	const title = typeof raw.title === "string" ? raw.title.trim() : "";

	// 2xx 且没有明确失败标记：容忍 ok 字段缺失（后端版本可能领先/落后于契约）。
	if (status >= 200 && status < 300) {
		return { ok: true, docId, title, chunks: toCount(raw.chunks), chars: toCount(raw.chars) };
	}

	if (unavailable) return { ok: false, code: "unavailable", message: ingestErrorMessage("unavailable"), unavailable: true };
	return {
		ok: false,
		code: status >= 500 ? "server" : "unknown",
		message: serverMessage || ingestErrorMessage(status >= 500 ? "server" : "unknown"),
	};
}

import type { SqlHandle } from "../db/migrations";
import { AppError } from "../http/errors";
import { shareTokenOwner, shareTokenPrefix, type SettingsPort, type ShareRuntime } from "../http/ports";
import { entryText } from "../lib/entries";
import {
	expiredSharePage,
	isShareTheme,
	markdownToHtml,
	shareFileCard,
	sharePage,
	shareToc,
	writeFileResult,
	type ShareHeading,
	type SharePage,
	type ShareThemeId,
} from "../lib/share-render";
import { getContent } from "../repo/files-repo";
import { get as getSession } from "../repo/sessions-repo";
import {
	deleteByToken,
	getByToken,
	insert,
	latestTokenForFile,
	listAll as listAllRows,
	listUnexpired,
	purgeExpired,
	recordOpen,
	type ShareKind,
	type ShareRow,
	type ShareStatus,
} from "../repo/shares-repo";

/**
 * 分享域用例（ADR-0001 §2）：token / TTL / 主题 / 渲染编排都在这里。
 * SQL 在 repo/shares-repo.ts 与 repo/files-repo.ts，纯字符串在 lib/share-render.ts。
 * 会话条目通过 `runtime` 端口读取——文件分享、失效与过期 token 都走不到它，因此不启动 Harness。
 */

export type ShareRecord = {
	token: string;
	kind: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
};

/** `/api/shares/all` 的一行（NERE-42）：相对 `url` 由前端按当前域名拼绝对地址。 */
export type ShareSummary = {
	token: string;
	kind: ShareKind;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
	sessionId: string;
	url: string;
};

export type ShareServiceDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	/** 分享链接的绝对域名：优先本次请求 Origin，alarm 场景由调用方回落到 share_origin。 */
	origin: string;
	/** 请求身份；邀请用户的分享 token 带 `<userId>.` 前缀。 */
	userKey: string;
	/** `DEMO_SHARE_URL` 指向的 token；命中时分享页顶部加「这是只读样例」横条。 */
	demoToken?: string;
	/** 会话解析端口；只有 HTTP 端点的 create/list/render 需要。 */
	runtime?: ShareRuntime;
	now?: () => number;
};

export type CreateShareInput = {
	sessionId?: string;
	kind: ShareKind;
	name?: string;
	ttlSeconds?: number;
	theme?: string;
};

export type ToolShare = { share: ShareRecord; reused: boolean };

export interface ShareService {
	create(input: CreateShareInput): Promise<{ token: string; expiresAt: number }>;
	list(sessionId: string | undefined, kind: ShareKind, name?: string): Promise<ShareRecord[]>;
	/** 当前用户的全量分享清单（NERE-42），`status` 缺省 active。 */
	listAll(status?: string | null): ShareSummary[];
	/** 撤销当前用户自己的分享（NERE-42）：立即删行，链接随即 404；越权 403。 */
	revoke(token: string): void;
	/** 分享页（服务端渲染，只读）。html 文件原样输出，其余按 Markdown 渲染。
	 * `openerIp` 只用于去重计数，落库前哈希，原始地址不持久化。 */
	render(token: string, themeOverride?: string | null, openerIp?: string): Promise<SharePage | null>;
	/** 模型工具入口：会话 id 已知，先复用未过期链接，否则按解析后的 TTL 新建。 */
	shareForTool(kind: ShareKind, conversationId: string, name: string, ttlValue: unknown): ToolShare;
	urlFor(token: string): string;
	sessionTitle(conversationId: string): string;
}

/** `status` 只认契约里的三个值；缺省/未知一律按 active（与前端默认值一致）。 */
export function normalizeShareStatus(value: unknown): ShareStatus {
	return value === "expired" || value === "all" ? value : "active";
}

/** 分享默认有效期（秒）：0 = 永久；与分享弹窗默认的 7 天一致。 */
export const DEFAULT_SHARE_TTL = 7 * 86400;
export const MAX_SHARE_TTL = 365 * 86400;

export function shareDefaultTtl(settings: SettingsPort): number {
	const raw = Number(settings.get("share_ttl_seconds", String(DEFAULT_SHARE_TTL)));
	return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), MAX_SHARE_TTL) : DEFAULT_SHARE_TTL;
}

/** 解析分享有效期：未传（undefined/null/""）沿用设置默认；显式 0 表示永久。 */
export function shareTtlSeconds(value: unknown, settings: SettingsPort): number {
	if (value === undefined || value === null || value === "") return shareDefaultTtl(settings);
	const raw = Number(value);
	if (!Number.isFinite(raw) || raw < 0) return shareDefaultTtl(settings);
	return Math.min(raw, MAX_SHARE_TTL);
}

/** 分享页署名：设置里的 displayName，未设置时回落到产品名。 */
export function shareAuthor(settings: SettingsPort): string {
	return settings.get("display_name", "").trim().slice(0, 40) || "π Harness";
}

/** 无歧义 token：base32 字符集，避免 0/1/l/o 混淆（v0.55.0 起 12 字节）。 */
function newShareToken(tokenPrefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return `${tokenPrefix}${[...bytes].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("")}`;
}

/** 复用条件：未过期，且有效期覆盖本次请求（显式 0 = 永久）。 */
function reusableShare(rows: ShareRecord[], ttlSeconds: number, now: number): ShareRecord | undefined {
	// 显式「永久」只能复用永久的；其它 TTL 允许 10 秒误差，避免「7 天」重问时因几毫秒差新建 token
	if (ttlSeconds === 0) return rows.find((row) => row.expiresAt === 0);
	const needed = now + ttlSeconds * 1000 - 10_000;
	return rows.find((row) => row.expiresAt === 0 || row.expiresAt >= needed);
}

function toRecord(row: ShareRow): ShareRecord {
	return {
		token: row.token,
		kind: row.kind,
		name: row.name,
		expiresAt: Number(row.expiresAt ?? 0),
		theme: row.theme ?? "dark",
		createdAt: row.createdAt,
	};
}

/**
 * 打开者指纹（NERE-42）：SHA-256(token + IP)，以 token 作盐，
 * 同一 IP 在不同链接上得到不同值，库里不出现原始地址。
 */
async function openerFingerprint(token: string, ip: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}\n${ip.trim()}`));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createShareService(deps: ShareServiceDeps): ShareService {
	const { sql, settings, origin } = deps;
	const now = deps.now ?? Date.now;
	const demoToken = deps.demoToken ?? "";
	const runtime = deps.runtime;
	const tokenPrefix = shareTokenPrefix(deps.userKey);

	/** 撤销归属：带前缀的 token 必须属于当前用户；无前缀旧链接只属于主人（userKey 不是邀请用户）。 */
	function assertRevocable(token: string): void {
		const owner = shareTokenOwner(token);
		const mine = owner ? `${owner}.` === tokenPrefix : tokenPrefix === "";
		if (!mine) throw new AppError("forbidden", 403, "无权撤销该分享");
	}

	function toSummary(row: ShareRow): ShareSummary {
		return {
			token: row.token,
			kind: row.kind === "file" ? "file" : "conversation",
			name: row.name,
			expiresAt: Number(row.expiresAt ?? 0),
			theme: row.theme ?? "dark",
			createdAt: row.createdAt,
			openCount: Number(row.openCount ?? 0),
			lastOpenedAt: Number(row.lastOpenedAt ?? 0),
			sessionId: row.sessionId,
			// 契约要求相对路径：服务端可能部署在反代后，origin 不可靠。
			url: `/s/${row.token}`,
		};
	}

	function conversationRuntime(): ShareRuntime {
		if (!runtime) throw new Error("分享服务缺少会话端口");
		return runtime;
	}

	/** 生成一条分享记录。ttlSeconds 已解析：0 = 永久。 */
	function createRecord(
		conversationId: string,
		kind: ShareKind,
		name: string,
		ttlSeconds: number,
		theme: string | undefined,
	): ShareRecord {
		const fileName = name.trim();
		if (kind === "file") {
			if (!fileName) throw new Error("缺少文件名");
			if (!getContent(sql, conversationId, fileName)) throw new Error("文件不存在");
		}
		// 清掉已过期的分享，避免表无限增长
		const at = now();
		purgeExpired(sql, at);
		const expiresAt = ttlSeconds > 0 ? at + Math.min(ttlSeconds, MAX_SHARE_TTL) * 1000 : 0;
		const themeId: ShareThemeId = isShareTheme(theme) ? theme : "dark";
		const record: ShareRecord = {
			token: newShareToken(tokenPrefix),
			kind,
			name: fileName,
			expiresAt,
			theme: themeId,
			createdAt: new Date().toISOString(),
		};
		insert(sql, {
			token: record.token,
			kind,
			sessionId: conversationId,
			name: record.name,
			expiresAt,
			theme: themeId,
			createdAt: record.createdAt,
		});
		return record;
	}

	/** 未过期的分享链接（新→旧）。 */
	function unexpired(conversationId: string, kind: ShareKind, name?: string): ShareRecord[] {
		return listUnexpired(sql, conversationId, kind, (name ?? "").trim(), now()).map(toRecord);
	}

	function fileShareHref(conversationId: string, name: string): string | undefined {
		const token = latestTokenForFile(sql, conversationId, name, now());
		return token ? `/s/${token}` : undefined;
	}

	return {
		async create(input) {
			const conversationId = await conversationRuntime().conversationId(input.sessionId);
			return createRecord(
				conversationId,
				input.kind,
				input.name ?? "",
				shareTtlSeconds(input.ttlSeconds, settings),
				input.theme,
			);
		},

		async list(sessionId, kind, name) {
			const conversationId = await conversationRuntime().conversationId(sessionId);
			return unexpired(conversationId, kind, name);
		},

		listAll(status) {
			return listAllRows(sql, normalizeShareStatus(status), now()).map(toSummary);
		},

		revoke(token) {
			if (!token) throw new AppError("not_found", 404, "分享链接不存在");
			assertRevocable(token);
			if (!deleteByToken(sql, token)) throw new AppError("not_found", 404, "分享链接不存在");
		},

		shareForTool(kind, conversationId, name, ttlValue) {
			const ttl = shareTtlSeconds(ttlValue, settings);
			const explicit = ttlValue !== undefined && ttlValue !== null && ttlValue !== "";
			const rows = unexpired(conversationId, kind, name);
			// 不传 ttlSeconds（沿用设置默认）时直接复用任意未过期链接；显式要求则必须覆盖本次 TTL
			const existing = explicit ? reusableShare(rows, ttl, now()) : rows[0];
			if (existing) return { share: existing, reused: true };
			return { share: createRecord(conversationId, kind, name, ttl, undefined), reused: false };
		},

		urlFor(token) {
			return `${origin}/s/${token}`;
		},

		sessionTitle(conversationId) {
			try {
				return getSession(sql, conversationId)?.title?.trim() || "当前对话";
			} catch {
				return "当前对话";
			}
		},

		async render(token, themeOverride, openerIp = "") {
			const row = getByToken(sql, token);
			if (!row) return null;
			// ?theme= 可临时覆盖；否则用分享时记录的主题，老链接回落深色
			const theme: ShareThemeId = isShareTheme(themeOverride)
				? themeOverride
				: isShareTheme(row.theme)
					? row.theme
					: "dark";
			const expiresAt = Number(row.expiresAt ?? 0);
			if (expiresAt > 0 && expiresAt <= now()) return expiredSharePage(row.name, expiresAt, theme);
			// NERE-42：有效链接的打开才计数；同一 IP 指纹 1 小时内只计 1 次（repo 层判重）。
			recordOpen(sql, token, await openerFingerprint(token, openerIp), now());
			// 登录页「看一个真实对话」落到的那条分享：顶部加一条只读样例说明（NERE-46）。
			const demo = demoToken !== "" && demoToken === token;

			if (row.kind === "file") {
				const file = getContent(sql, row.sessionId, row.name);
				if (!file) {
					return { status: 404, contentType: "text/plain; charset=utf-8", body: "文件已删除，分享不再可用" };
				}
				// HTML 原样输出：独立页面才能带样式与脚本。CSP sandbox 让它落在不透明源，
				// 即使有人打开恶意产物，也读不到本站 cookie / Storage。
				if (/\.html?$/i.test(row.name)) {
					return {
						status: 200,
						contentType: "text/html; charset=utf-8",
						body: file.content,
						headers: { "content-security-policy": "sandbox allow-scripts" },
					};
				}
				const headings: ShareHeading[] = [];
				const usedIds = new Set<string>();
				const article = markdownToHtml(file.content, { headings, usedIds });
				return {
					status: 200,
					contentType: "text/html; charset=utf-8",
					body: sharePage(
						row.name || "文件",
						`<article class="article">${article}</article>`,
						expiresAt,
						theme,
						shareToc(headings),
						{ author: shareAuthor(settings), createdAt: row.createdAt },
						demo,
					),
				};
			}

			const sessionId = row.sessionId;
			const items = await conversationRuntime().entries(sessionId);
			const title = getSession(sql, sessionId)?.title ?? "对话";
			const parts: string[] = [];
			// 对话分享也生成目录：所有消息共用一套锚点 id（v0.41.0）
			const headings: ShareHeading[] = [];
			const usedIds = new Set<string>();
			for (const entry of [...items].reverse()) {
				const item = entry as Record<string, unknown>;
				const kind = String(item.kind ?? "");
				const text = entryText(item.model).trim();
				if (!text) continue;
				if (kind === "pi.user") {
					parts.push(`<div class="msg user"><div class="who">用户</div><div class="md">${markdownToHtml(text, { headings, usedIds })}</div></div>`);
				} else if (kind === "pi.assistant") {
					parts.push(`<div class="msg bot"><div class="who">助手</div><div class="md">${markdownToHtml(text, { headings, usedIds })}</div></div>`);
				} else if (kind === "pi.tool-result") {
					// 工作台写入在分享页里补一张文件卡（NERE-13）：有同一文件的分享链接时可直接打开。
					const blocks = Array.isArray(item.model) ? (item.model as { toolName?: unknown; isError?: unknown }[]) : [];
					const block = blocks[0];
					if (block?.toolName === "write_file" && !block.isError) {
						const file = writeFileResult(text);
						if (file) parts.push(shareFileCard(file.name, file.size, fileShareHref(sessionId, file.name)));
					}
				}
			}
			return {
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: sharePage(
					title,
					// 消息与文件卡必须包在一个容器里：main.with-toc 是两列网格，
					// 顶层节点会各自成为网格项，导致文件卡跑到目录下面。
					`<div class="thread">${parts.join("") || "<p class='empty'>（暂无内容）</p>"}</div>`,
					expiresAt,
					theme,
					shareToc(headings),
					{ author: shareAuthor(settings), createdAt: row.createdAt },
					demo,
				),
			};
		},
	};
}

import type { FileInfo, MemoryInfo, SessionListItem } from "../types";

/**
 * Tolerant parsers for panel data (sessions / files / memories).
 * The backend contract may drift between versions (v1 vs v3), so field lookup is lenient:
 * unknown shapes degrade to empty lists instead of crashing the UI.
 */

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickString(o: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
	}
	return 0;
}

function arrayOf(raw: unknown, wrapperKeys: string[]): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isObject(raw)) {
		for (const key of wrapperKeys) {
			const v = raw[key];
			if (Array.isArray(v)) return v;
		}
	}
	return [];
}

/** GET /api/sessions → list of sessions (falls back to a synthetic current one when empty). */
export function parseSessions(raw: unknown): SessionListItem[] {
	const list = arrayOf(raw, ["sessions"]).filter(isObject);
	return list.map((entry, index) => ({
		id: pickString(entry, ["id", "sessionId", "session_id"]) || String(index + 1),
		title: pickString(entry, ["title", "name", "label"]) || `会话 ${index + 1}`,
		createdAt: pickString(entry, ["created_at", "createdAt", "updated_at"]),
	}));
}

/** GET /api/files → workbench files. */
export function parseFiles(raw: unknown): FileInfo[] {
	const list = arrayOf(raw, ["files"]).filter(isObject);
	return list.map((entry) => ({
		name: pickString(entry, ["name", "filename", "file", "path"]),
		size: pickNumber(entry, ["size", "length", "bytes"]),
		updatedAt: pickString(entry, ["updated_at", "updatedAt", "created_at"]),
	}));
}

/**
 * GET /api/memories → memory library entries.
 * Entries without a usable id get a negative placeholder id (delete button hidden for those).
 */
export function parseMemories(raw: unknown): MemoryInfo[] {
	const list = arrayOf(raw, ["memories", "items"]).filter(isObject);
	return list.map((entry, index) => ({
		id: pickNumber(entry, ["id"]) || -(index + 1),
		content: pickString(entry, ["content", "text", "value"]),
		createdAt: pickString(entry, ["created_at", "createdAt", "updated_at"]),
	}));
}

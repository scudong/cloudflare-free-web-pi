import { describe, expect, it } from "vitest";
import { flattenSessions } from "../../src/web/lib/sessionTree";
import type { SessionListItem } from "../../src/web/types";

function session(id: string, parentId?: string): SessionListItem {
	return { id, title: `会话 ${id}`, createdAt: "", ...(parentId ? { parentId } : {}) };
}

describe("flattenSessions · 分支树（v0.32.0）", () => {
	it("没有分支时保持原顺序、深度都是 0", () => {
		const out = flattenSessions([session("3"), session("2"), session("1")]);
		expect(out.map((n) => n.session.id)).toEqual(["3", "2", "1"]);
		expect(out.every((n) => n.depth === 0)).toBe(true);
	});

	it("分支紧跟父会话并缩进一层", () => {
		const out = flattenSessions([session("1"), session("2", "1"), session("3", "1")]);
		expect(out.map((n) => [n.session.id, n.depth])).toEqual([
			["1", 0],
			["2", 1],
			["3", 1],
		]);
	});

	it("多级分支逐层加深", () => {
		const out = flattenSessions([session("1"), session("2", "1"), session("3", "2")]);
		expect(out.map((n) => [n.session.id, n.depth])).toEqual([
			["1", 0],
			["2", 1],
			["3", 2],
		]);
	});

	it("父会话不存在时按顶层显示", () => {
		const out = flattenSessions([session("9", "404")]);
		expect(out).toEqual([{ session: session("9", "404"), depth: 0 }]);
	});

	it("自引用不会死循环", () => {
		const out = flattenSessions([session("1", "1")]);
		expect(out.map((n) => n.session.id)).toEqual(["1"]);
	});

	it("互指成环时每个会话只出现一次", () => {
		const out = flattenSessions([session("1", "2"), session("2", "1")]);
		expect(out.map((n) => n.session.id).sort()).toEqual(["1", "2"]);
	});
});

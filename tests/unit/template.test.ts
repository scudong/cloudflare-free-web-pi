import { describe, expect, it } from "vitest";
import { expandTemplate, hasPlaceholders } from "../../src/web/lib/template";

describe("expandTemplate", () => {
	it("无占位符时原样返回", () => {
		expect(expandTemplate("总结一下这段文字")).toBe("总结一下这段文字");
	});

	it("替换位置参数", () => {
		expect(expandTemplate("比较 $1 和 $2", ["Deno", "Bun"])).toBe("比较 Deno 和 Bun");
	});

	it("$@ 与 $ARGUMENTS 取全部参数", () => {
		expect(expandTemplate("调研 $@", ["A", "B"])).toBe("调研 A B");
		expect(expandTemplate("调研 $ARGUMENTS", ["A", "B"])).toBe("调研 A B");
	});

	it("缺少对应参数时保留占位符", () => {
		expect(expandTemplate("$1 与 $2", ["只有第一个"])).toBe("只有第一个 与 $2");
	});
});

describe("hasPlaceholders", () => {
	it("识别占位符", () => {
		expect(hasPlaceholders("$1")).toBe(true);
		expect(hasPlaceholders("$ARGUMENTS")).toBe(true);
		expect(hasPlaceholders("普通文本")).toBe(false);
	});
});

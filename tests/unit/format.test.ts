import { describe, expect, it } from "vitest";
import { formatSize, formatTime } from "../../src/web/lib/format";

describe("formatSize", () => {
	it("小于 1KB 显示 B", () => {
		expect(formatSize(512)).toBe("512 B");
	});
	it("KB / MB 换算", () => {
		expect(formatSize(2048)).toBe("2.0 KB");
		expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
	});
	it("非法值显示占位符", () => {
		expect(formatSize(0)).toBe("—");
		expect(formatSize(Number.NaN)).toBe("—");
	});
});

describe("formatTime", () => {
	it("ISO 时间格式化为 MM-DD HH:mm", () => {
		expect(formatTime("2026-10-19T09:11:37.280Z")).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
	});
	it("空值返回空串", () => {
		expect(formatTime("")).toBe("");
	});
});

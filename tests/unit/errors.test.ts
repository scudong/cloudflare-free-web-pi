import { describe, expect, it } from "vitest";
import { AppError, toResponse } from "../../src/worker/http/errors";

describe("toResponse", () => {
	it("入参校验失败 400 + 原中文文案", async () => {
		const res = toResponse(new AppError("bad_request", 400, "参数错误"));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "参数错误" });
	});

	it("资源不存在 404", async () => {
		const res = toResponse(new AppError("not_found", 404, "not found"));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not found" });
	});

	it("上游超时 504 带 retryable", async () => {
		const res = toResponse(new AppError("upstream_timeout", 504, "上游超时", true));
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "上游超时", retryable: true });
	});

	it("未知异常 500 + String(e).slice(0, 500)", async () => {
		const long = "x".repeat(600);
		const err = new Error(long);
		const res = toResponse(err);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: String(err).slice(0, 500) });
	});
});

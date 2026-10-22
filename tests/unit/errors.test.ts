import { describe, expect, it } from "vitest";
import { AppError, defaultErrorCode, errorText, toResponse } from "../../src/worker/http/errors";

describe("toResponse", () => {
	it("入参校验失败 400 + code + 原中文文案", async () => {
		const res = toResponse(new AppError("bad_request", 400, "参数错误"));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "参数错误", code: "bad_request" });
	});

	it("资源不存在 404 带稳定 code", async () => {
		const res = toResponse(new AppError("not_found", 404, "not found"));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
	});

	it("上游超时 504 带 retryable", async () => {
		const res = toResponse(new AppError("upstream_timeout", 504, "上游超时", true));
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "上游超时", code: "upstream_timeout", retryable: true });
	});

	it("details 原样回传（技能审计 422）", async () => {
		const details = { audit: { status: "blocked", reasons: [{ message: "shell" }] } };
		const res = toResponse(new AppError("audit_blocked", 422, "审计未通过", false, details));
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: "审计未通过", code: "audit_blocked", details });
	});

	it("兼容字段与统一字段共存，核心字段不被覆盖", async () => {
		const res = toResponse(new AppError("unsupported_type", 415, "只支持 PDF"), { ok: false, error: "伪造" });
		expect(res.status).toBe(415);
		expect(await res.json()).toEqual({ ok: false, error: "只支持 PDF", code: "unsupported_type" });
	});

	it("未知异常 500 + internal_error，不把 Error 前缀带出", async () => {
		const long = "x".repeat(600);
		const err = new Error(long);
		const res = toResponse(err);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: long.slice(0, 500), code: "internal_error" });
	});
});

describe("errorText / defaultErrorCode", () => {
	it("取 message，不带 Error: 前缀，并按上限截断", () => {
		expect(errorText(new Error("boom"), 200)).toBe("boom");
		expect(errorText(new Error("x".repeat(10)), 4)).toBe("xxxx");
		expect(errorText("plain")).toBe("plain");
	});

	it("老式端点错误按状态补稳定码", () => {
		expect(defaultErrorCode(400)).toBe("bad_request");
		expect(defaultErrorCode(404)).toBe("not_found");
		expect(defaultErrorCode(409)).toBe("conflict");
		expect(defaultErrorCode(500)).toBe("internal_error");
	});
});

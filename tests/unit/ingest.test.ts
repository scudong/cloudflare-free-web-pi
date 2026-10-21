import { describe, expect, it } from "vitest";
import {
	MAX_INGEST_BYTES,
	checkIngestFile,
	checkIngestUrl,
	ingestErrorMessage,
	ingestFileKind,
	isTextKind,
	parseIngestResponse,
	titleFromFileName,
	titleFromUrl,
} from "../../src/web/lib/ingest";

describe("ingestFileKind", () => {
	it("识别四种支持格式，大小写不敏感", () => {
		expect(ingestFileKind("手册.pdf")).toBe("pdf");
		expect(ingestFileKind("NOTES.MD")).toBe("md");
		expect(ingestFileKind("readme.markdown")).toBe("md");
		expect(ingestFileKind("a.b.txt")).toBe("txt");
		expect(ingestFileKind("spec.DOCX")).toBe("docx");
	});

	it("压缩包 / 无扩展名 / 只有点返回 null", () => {
		expect(ingestFileKind("archive.zip")).toBeNull();
		expect(ingestFileKind("photo.png")).toBeNull();
		expect(ingestFileKind("README")).toBeNull();
		expect(ingestFileKind("trailing.")).toBeNull();
	});

	it("只有 md / txt 能在接口未上线时走本地文本兜底", () => {
		expect(isTextKind("md")).toBe(true);
		expect(isTextKind("txt")).toBe(true);
		expect(isTextKind("pdf")).toBe(false);
		expect(isTextKind("docx")).toBe(false);
	});
});

describe("checkIngestFile", () => {
	it("接受 25MB 以内的 PDF / MD / TXT / DOCX", () => {
		expect(checkIngestFile({ name: "a.pdf", size: 10 })).toEqual({ ok: true, kind: "pdf" });
		expect(checkIngestFile({ name: "a.md", size: MAX_INGEST_BYTES })).toEqual({ ok: true, kind: "md" });
	});

	it("不支持的格式给出格式名，且不发请求（本地就返回失败）", () => {
		const result = checkIngestFile({ name: "archive.zip", size: 1024 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("unsupported_type");
		expect(result.message).toContain(".zip");
		expect(result.message).toContain("PDF");
	});

	it("超过 25MB 时明确说超限并带上实际大小", () => {
		const result = checkIngestFile({ name: "big.pdf", size: MAX_INGEST_BYTES + 1 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("too_large");
		expect(result.message).toContain("超过 25MB");
		expect(result.message).toContain("25.0 MB");
	});

	it("0 字节文件按空正文处理", () => {
		const result = checkIngestFile({ name: "empty.txt", size: 0 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("empty_content");
		expect(result.message).toContain("空的");
	});
});

describe("checkIngestUrl", () => {
	it("接受 http(s) 并去掉首尾空格", () => {
		expect(checkIngestUrl("  https://example.com/a?b=1  ")).toEqual({
			ok: true,
			url: "https://example.com/a?b=1",
		});
		expect(checkIngestUrl("http://example.com").ok).toBe(true);
	});

	it("空输入 / 无协议 / 非 http 协议都给出可读文案", () => {
		expect(checkIngestUrl("").ok).toBe(false);
		expect(checkIngestUrl("example.com").ok).toBe(false);
		const ftp = checkIngestUrl("ftp://example.com/file");
		expect(ftp.ok).toBe(false);
		if (!ftp.ok) expect(ftp.message).toContain("http(s)");
	});
});

describe("parseIngestResponse", () => {
	it("解析成功响应", () => {
		const result = parseIngestResponse({ ok: true, docId: "d_1", title: "季度报告", chunks: 12, chars: 48210 });
		expect(result).toEqual({ ok: true, docId: "d_1", title: "季度报告", chunks: 12, chars: 48210 });
	});

	it("容忍 ok 字段缺失的 2xx 响应", () => {
		const result = parseIngestResponse({ doc_id: 7, title: "旧后端", chunks: "3" }, 200);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.docId).toBe("7");
		expect(result.chunks).toBe(3);
	});

	it("把契约里的四种 code 原样带回，并保留服务端文案", () => {
		const result = parseIngestResponse({ ok: false, code: "too_large", message: "文件太大啦" }, 200);
		expect(result).toEqual({ ok: false, code: "too_large", message: "文件太大啦", unavailable: false });
	});

	it("服务端没给 message 时按 code 补一句人话", () => {
		const result = parseIngestResponse({ ok: false, code: "empty_content" }, 200);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe(ingestErrorMessage("empty_content"));
		expect(result.message.length).toBeGreaterThan(0);
	});

	it("404 / 501 标记为接口未上线，交给上层决定兜底", () => {
		for (const status of [404, 405, 501]) {
			const result = parseIngestResponse({ error: "not found" }, status);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.unavailable).toBe(true);
			expect(result.code).toBe("unavailable");
		}
	});

	it("非 JSON 的 5xx 响应落到服务端错误，不卡在进度态", () => {
		const result = parseIngestResponse(null, 502);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("server");
		expect(result.message).toBe(ingestErrorMessage("server"));
	});

	it("兼容既有的 {error} 失败响应", () => {
		const result = parseIngestResponse({ error: "未登录" }, 401);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe("未登录");
		expect(result.unavailable).toBe(false);
	});
});

describe("标题兜底", () => {
	it("文件名去掉扩展名", () => {
		expect(titleFromFileName("季度报告.pdf")).toBe("季度报告");
		expect(titleFromFileName("a.b.md")).toBe("a.b");
		expect(titleFromFileName(".pdf")).toBe("未命名文档");
	});

	it("链接用域名 + 路径兜底", () => {
		expect(titleFromUrl("https://example.com/docs/guide/")).toBe("example.com/docs/guide");
		expect(titleFromUrl("不是链接")).toBe("链接导入");
	});
});

describe("ingestErrorMessage", () => {
	it("三种必给文案彼此不同且可指导下一步", () => {
		const messages = [ingestErrorMessage("too_large"), ingestErrorMessage("unsupported_type"), ingestErrorMessage("empty_content")];
		expect(new Set(messages).size).toBe(3);
		for (const message of messages) expect(message.length).toBeGreaterThan(8);
		expect(messages[0]).toContain("25MB");
		expect(messages[1]).toContain("PDF");
	});
});

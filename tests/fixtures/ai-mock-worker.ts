import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * 金标专用：模拟 Workers AI 的 toMarkdown。
 * CI 没有 Workers AI 凭证，真实 PDF 解析跑不了；这里用 RPC service binding
 * 提供一个同形的 toMarkdown，让 /api/kb/ingest 的 PDF 路径可以端到端验证。
 * 文件内容里带 MOCK_ERROR / MOCK_EMPTY 时分别模拟解析失败与空正文。
 */
const MOCK_MARKDOWN = [
	"# 向量检索实战笔记",
	"",
	"## 第一页：为什么需要向量检索",
	"关键词检索依赖字面命中，遇到同义改写就会漏。尼瑞德量子锚 是本篇第 3 页出现的专有名词，用来验证导入后的检索链路。",
	"",
	"## 第二页：分块策略",
	"按段落切块，每块不超过 800 字，相邻块保留 80 字重叠。这样既能控制 embedding 的输入长度，也能避免切在句子中间。",
	"",
	"## 第三页：尼瑞德量子锚 的定位",
	"尼瑞德量子锚 是检索质量评估里的人工标注锚点：只要查询这个词能命中本文档，就说明解析、分块、索引三步都通了。",
	"",
	"## 第四页：混合检索",
	"向量召回负责语义相近，BM25 负责精确词。两路结果用 RRF 融合，前 6 条注入上下文，剩余的交由模型按需再查。",
	"",
	"## 第五页：索引维护",
	"删除文档时同步删除分块、FTS 行与向量 id，避免脏数据。重建索引只处理 vectorized = 0 的分块，失败自动回退关键词检索。",
	"",
	"## 第六页：成本控制",
	"embedding 批量 16 条一次请求，向量库批量 200 条写入；权限按用户 DO 隔离，向量元数据带 scope 过滤。",
].join("\n");

export class AiMock extends WorkerEntrypoint {
	async toMarkdown(input: { name: string; blob: Blob }) {
		const text = await input.blob.text();
		if (text.includes("MOCK_ERROR")) {
			return { id: "1", name: input.name, mimeType: "application/pdf", format: "error", error: "这个文件打不开" };
		}
		if (text.includes("MOCK_EMPTY")) {
			return { id: "1", name: input.name, mimeType: "application/pdf", format: "markdown", tokens: 0, data: "  \n " };
		}
		return { id: "1", name: input.name, mimeType: "application/pdf", format: "markdown", tokens: 120, data: MOCK_MARKDOWN };
	}
}

export default { fetch: () => new Response("ai-mock") };

# 用户知识库设计（v0.45.0）

每个用户一个独立知识库：文档、分块与检索索引全部存在该用户自己的 Durable Object SQLite 里，不引入外部数据库，也不额外收费。

## 调研：三条可选路线

| 方案 | 原理 | 成本 / 复杂度 | 中文效果 | 判断 |
|---|---|---|---|---|
| **DO SQLite + FTS5**（选用） | 文档分块后写进 FTS5 虚拟表，`bm25()` 排序 | 0 额外服务；迁移简单 | 中文用「重叠二元组」索引，2 字词可命中 | 个人 / 小团队规模的资料检索足够 |
| Vectorize + Workers AI 向量 | `@cf/baai/bge-m3` 生成向量，Vectorize 按用户 namespace 检索 | 多一套存储与配额；需要同步索引 | 语义检索好，但按用户隔离要自己管 namespace | 作为后续可选增强，不作为第一版 |
| Cloudflare AutoRAG | 托管 RAG，文档放 R2 自动切块、向量化 | 按实例计费；每用户一个实例成本高 | 好 | 对当前多用户模型过重 |

选 FTS5 的三个直接原因：

1. **隔离是免费的**：邀请用户本来就各有一个 `user:<id>` Durable Object，KB 表天然互不可见。
2. **零外部依赖**：备份 / 恢复、迁移、删除都沿用现有 DO 生命周期；不用管理 R2 / 向量索引的一致性。
3. **中文可检索**：workerd 的 SQLite 自带 FTS5（含 `bm25`）。中文没有空格，索引时把连续汉字切成重叠二元组（`知识库` → `知识` / `识库`），查询用同样切法做 `AND`，所以「久期」「信用债」这类两字词也能命中。

## 数据结构

```sql
kb_docs   (id, title, source, tags, content, created_at, updated_at)
kb_chunks (id, doc_id, seq, text)
kb_fts    FTS5(title_tokens, body_tokens)   -- rowid = kb_chunks.id
```

- 正文按空行分段，聚合成约 800 字的片段；超长段落按 720 字步长切分并留 80 字重叠。
- 标题 / 来源 / 标签单独索引，`bm25(kb_fts, 6.0, 1.0)` 给标题更高权重。
- 单篇上限 20 万字符、2000 个分块；查询最多取 20 个片段。

## 工具

| 工具 | 级别 | 说明 |
|---|---|---|
| `kb_search(query, limit?)` | 读 | 检索当前用户知识库，返回文档名、来源、片段 |
| `kb_add(title, content, source?, tags?)` | 写 | 入库并建立索引；工作台文件不会自动进知识库 |
| `kb_list()` | 读 | 列出文档（id / 分块数 / 字符数） |
| `kb_delete(id)` | 写 | 删除文档及其分块、索引 |

提示词会告诉模型：涉及用户私人资料先 `kb_search`；用户说「存到知识库」时用 `kb_add`，不要写成工作台文件。

## API 与界面

- `GET /api/kb` · `POST /api/kb` · `DELETE /api/kb?id=` · `GET /api/kb/doc?id=` · `GET /api/kb/search?q=`
- `POST /api/kb/ingest`：`multipart/form-data` 传文件、`application/json` 传链接（见下节）
- 左栏「知识库」：检索、粘贴正文入库、文件 / 链接导入、查看全文、删除。
- 备份包含 `kbDocs`（只备份正文）；恢复时重新分块并重建索引。

## 导入通道（v0.55.0）

入口在左栏「知识库」→ `+` → 「或导入已有资料」：

| 来源 | 服务端处理 | 标题 |
|---|---|---|
| PDF / DOCX | `env.AI.toMarkdown()`（Workers AI 文档转换）→ Markdown | 文件名去掉扩展名 |
| MD / TXT | 直接按 UTF-8 读文本 | 同上 |
| 网页链接 | `web_fetch_page` 同一条 DeepSeek Fetch 链路 | 页面 `<title>`，取不到时用域名 |

三条路径最终都调用 `kbSaveDoc()`（`kbAddDoc()` + 索引 + 按需向量化），不引入解析库、不加新存储。一次最多 10 个文件，逐个返回成功 / 失败。

失败一律带明确文案，不静默：

| 情况 | 状态码 | 文案要点 |
|---|---|---|
| 单个文件 > 20MB，或请求体明显超限 | 413 | 超过 20MB 上限，请拆分后再导入 |
| 扩展名不在 PDF / MD / TXT / DOCX | 415 | 列出支持的格式 |
| 解析结果为空（含图片型 PDF） | 422 | 没有解析出正文；扫描件暂不支持 OCR |
| 环境没有 `AI` 绑定 | 400 | 当前环境不支持 PDF 解析（未绑定 Workers AI） |
| 链接不是 http(s)，或未配置 `DEEPSEEK_API_KEY` | 400 | 指出缺的是什么 |

> 测试与本地开发没有 `AI` 绑定，用 `KB_AI_CONVERT_STUB`（见 `wrangler.test.jsonc`）冒充一次 `toMarkdown` 结果，金标用例才能覆盖「上传 → 入库 → 可检索」的完整链路。

## 每轮预检索（v0.46.0）

默认开启。`chat()` / `streamChat()` 在写入本轮 `instructions` 之前：

1. 取本轮用户消息（`/技能` 调用时取命令之后的正文）
2. 切词，去掉口语停用词（怎么 / 什么 / 如何 / 可以 …）
3. 先按 `AND` 匹配；全空时退化为 `OR`，由 bm25 排序
4. 取前 3 段、每段最多 600 字，拼成「知识库参考资料」附在本轮 instructions 末尾
5. 没有命中、或开关关闭时，不追加任何内容

一次本地 FTS 查询；命中时约 600–1800 字（≈300–900 token）进入本轮提示。模型仍可继续调用 `kb_search` 取更多内容。设置 → 对话 → 「知识库预检索」可关闭；`GET /api/kb/prefetch?q=` 返回本轮实际会注入的原文。

## 限制

- 关键词检索，不做同义词 / 语义扩展；问法和原文用词差太远时可能不命中。
- 少于 2 个汉字的查询（如单字）走 `LIKE` 兜底，结果不按相关度排序。
- 扫描件（图片型 PDF）不做 OCR，导入时只会得到空正文和一句提示。
- 不支持批量目录 / 云盘同步；单文件 20MB、单篇 20 万字符封顶。

## 后续可加

- 混合检索：给每个分块存 `bge-m3` 向量，关键词 + 向量分数融合；索引放在同一 DO 的 SQLite 或按用户 namespace 的 Vectorize。Supabase pgvector 的可选方案见 [semantic-search-options.md](semantic-search-options.md)。
- 文档导入：R2 上传 + 扫描件 OCR（文本型 PDF / DOCX 已由 `toMarkdown` 覆盖）。
- 引用回链：检索结果带分享页 / 原文件链接。

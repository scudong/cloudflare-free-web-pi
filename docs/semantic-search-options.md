# 语义检索扩展：现状、Supabase 与 Vectorize

> 结论：
> 1. **当前系统没有使用 Supabase**，也没有任何外部数据库或向量库。
> 2. **v0.53.0 已实现 Cloudflare Vectorize 向量检索**（AI 绑定 + `pi-kb` 索引，fts / vector / hybrid 三档）。
> 3. Supabase 仍可作为第二个可选 provider 接入，但不应替换 Durable Object 里的主存储。

## 现在的检索是怎么做的

- 文档、分块、索引都在每个用户自己的 Durable Object SQLite 里。
- 检索用 FTS5：中文重叠二元组 + `bm25`，先 AND 后 OR。
- 每轮对话前自动取前 3 段注入，模型也可以主动调用 `kb_search`。
- 没有 Supabase SDK、没有 pgvector、没有外部检索服务。

```bash
# 验证：仓库里没有任何 Supabase 依赖
grep -ri supabase --include="*.ts" --include="*.json" src package.json
```

## Supabase 能放在哪一层

只放**知识库的向量索引**，不要动下面这些：

| 数据 | 现在 | 引入 Supabase 后 |
|---|---|---|
| 会话 / 任务 | DO SQLite | 不变 |
| 文件 / 分享 | DO SQLite + DO 路由 | 不变 |
| 用户与邀请码 | UserRegistry DO | 不变 |
| 知识库正文 | DO SQLite | **仍然是唯一事实来源** |
| 知识库向量 | 无 | Supabase pgvector（可重建的派生索引） |

原因：把主存储搬到 Supabase 会失去「一个 Worker、无外部数据库」的核心卖点，还会带来跨区延迟、备份双写、鉴权重复三件事。

## 可选架构

```text
kb_add
  → 分块（现有逻辑）
  → 写 DO SQLite（正文，先成功）
  → 异步：embedding（Workers AI bge-m3，1024 维）
  → upsert 到 Supabase kb_chunks

kb_search
  → FTS5 关键词结果
  → embedding(query) → Supabase RPC match_kb_chunks
  → 两路结果融合（RRF），取前 N 段
```

### 表与 RPC

```sql
create table kb_chunks (
  id bigint generated always as identity primary key,
  user_id text not null,
  doc_id bigint not null,
  seq int not null,
  text text not null,
  embedding vector(1024) not null
);

create index kb_chunks_embedding_idx
  on kb_chunks using hnsw (embedding vector_cosine_ops);

alter table kb_chunks enable row level security;

create or replace function match_kb_chunks(
  p_user_id text,
  p_query vector(1024),
  p_limit int default 6
) returns table (doc_id bigint, seq int, text text, score float)
language sql stable as $$
  select doc_id, seq, text, 1 - (embedding <=> p_query) as score
  from kb_chunks
  where user_id = p_user_id
  order by embedding <=> p_query
  limit p_limit;
$$;
```

### 向量从哪来

Supabase 只存向量，不生成向量。需要一个 embedding 模型：

- **Workers AI `@cf/baai/bge-m3`**：1024 维，多语言，和现有 Cloudflare 账号同一个体系；
- 或任意 OpenAI 兼容的 embedding 端点（需要单独配置 key）。

本项目的 DeepSeek 对话接口不提供向量，所以这一步是新增依赖，不是「打开 Supabase 就有」。

### 密钥与隔离

- 不要把 service role key 放到前端；分享页与浏览器只读不到它。
- 当前 Vectorize 走 Worker 绑定，不涉及 key；如果接 Supabase，service role key 不应放前端。可以存在用户 DO（会随备份导出，需要提示），或用 Edge Function 包一层。
- 现有鉴权是自签 cookie，不是 Supabase Auth；如果要靠 RLS 做隔离，需要给每个用户签发 Supabase JWT，或者在服务端强制 `user_id` 过滤。无论哪种，隔离都从「物理隔离（独立 DO）」降级为「逻辑隔离（同一张表 + where）」。

## 免费额度与风险（2026）

第三方汇总的常见数字（以 Supabase 控制台为准）：

- 数据库 **500 MB**，pgvector 含 HNSW 索引；1536 维向量大约能放 5–8 万条（含索引开销）。
- **免费项目 7 天无活动会休眠**，恢复要手动点；这是个人工具最大的坑。
- 2 个活跃项目、5 GB 出网、1 GB 文件存储；无自动备份。

对一个「偶尔用一下」的个人知识库，休眠比容量更容易先出问题。

## Supabase vs Cloudflare Vectorize

| | Supabase pgvector | Cloudflare Vectorize |
|---|---|---|
| 账号体系 | 多一个外部账号 | 同一个 Cloudflare 账号 |
| 数据形态 | SQL + 向量，可 join / 过滤 | 纯向量索引 + metadata |
| 免费限制 | 500 MB、7 天休眠 | 有独立配额，无「项目休眠」 |
| 延迟 | 取决于项目区域 | 与 Worker 同平台，路径更短 |
| 鉴权 | RLS / JWT 或服务端过滤 | Worker 内直接调用 |
| 备份 | pg_dump；索引可重建 | 索引可从 DO 正文重建 |
| 适合 | 已有 Supabase、想要 SQL + 向量一体 | 想保持单平台、少一个供应商 |

## Supabase provider 的落地顺序（未实现）

1. 把检索抽成 provider 接口：`fts`（默认）/ `vector` / `hybrid`。
2. `kb_add` 写入后异步生成向量；失败不回滚正文，只标记待重建。
3. 增加「重建索引」入口，用 DO 里的正文重新灌向量。
4. 设置页加 provider 配置与连接测试。
5. 测试：假 embedding provider + 本地 mock；Supabase 用独立测试项目，不碰生产。

工作量预估：Vectorize 约 1–2 天；Supabase 再加 1 天（RLS / RPC / 密钥）。

## 建议

- **默认保持 FTS5**，它是零依赖、零费用、可离线重建的基线。
- 语义检索作为**可选增强**，不要成为必选项。
- 如果要做第一个向量后端，选 **Vectorize**；Supabase 作为「用户已有 Supabase」的兼容选项。

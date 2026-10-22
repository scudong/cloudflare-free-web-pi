# 后端架构地图

> 基线：`ce75bce`（2026-10-21，NERE-17 KB ingest 合并后）· 范围：Worker / Durable Objects / API / 数据层
> 前端地图见 `docs/frontend-map.md`（前端架构-qian 维护）。
> 本文件只描述**现状**与**风险**，目标分层见 `docs/adr/0001-layering.md`。改动后端结构时同步更新本文件。

## 1. 运行拓扑

```text
Browser (React SPA, dist-web)
  │  同源 fetch，无 CORS
  ▼
Worker 默认导出 (src/worker.ts:5148)
  ├─ /api/auth | /api/login | /api/logout      公开
  ├─ /api/users*                               仅主人 → UserRegistry DO(registry)
  ├─ /s/<token>                                公开只读，按 token 前缀选 DO
  └─ /api/* 与 /agent/*                        Cookie HMAC 鉴权 → 每用户 SpikeAgent DO
        │
        ▼
SpikeAgent DO（每用户一个；主人沿用 "spike"，邀请用户 "user:<id>"）
  ├─ pi-durable Harness（会话/条目/用量/任务）落在同一 DO SQLite
  ├─ 21 张业务表（本文件第 5 节）
  ├─ LLM：默认 DeepSeek，或用户配置的 OpenAI 兼容端点
  ├─ MCP 客户端（出站 HTTP，工具清单常驻）
  ├─ Workers AI（bge-m3 embedding）+ Vectorize（全局索引 pi-kb，按 metadata.scope 过滤）
  └─ alarm：定时任务 + 目标模式续转
```

同域静态资源由 `wrangler.jsonc` 的 `assets` 托管；`run_worker_first` 只让 `/agent/*`、`/api/*`、`/s/*` 进 Worker（`wrangler.jsonc:9`）。

## 2. 模块清单

后端只有一个源文件 `src/worker.ts`（5249 行）。下表按职责切分；位置用**符号**定位（行号只作当前基线参考，符号不随 PR 漂移）。

| 逻辑模块 | 位置（符号） | 职责 | 主要依赖 | 数据 |
|---|---|---|---|---|
| Worker 入口 / 鉴权 | `default export`（`5148-5249`）、`authorizedUser`/`accessToken`（`4960-5050`） | Cookie 解析、HMAC 签名、邀请码登录、主人/邀请用户分流、DO 路由 | `ACCESS_PASSWORD`、`UserRegistry` | 无 |
| 首屏聚合 | `worker/bootstrap.ts` | 编排 17 个只读面板，逐字段容错；由 `GET /bootstrap` 调用 | 各域读取 helper | 无（只读） |
| UserRegistry DO | `class UserRegistry`（`5053-5146`） | 邀请码校验、用户 CRUD、吊销 | DO SQLite | `users` |
| SpikeAgent DO | `class SpikeAgent`（`2639-4949`） | 用户状态所有者、RPC 入口、Harness 生命周期、alarm | pi-durable、DO SQLite | 全部用户数据 |
| HTTP 路由层 | `handleFetch`（`3903-4948`） | 81 个分支：解析、校验、状态码、**内联 SQL** | DO 方法、模块级 helper | 直接读写 15+ 张表 |
| Agent 运行时 | `spikeExtension`（`1969`）、`buildInstructions`（`2940`）、`runChat`（`2702-2769`）、`runChatStream`（`3699-3875`） | 工具定义、系统提示、chat / SSE 流、技能注入 | Harness、LLM、MCP、AI | Harness 表 |
| 会话与文件 | 路由 `routes/session.ts`、`routes/files.ts`；用例 `services/session-service.ts`、`services/file-service.ts`；SQL `repo/sessions-repo.ts`、`repo/files-repo.ts`；工具 `write_file`/`read_file`/`list_files`（`~1770-1810`） | 会话列表/新建/分支/删除、工作台文件；路由层零 SQL，Harness 协调留在 DO 的 `sessionRuntime()` 端口 | 服务/仓储、Harness | `sessions_meta`、`vfs_v2` |
| 知识库 | 路由 `routes/kb.ts`；用例 `services/kb-service.ts`；SQL `repo/kb-repo.ts`；纯函数 `lib/kb.ts`；工具 `kb_search`/`kb_add`/`kb_list`/`kb_delete`（`~1400-1465`） | 分块、FTS5、向量索引、混合检索、预检索、ingest；AI / Vectorize / settings / 抓取全部经端口注入 | 服务/仓储、AI、Vectorize | `kb_docs/kb_chunks/kb_fts` |
| 分享 | `sharePage`（`2498`）、`createShare`（`3321`）、`listShares`（`3343`）、路由 `4219-4279` | token 生成、SSR 分享页、主题/目录、过期 | `shares`、`vfs_v2`、Harness | `shares` |
| 定时任务与目标 | 调度 helper（`196-300`）、`alarm`（`3006-3019`）、`goalTick`（`3667`）、路由 `4280-4326`、`4756-4786` | alarm 调度、token 预算、自动续转 | `automations`、`goals` | `automations`、`goals` |
| 审批与问答 | 审批闸门 / `ask_user`（`~380-500`）、路由 `4433-4472`、`4582-4628` | 工具审批闸门、ask_user 卡片 | `approvals`、`approval_grants`、`questions` | 同上 |
| 设置 / 供应商 / MCP | `getSetting`/`setSetting`（`156-170`）、`activeProviderId`/`activeModelIds`（`~660-724`）、`buildMcpExtension`（`2066`）、路由 `4649-4906` | app_settings、OpenAI 兼容端点、MCP 连接 | 外部 HTTP | `app_settings`、`providers`、`mcp_servers` |
| 记忆与反思 | `remember`/`recall` 工具（`~1290-1310`）、`maybeReflect`（`3551`）、路由 `4907-4930` | `pi_mem`、会话末自动抽取 | LLM | `pi_mem`、`reflect_state` |
| 备份 / 恢复 | `backup`/`restore`（`3152-3342`） | 业务表全量 JSON 导出、按主键 upsert 恢复 | 全部业务表 | — |
| 静态资产 | `wrangler.jsonc:8-10` | SPA fallback、静态文件 | Cloudflare Assets | `dist-web` |

## 3. 接口面

Worker 剥掉 `/api` 或 `/agent` 前缀后转发给 DO（`src/worker.ts:5211-5245`），因此 DO 内部路径是 `/sessions`、`/chat/stream` 这类短路径。当前共 **81 个 method+path 分支**（`worker.ts:3903-4948`），按域分组：

| 域 | 端点 | 备注 |
|---|---|---|
| 对话 | `POST /chat`、`POST /chat/stream`、`POST /interject`、`POST /abort`、`POST /reset`、`POST /compact` | 前端只用 SSE |
| 会话 | `GET/POST/PATCH/DELETE /sessions`、`POST /branches`、`GET /entries`、`GET /session` | 阶段 1 已离开 legacy：`routes/session.ts` → `session-service` → `sessions-repo`；`sessions_meta` 与 Harness 双写 |
| 首屏 | `GET /bootstrap` | 17 个只读面板聚合，单字段故障隔离 |
| 文件 | `GET/DELETE /files`、`GET /files/content`、`GET /files/all` | 阶段 1 已离开 legacy：`routes/files.ts` → `file-service` → `files-repo` |
| 知识库 | `GET/POST/DELETE /kb`、`/kb/doc`、`/kb/search`、`/kb/prefetch`、`/kb/status`、`/kb/reindex`、`POST /kb/ingest` | 阶段 2 已离开 legacy：`routes/kb.ts` → `kb-service` → `kb-repo`；FTS / vector / hybrid |
| 分享 | `POST /share`、`GET /shares`、`GET /s/<token>` | `/s/` 公开 |
| 自动化 / 目标 | `GET/POST/PATCH/DELETE /automations`、`GET/POST/DELETE /goal` | alarm |
| 设置 / 模型 | `GET/POST /settings`、`GET/POST/DELETE /providers`、`POST /providers/activate`、`GET /models`、`POST /model`、`GET /context` | 改压缩/供应商会重建 Harness |
| 能力 / 工具 | `GET /tools`、`GET /capabilities`、`GET /mcp`、`POST/DELETE /mcp`、自定义工具、`/skills*`、`/prompts*`、`/rules*` | 工具清单 |
| 审批 / 问答 | `GET/POST /approvals`、`GET/POST /questions` | |
| 数据 | `GET /backup`、`POST /restore`、`GET /export`、`GET/DELETE /memories`、`POST /reflect` | 备份不含对话正文 |
| 系统 | `GET /version`、`GET /debug/agent`、`GET /kernel` | `debug` 会重建扩展 |

鉴权边界：

- `ACCESS_PASSWORD` 为空时一律视为主人（本地/开放模式，`authorizedUser` @ `worker.ts:5013`）。
- 邀请用户 token = `u_xxx.HMAC`；**每个请求**都会查一次 `UserRegistry` 确认用户未被删除（`authorizedUser` @ `worker.ts:5013` → `UserRegistry.fetch` @ `5053`）。
- `/s/` 不鉴权；新 token 前缀 `u_xxx.` 决定路由到哪个用户 DO，旧 token 落到主人 DO（`worker.ts:4828-4836`）。

## 4. 依赖方向

目标方向（ADR-0001）：`Route → Service → Repository → SQL`，DO 只做组合根；工具/扩展调用 Service。

现状方向：

```text
route handler ──┬─→ SQL（105 处直接 exec）
                ├─→ DO 方法（chat/share/...）
                └─→ 模块级 helper（多数 helper 也直接 SQL）
模块级 helper ──→ sqlFacade（AsyncLocalStorage 代理，worker.ts:46-61）
工具扩展       ──→ 同一批 helper / sqlFacade
DO            ──→ Harness / MCP / Vectorize / LLM
```

现状的直接后果：

1. **路由层包含业务与存储**：`handleFetch`（`3903-4948`，1046 行）里有 105 处 `sqlFacade`、52 次 `ensureTables`。例如 `PATCH/DELETE /sessions`（`3975-3994`）、`/files*`（`3996-4029`）、`/kb*`（`4031-4152`）、`/automations*`（`4280-4326`）、`/approvals*`（`4582-4628`）都是路由内直接 SQL。
2. **隐式存储依赖**：模块级函数通过 `sqlFacade` 取当前请求的 SQL（`worker.ts:46-61`）；离开 `agentScope.run` 就抛 `Agent scope missing`。Service 无法脱离 DO 请求上下文单测。
3. **跨 DO 模块级可变状态**：`customToolNames`（`350`，`563` 清空）与 `mcpCache`（`2063`，按 `server.id` 缓存）是 isolate 级全局，多个用户 DO 共享同一 isolate 时会互相覆盖/串用。
4. **跨 DO 通信只有一种显式协议**：Worker → `UserRegistry` 的 `/internal/verify-code`、`/internal/user-status`（`UserRegistry.fetch` @ `5053`）；其余都是 Worker 直连各用户 DO。

## 5. 数据所有权

### 5.1 业务表（21 张，均在用户自己的 SpikeAgent DO）

| 表 | 责任域 | 主要写入点 | 备份 |
|---|---|---|---|
| `sessions_meta` | 会话 | `session-service`（新建、分支、改名、删除）、`runChat/runChatStream` 标题 | 是（不含 `deleted/hidden`） |
| `vfs_v2` | 工作台文件 | `file-service`（工具 `write_file`、`/files` 删除、会话删除）、恢复 | 是（含全文） |
| `pi_mem` / `reflect_state` | 记忆 / 反思游标 | `remember`、`reflect` | `pi_mem` 是；`reflect_state` 否 |
| `skills` / `prompts` / `rules` | 用户资产 | API 与工具 | 是 |
| `app_settings` | 全局设置 | `/settings` | 是 |
| `plans` | 分步计划 | `update_plan` | 是 |
| `goals` | 目标模式 | `/goal`、`goalTick` | 是 |
| `automations` | 定时任务 | `/automations`、alarm | 是 |
| `approvals` / `approval_grants` | 工具审批 | 工具闸门、`/approvals` | 否 |
| `questions` | ask_user | 工具、`/questions` | 否 |
| `custom_tools` | 自定义 JS 工具 | `/custom-tools` | 否 |
| `providers` | LLM 供应商 | `/providers` | 是（含明文 `api_key`） |
| `mcp_servers` | MCP 配置 | `/mcp` | 是（含 headers） |
| `shares` | 公开分享 token | `/share` | 是 |
| `kb_docs` / `kb_chunks` / `kb_fts` | 知识库 + FTS 索引 | `kb-repo`（`kb-service` 编排：`/kb*`、`kb_add`/`kb_delete`、恢复） | 仅 `kb_docs`，恢复时重建分块/索引 |

表定义集中在 `ensureTables`（`worker.ts:63-153`），`open()` 每次执行；`handleFetch` 里另有 **52 次**重复调用。迁移器落地后改为 `db/migrations.ts` 一次执行（ADR-0001 §9.4）。

### 5.2 其他数据所有者

| 数据 | 所有者 | 说明 |
|---|---|---|
| 会话条目、用量、任务 | pi-durable Harness（同一 DO SQLite） | 表结构由依赖管理，应用代码不应直查；`/export` 是唯一出口（`exportMarkdown` @ `3445`） |
| 邀请用户 | `UserRegistry` DO（全局单实例 `registry`） | 只存 `users`，不含任何用户内容 |
| 向量 | Vectorize `pi-kb`（全局索引） | 派生数据，`id = <scope>:<chunkId>`，`scope` 由 `RequestContext.scopeId` 经端口传入（前缀与 metadata 过滤，写入 `kb-service` 的 `indexDoc`）；可重建 |
| 分享页 | `shares` + 请求时渲染 | 会话分享实时读 Harness 条目，不是快照 |

### 5.3 生命周期边界

- 删除会话只做 `deleted=1` + 删该会话文件 + 暂停目标（`worker.ts:3654-3666`），不删该会话的 `shares`、`plans`、`approvals`、`questions`，也不删 Harness 条目。
- 删除邀请用户只删 `UserRegistry.users` 一行（`worker.ts:4734-4738`），不通知该用户的 DO；其公开分享链接仍可访问（`/s/` 不鉴权）。
- 备份不覆盖 `approvals`、`questions`、`custom_tools`、`reflect_state`、`users`；恢复不做事务。

## 6. 关键时序：一次流式对话

```text
Browser POST /api/chat/stream
  → Worker: authorizedUser（邀请用户会查 UserRegistry）
  → SpikeAgent.fetch → agentScope.run → handleFetch
      → open()：建 registry/扩展/MCP/SQLite/Harness（首次或重建后）
      → conversationFor → root.configure(model, thinking, extensions, instructions)
      → buildInstructions：规则/技能/目标 + kbPrefetchBlock（一次 FTS 或一次 embedding+向量查询）
      → 返回 SSE Response；pump 在 ctx.waitUntil 中继续（worker.ts:3539-3546）
          → watchEvents 推送 thinking/text/tool_start/tool_end
          → submit → wait → commit(AssistantEntry)
          → 目标模式最多 3 轮，其余写 next_run_at 交给 alarm
          → maybeReflect（waitUntil）
```

非流式 `runChat`（`2702-2769`）与流式 `runChatStream`（`3699-3875`）重复了 configure / 标题更新 / 目标续转等前置逻辑，已是两份需要同步维护的实现。

## 7. 外部依赖与配置

| 依赖 | 用途 | 配置 |
|---|---|---|
| `SpikeAgent` DO | 每用户状态 | `wrangler.jsonc:12-14`，migration `v1` |
| `UserRegistry` DO | 邀请码/用户 | 同上，migration `v2` |
| `AI`（Workers AI） | `@cf/baai/bge-m3` embedding | `wrangler.jsonc:6`，可用 `CF_DISABLE_VECTOR=1` 关闭 |
| `KB_VEC`（Vectorize） | 1024 维余弦索引 `pi-kb` | `wrangler.jsonc:7` |
| `DEEPSEEK_API_KEY` | 默认模型 | secret |
| `ACCESS_PASSWORD` | 登录/签名 | secret；为空即开放模式 |
| `BUILD` | `/version` 构建号 | `wrangler.jsonc:3`，CI 注入 |
| 用户配置的 OpenAI 兼容端点 | 自定义供应商 | `providers` 表，明文 key |
| MCP 服务器 | 外部工具 | `mcp_servers` 表，出站 HTTP |
| pi 包 | agent 运行时 | `package.json`：pi-ai / pi-durable / pi-codemode / pi-mcp / chord |

CI：`.github/workflows/deploy.yml`（test → build → deploy）、`smoke.yml`、`metrics.yml`、`pi-upgrade.yml`。

## 8. 风险清单

严重度：**P0** 阻断演进 / **P1** 用户可见或数据风险 / **P2** 维护性 / **P3** nit。

> 行号口径：R1/R4/R5/R11 已按 `ce75bce` 刷新；R2/R3/R6-R15 的证据行号仍是 `64c9515` 基线，在其所属域迁移时重锚（阶段 3/4 顺手更新）。引用风险时优先用符号名。

> 执行状态（2026-10-22）：ADR-0001 已转 Accepted；阶段 0a（迁移器）与 0b（路由表）已合并。阶段 1（会话/文件）已收口：`routes/session|files.ts` → `services/session|file-service.ts` → `repo/sessions|files-repo.ts`，`sessions_meta`/`vfs_v2` 在路由与工具中零内联 SQL。阶段 2（知识库）已收口：`routes/kb.ts` → `services/kb-service.ts` → `repo/kb-repo.ts`，纯函数在 `lib/kb.ts`；AI / Vectorize / settings / 抓取经端口注入，路由与工具零内联 SQL；R4 由 0a 关闭，R1/R11 由阶段 1-5 逐步关闭。

| ID | 级别 | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|---|
| R1 | P0 | 单文件单体：`handleFetch` 81 个分支、105 处路由内联 SQL | `worker.ts` 5249 行；`3903-4948` | 无法单测业务、合并冲突、改动半径不可控 | 执行 ADR-0001，按域增量拆分 |
| R2 | P1 | 公开分享页也会启动完整 Harness | `3579`（所有非 `/` 请求 `open()`）+ `3886`（`/s/`）+ `2315-2344` | 冷启动分享页要建扩展/MCP/Harness；MCP 不可用时分享也可能变慢/失败 | 分享文件与 404/过期路径零 Harness；会话分享在 token 命中后再开；评估创建时快照 |
| R3 | P1 | 首屏 18 个 API 请求，全部进同一个单线程 DO；邀请用户每次再查一次全局 registry | `App.tsx:160-260, 638-1050`；`worker.ts:4637`、`4600-4613` | 首屏延迟 = 18 次串行 DO 往返；registry 成为全站串行点 | 已落地 `GET /api/bootstrap`（NERE-23）：后端只读面板合并为 1 个请求，registry 查询随面板数收敛为每请求一次；前端切换后首屏为 bootstrap + auth 两个请求 |
| R4 | P1 | schema bootstrap 顺序脆弱：先 ALTER 后 CREATE，异常全吞；DDL 在请求路径执行 | `78-102`（5 个 ALTER 在 `CREATE sessions_meta` 之前）、`63-153`、52 次请求内 `ensureTables` | 全新 DO 首次 `open()` 只得到 4 列；依赖后续某次 `ensureTables` 补列，漏掉的路径会 500 或静默回落默认值 | 版本化迁移（`schema_migrations`），先建表后补列，空库首启测试 |
| R5 | P1 | 跨 DO 的模块级可变状态 | `customToolNames` `350/563`；`mcpCache` `2063/2086`（只按 server.id） | 同 isolate 多用户时，自定义工具分类和 MCP client 可能串用 | 移到 DO 实例字段或按 `scopeId` 分键 |
| R6 | P1 | 删除用户不吊销数据与分享 | `4734-4738`；`4828-4836`；`3043-3129` | 被吊销用户的公开链接继续可读，DO 数据与费用继续存在 | 定义吊销语义：立即删 shares（可选清空 DO），分享 404 |
| R7 | P1 | 大规模知识库的向量索引只建前 100 段 | `986`（`LIMIT 100`）；`3712-3717` 只调一次；`1002-1023` 手动重建 | 20 万字符文档约 270 段，尾部在 vector 模式下永远检索不到，status 只显示比例 | 批量循环或 alarm 续建；`/kb/status` 暴露 pending；补 >100 段用例 |
| R8 | P1 | 备份/恢复把全部文件正文与供应商 key 装进一个 JSON，恢复无事务 | `2809-2834`；`2835-2977` | DO 内存与响应体积随文件增长；恢复中途失败留下半套数据 | 流式/按域导出；恢复用事务或可重入游标；key 默认脱敏 |
| R9 | P2 | 会话元数据与 Harness 会话双源，靠读时修复 | `2553-2580` | 两侧漂移时列表/删除/分享行为不一致 | 明确唯一真源；把 `sessions_meta` 降级为索引或在迁移中重建 |
| R10 | P2 | 会话/用户删除不做级联清理 | `3654-3666`；`4734-4738`；`3004` 只在建分享时清过期 | `shares/plans/approvals/questions` 与 Harness 条目长期堆积 | 统一生命周期 Service + 定期清理 alarm |
| R11 | P2 | 流式与非流式对话是两套实现 | `runChat` `2702-2769` vs `runChatStream` `3699-3875` | 标题、目标续转、工具摘要逻辑漂移 | 合并为单一 ChatService，非流式复用同一提交路径 |
| R12 | P2 | 入站对话没有并发闸门；`activeChats` 只挡 alarm | `2347-2362`、`3371-3383`；检查点仅 `2693/2721`；SSE 在 `3539` 之后继续 | 同会话两个请求可能交错 submit，是否被 Harness 拒绝取决于依赖行为（**未验证**） | 显式会话锁或 409；补并发用例 |
| R13 | P2 | 向量过滤回退可能被其他用户结果挤占 | `966-979`：先 filter，空则无过滤取 `topK*5` 再 Worker 侧过滤 | 元数据索引未生效时，本用户命中可能被其他 scope 的近似向量挤出 | 明确索引就绪检查/skip；或按用户独立索引 |
| R14 | P2 | 错误与可观测性弱 | 500 返回 `String(e).slice(0,500)`（`4552-4553`）；仅 17 处 console；每轮 `CHAT_TOOLS` 日志（`2386`） | 线上排障靠猜；无 request id / 错误码 / 指标 | 结构化错误 + request id + 关键路径计数 |
| R15 | P3 | 重复查询与冗余 open | `/capabilities` 两次 `COUNT(*)`（`4044-4046`）；`/kb/prefetch` 两次检索（`3738-3744`）；`createShare` 两次 `open()`（`2986-2987`） | 轻微 CPU/请求放大 | 随手清理 |

## 9. 测试与可观测性现状

- 用例：`tests/api/api.test.ts` 24 个 describe、`multiuser.test.ts` 1 个；单测覆盖 `entries/format/rich/theme/sessionTree/template/kernel`。
- 测试配置 `wrangler.test.jsonc` 关闭 `AI` / `KB_VEC`，因此向量路径只测了"未配置时回退"，没有测 >100 段、索引补齐、跨 scope 过滤。
- 没有真实模型调用、SSE 流、并发提交、MCP 连接、分享页冷启动的用例。
- 日志只有 `console.log/warn`；无请求 ID、无耗时、无 DO 请求计数。`docs` 中的 128 条是当前金标总数。

## 10. 演进顺序

1. **先立规则**：`docs/adr/0001-layering.md` 已接受；阶段 0b 落地 `scripts/check-layering.sh` 并接入 CI（路由目录禁止出现 SQL/`sqlFacade`）。
2. **小切口收益**：分享页零 Harness（R2）、`/api/bootstrap`（R3）、向量索引补齐（R7）。
3. **结构性拆分**：按会话/文件 → 知识库 → 分享 → 设置/审批/自动化的顺序抽 Service/Repository（R1），每个 PR 不含行为变更。
4. **数据生命周期**：迁移器（R4）、删除级联与用户吊销（R6/R10）、备份事务化（R8）。
5. **再谈并发与可观测性**：会话锁（R12）、结构化日志（R14）。

风险编号（R1/R2/...）在后续 issue 与 PR 中直接引用。

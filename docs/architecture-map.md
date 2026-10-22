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

阶段 6 收口后的最终布局（`src/worker.ts` 1165 行，只保留组合根）：

```text
src/worker.ts                Worker 鉴权 + SpikeAgent / UserRegistry 组合根（open/alarm/端口装配）
src/worker/bootstrap.ts      首屏聚合的容错编排（17 个面板）
src/worker/db/migrations.ts  业务库与注册表库的版本化 DDL（唯一 DDL 入口）
src/worker/http/             context / errors / router / ports
src/worker/routes/           14 个域文件 + index 路由表（零 SQL）
src/worker/services/         24 个域服务与外部适配器（零 Response、零 Harness 类型）
src/worker/repo/             19 个仓储（只做 SQL）
src/worker/tools/            模型工具扩展（显式依赖，按请求构造）
src/worker/lib/              8 个纯函数模块（markdown、token、分块、审计…）
```

| 逻辑模块 | 位置（符号） | 职责 | 主要依赖 | 数据 |
|---|---|---|---|---|
| Worker 入口 / 鉴权 | `default export`、`authorizedUser`/`accessToken`/`userAccessSig`（`src/worker.ts`） | Cookie 解析、HMAC 签名、邀请码登录、主人/邀请用户分流、DO 路由 | `ACCESS_PASSWORD`、`UserRegistry` | 无 |
| UserRegistry DO | `class UserRegistry`（`src/worker.ts`）+ `migrateRegistry`（`db/migrations.ts`） | 邀请码校验、用户 CRUD、吊销 | DO SQLite | `users` |
| SpikeAgent DO | `class SpikeAgent`（`src/worker.ts`） | 用户状态所有者、RPC 入口、Harness 生命周期、alarm、按请求装配端口 | pi-durable、DO SQLite | 全部用户数据 |
| HTTP 路由层 | `http/context|errors|router`；`routes/index.ts` + 14 个域文件 | method/path 匹配、解析、状态码；未命中直接 404，无 legacy 兜底 | Service / 端口 | 无（零 SQL） |
| Agent 运行时 | `tools/spike-tools.ts`、`services/instructions-service.ts`、`services/chat-service.ts` | 工具定义与审批包装、系统提示、chat/SSE 共用提交路径 | Harness、LLM、MCP、Service | Harness 表 |
| 会话与文件 | `routes/session|files.ts` → `services/session|file-service.ts` → `repo/sessions|files-repo.ts` | 会话列表/分支/删除、工作台文件 | 服务/仓储、Harness | `sessions_meta`、`vfs_v2` |
| 知识库 | `routes/kb.ts` → `services/kb-service.ts` → `repo/kb-repo.ts`；`lib/kb.ts` | 分块、FTS5、向量索引、混合检索、预检索、ingest | AI、Vectorize | `kb_docs/kb_chunks/kb_fts` |
| 分享 | `routes/share.ts` → `services/share-service.ts` → `repo/shares-repo.ts`；`lib/share-render.ts` | token、SSR 分享页、主题/目录、过期；`/s/*` 零 Harness | `shares`、`vfs_v2`、Harness（仅会话分享） | `shares` |
| 定时任务与目标 | `routes/automations.ts` → `services/automation|goal|plan-service.ts` → 对应 repo | alarm 调度、token 预算、自动续转 | `automations`、`goals`、`plans` |
| 审批与问答 | `routes/approvals.ts` → `services/approval|question-service.ts` → 对应 repo | 工具审批闸门、ask_user 卡片 | `approvals`、`approval_grants`、`questions` |
| 设置 / 供应商 / MCP | `routes/settings|capabilities.ts` → `services/settings|mcp|custom-tool|capability-service.ts` → 对应 repo | 设置、OpenAI 兼容端点、MCP、自定义工具 | `app_settings`、`providers`、`mcp_servers`、`custom_tools` |
| 系统 | `routes/system.ts` → `services/bootstrap|kernel-service.ts` | `/version`、`/bootstrap`、`/debug/agent`、`/kernel` | `repo/*`、DO 调试端口 | 只读 |
| 数据 | `routes/data.ts` → `services/data|memory|reflect-service.ts` | `/backup`、`/restore`、`/export`、`/memories`、`/reflect` | 全部业务表、Harness（导出/反思） | 全部业务表 |
| 提示模板 / 规则 | `routes/prompts.ts` → `services/prompts-service.ts` → `repo/prompts-repo.ts` | prompts / rules / custom-tools 的 CRUD | 规则注入 instructions | `prompts`、`rules`、`custom_tools` |
| 静态资产 | `wrangler.jsonc:8-10` | SPA fallback、静态文件 | Cloudflare Assets | `dist-web` |

## 3. 接口面

Worker 剥掉 `/api` 或 `/agent` 前缀后转发给 DO（`default export`），因此 DO 内部路径是 `/sessions`、`/chat/stream` 这类短路径。路由表由 `routes/index.ts` 汇总 14 个域文件；`matchRoute` 未命中直接返回 404 `{error:"not found"}`（阶段 6 起没有 legacy 兜底），`/` 与未知路径不触发 Harness。按域分组：

| 域 | 端点 | 备注 |
|---|---|---|
| 对话 | `POST /chat`、`POST /chat/stream`、`POST /interject`、`POST /abort`、`POST /reset`、`POST /compact` | 前端只用 SSE |
| 会话 | `GET/POST/PATCH/DELETE /sessions`、`POST /branches`、`GET /entries`、`GET /session` | 阶段 1 已离开 legacy：`routes/session.ts` → `session-service` → `sessions-repo`；`sessions_meta` 与 Harness 双写 |
| 首屏 | `GET /bootstrap` | 17 个只读面板聚合，单字段故障隔离；阶段 6 起 `routes/system.ts` → `bootstrap-service` |
| 文件 | `GET/DELETE /files`、`GET /files/content`、`GET /files/all` | 阶段 1 已离开 legacy：`routes/files.ts` → `file-service` → `files-repo` |
| 知识库 | `GET/POST/DELETE /kb`、`/kb/doc`、`/kb/search`、`/kb/prefetch`、`/kb/status`、`/kb/reindex`、`POST /kb/ingest` | 阶段 2 已离开 legacy：`routes/kb.ts` → `kb-service` → `kb-repo`；FTS / vector / hybrid |
| 分享 | `POST /share`、`GET /shares`、`GET /s/<token>` | `/s/` 公开 |
| 自动化 / 目标 | `GET/POST/PATCH/DELETE /automations`、`GET/POST/DELETE /goal` | alarm |
| 设置 / 模型 | `GET/POST /settings`、`GET/POST/DELETE /providers`、`POST /providers/activate`、`GET /models`、`POST /model`、`GET /context` | 改压缩/供应商会重建 Harness |
| 能力 / 工具 | `GET /tools`、`GET /capabilities`、`GET /mcp`、`POST/DELETE /mcp`、`/skills*`、`/custom-tools` | 工具清单；阶段 6 起 `/custom-tools` 与 `/prompts*`、`/rules*` 在 `routes/prompts.ts` |
| 审批 / 问答 | `GET/POST /approvals`、`GET/POST /questions` | |
| 数据 | `GET /backup`、`POST /restore`、`GET /export`、`GET/DELETE /memories`、`POST /reflect` | 阶段 6 起 `routes/data.ts` → `data|memory|reflect-service`；备份不含对话正文，`/restore` 可重入 |
| 系统 | `GET /version`、`GET /bootstrap`、`GET /debug/agent`、`GET /kernel` | 阶段 6 起 `routes/system.ts`；`debug` 会重建扩展 |

鉴权边界：

- `ACCESS_PASSWORD` 为空时一律视为主人（本地/开放模式，`authorizedUser`）。
- 邀请用户 token = `u_xxx.HMAC`；**每个请求**都会查一次 `UserRegistry` 确认用户未被删除（`authorizedUser` → `UserRegistry.fetch`）。
- `/s/` 不鉴权；新 token 前缀 `u_xxx.` 决定路由到哪个用户 DO，旧 token 落到主人 DO（`default export`）。

## 4. 依赖方向

现状（阶段 6 完成后）：

```text
Route（routes/*.ts，零 SQL）
  → Service（services/*.ts，显式依赖，零 Response / 零 Harness 类型）
      → Repository（repo/*.ts，只做 SQL）
          → DO SQLite
工具扩展（tools/spike-tools.ts）
  → Service / Repository（SQL、设置、KB、分享、Harness 全部显式注入）
DO（worker.ts）
  → Harness / MCP / Vectorize / LLM，并实现 http/ports 里的端口
```

- 路由层零 SQL；`scripts/check-layering.sh` 在 CI 中拦截回退（`routes` 禁止 `sqlFacade`/`sql.exec`，`services` 禁止 `Response`，`repo` 禁止反向依赖）。
- 组合根只做装配：`SpikeAgent.fetch` 建立 `RequestContext` 后交给 `dispatch`；`alarm()` 直接执行，不再包 `agentScope.run`。
- 工具扩展按请求构造并 install 到注册表（pi-durable 的 `configure` 只存扩展名，工具由注册表解析）；`share_file` 的 Origin 因此来自当前请求。
- 跨 DO 通信只有显式协议：Worker → `UserRegistry` 的 `/internal/verify-code`、`/internal/user-status`；Worker → 用户 DO 的 `/internal/revoke-user`、`/internal/user-backup`、`/internal/purge-user`（NERE-24，带 `x-pi-internal`，不在公开路由表）。其余都是 Worker 直连各用户 DO。

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
| `shares` | 公开分享 token | `shares-repo`（`share-service` 编排：`POST /share`、`share_file`/`share_conversation`） | 是 |
| `kb_docs` / `kb_chunks` / `kb_fts` | 知识库 + FTS 索引 | `kb-repo`（`kb-service` 编排：`/kb*`、`kb_add`/`kb_delete`、恢复） | 仅 `kb_docs`，恢复时重建分块/索引 |

表定义集中在 `db/migrations.ts`：业务库由 `migrate()` 在 DO 首次 `open()`/`alarm()` 执行一次，注册表库由 `migrateRegistry()` 在 `UserRegistry` 首次 `fetch` 执行一次。请求路径不再执行 DDL。

### 5.2 其他数据所有者

| 数据 | 所有者 | 说明 |
|---|---|---|
| 会话条目、用量、任务 | pi-durable Harness（同一 DO SQLite） | 表结构由依赖管理，应用代码不应直查；`/export` 是唯一出口（`exportMarkdown` @ `3445`） |
| 邀请用户 | `UserRegistry` DO（全局单实例 `registry`） | 只存 `users`，不含任何用户内容 |
| 向量 | Vectorize `pi-kb`（全局索引） | 派生数据，`id = <scope>:<chunkId>`，`scope` 由 `RequestContext.scopeId` 经端口传入（前缀与 metadata 过滤，写入 `kb-service` 的 `indexDoc`）；可重建 |
| 分享页 | `shares` + 请求时渲染 | 会话分享实时读 Harness 条目，不是快照 |

### 5.3 生命周期边界

- 删除会话：先删该会话的 `shares`，再清 `vfs_v2`、`plans`、`approvals`/`approval_grants`、`questions`、`entry_kb_refs`，最后标记 `deleted=1` 并暂停目标（NERE-24）；Harness 条目仍由 pi-durable 保留。
- 删除邀请用户：删 `UserRegistry.users` 一行，并经 `/internal/revoke-user` 删除该用户 DO 的全部 `shares`；`/s/*` 随即 404、旧 token 401，其余数据保留。显式 `/api/users/data?id=&confirm=` 才清空该 DO（NERE-24，ADR-0004）。
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

> 行号口径：R1/R4/R5/R11 已按 `ce75bce` 刷新；R3/R6-R14 的证据行号仍是 `64c9515` 基线，在其所属域迁移时重锚（阶段 4 顺手更新）。R2 已关闭，证据改为符号与用例名。引用风险时优先用符号名。

> 执行状态（2026-10-22）：ADR-0001 已转 Accepted；阶段 0a（迁移器）与 0b（路由表）已合并。阶段 1（会话/文件）已收口：`routes/session|files.ts` → `services/session|file-service.ts` → `repo/sessions|files-repo.ts`，`sessions_meta`/`vfs_v2` 在路由与工具中零内联 SQL。阶段 2（知识库）已收口：`routes/kb.ts` → `services/kb-service.ts` → `repo/kb-repo.ts`，纯函数在 `lib/kb.ts`；AI / Vectorize / settings / 抓取经端口注入，路由与工具零内联 SQL；R4 由 0a 关闭，R1/R11 由阶段 1-5 逐步关闭。阶段 3（分享）已收口：`routes/share.ts` → `services/share-service.ts` → `repo/shares-repo.ts`，渲染纯函数在 `lib/share-render.ts`，`/s/*` 不再 `open()` Harness（R2 关闭）。阶段 4（设置/供应商/MCP/自动化/审批/问答）已收口（NERE-32）：`routes/settings|automations|approvals|capabilities.ts` → `services/settings|automation|goal|plan|approval|question|mcp|custom-tool|capability-service.ts` → 对应 `repo/*-repo.ts`；`alarm()` 只保留 DO 入口，调度判断进 `automation-service`；`customToolNames` 与 `mcpCache` 搬入 `SpikeAgent` 实例，R5 关闭；这些表的 SQL 在 `src/worker.ts` 与路由中归零（备份/恢复也走仓储）。阶段 5（对话，NERE-33）已收口：`routes/chat.ts` → `services/chat-service.ts`，`/chat` 与 `/chat/stream` 共用 `prepare → submit → finish`，SSE 只做事件泵；目标续转、并发闸门、反射节流与标题策略进 Service，R11 关闭。
>
> **阶段 6（NERE-34）已收口**：`handleLegacyFetch` / `RequestContext.legacy()` / `sqlFacade` / `scope()` 全部删除；`src/worker.ts` 2654 → 1165 行，只剩组合根与鉴权。12 个遗留路径拆到 `routes/system|data|prompts.ts`，工具扩展迁到 `tools/spike-tools.ts`（显式依赖、按请求构造）。`scripts/check-layering.sh` 新增「`worker.ts` 禁止 DDL」「`worker/**` 禁止 `sqlFacade`/`ensureTables`/`scope(`」。R1/R4/R5/R11 全部关闭。

| ID | 级别 | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|---|
| R1 | P0 | ~~单文件单体~~ **已关闭（阶段 1-6，NERE-21）** | `src/worker.ts` 1165 行（基线 5249 行）；`routes/` 14 个文件、`services/` 24 个、`repo/` 19 个、`tools/` 1 个；`scripts/check-layering.sh` 在 CI 中强制边界，`routes` 零 SQL | 原风险：无法单测业务、合并冲突、改动半径不可控 | 6 阶段全部合并；验证：`npm test` 414 passed + `check-layering` 退出 0（阶段 6，NERE-34） |
| R2 | P1 | ~~公开分享页也会启动完整 Harness~~ **已关闭（阶段 3，NERE-31/NERE-22）** | `routes/share.ts`（`GET /s/` 标 `needsHarness: false`）；`services/share-service.ts` 的 `render()` 在 `shareRuntime.entries()` 之前处理 404/410/文件分支；DO 的 `harnessOpens` 计数只在 `open()` 成功时自增（`TEST_HARNESS_STATS=1` 暴露 `GET /debug/harness`） | 原风险：冷启动分享页要建扩展/MCP/Harness；MCP 不可用时分享也可能变慢/失败 | 验证：`tests/api/share-cold.test.ts` 在空 persist 上把首个 DO 请求打成 `GET /s/doesnotexist`，断言 404 且 `opens` 仍为 0；文件分享读页前后计数不变（同一用例先让 `/api/restore` 触发 `open()` 自证观测点）；会话分享仍渲染 `thread`。渲染契约由 `tests/unit/share-render.test.ts` 钉住（打印按钮/`@media print`、Deploy 出口、演示横条） |
| R3 | P1 | 首屏 18 个 API 请求，全部进同一个单线程 DO；邀请用户每次再查一次全局 registry | `App.tsx:160-260, 638-1050`；`worker.ts:4637`、`4600-4613` | 首屏延迟 = 18 次串行 DO 往返；registry 成为全站串行点 | 已落地 `GET /api/bootstrap`（NERE-23）：后端只读面板合并为 1 个请求，registry 查询随面板数收敛为每请求一次；前端切换后首屏为 bootstrap + auth 两个请求 |
| R4 | P1 | ~~schema bootstrap 顺序脆弱~~ **已关闭（阶段 0a/6）** | DDL 只在 `db/migrations.ts`：业务库 `migrate()`、注册表库 `migrateRegistry()`；`worker.ts` 无 `CREATE TABLE`/`ALTER TABLE` | 原风险：全新 DO 首次 `open()` 只有 4 列、请求路径重复建表 | 版本化迁移 + 空库首启测试：`tests/unit/migrations.test.ts`、`tests/api/api.test.ts`「空库首启」 |
| R5 | P1 | ~~跨 DO 的模块级可变状态~~ **已关闭（阶段 4，NERE-32）** | `customToolNames` / `mcpCache` 已从模块级搬入 `SpikeAgent` 实例字段；构建器改为显式收缓存：`services/custom-tool-service.ts` `buildExtension(sql, customToolNames)`、`services/mcp-service.ts` `buildExtension(sql, cache)`；`/tools` 的工具分级经 `toolRuntime.customNames()` 读实例集合 | 原风险：同 isolate 多用户时自定义工具分类与 MCP client 互相覆盖 | 验证：`tests/unit/custom-tool-r5.test.ts`（两个集合/缓存互不覆盖，预置缓存不建连接）；`tests/api/multiuser.test.ts`「阶段 4」用例（主人 `owner_probe` 不出现在邀请用户的 `/api/custom-tools` 与 `/api/tools`，分类为 exec） |
| R6 | P1 | ~~删除用户不吊销数据与分享~~ **已关闭（NERE-24）** | `services/user-admin-service.ts`（注册表删除 → `/internal/revoke-user`）；`services/user-lifecycle-service.ts`（删全部分享、保留数据、显式 purge）；`routes/internal.ts` | 原风险：被吊销用户的公开链接继续可读 | 吊销立即 404/401，数据默认保留；验证：`tests/api/multiuser.test.ts`「用户吊销生命周期」 |
| R7 | P1 | 大规模知识库的向量索引只建前 100 段 | `986`（`LIMIT 100`）；`3712-3717` 只调一次；`1002-1023` 手动重建 | 20 万字符文档约 270 段，尾部在 vector 模式下永远检索不到，status 只显示比例 | 批量循环或 alarm 续建；`/kb/status` 暴露 pending；补 >100 段用例 |
| R8 | P1 | 备份/恢复把全部文件正文与供应商 key 装进一个 JSON，恢复无事务 | `2809-2834`；`2835-2977` | DO 内存与响应体积随文件增长；恢复中途失败留下半套数据 | 流式/按域导出；恢复用事务或可重入游标；key 默认脱敏 |
| R9 | P2 | 会话元数据与 Harness 会话双源，靠读时修复 | `2553-2580` | 两侧漂移时列表/删除/分享行为不一致 | 明确唯一真源；把 `sessions_meta` 降级为索引或在迁移中重建 |
| R10 | P2 | **部分关闭（NERE-24）**：会话删除已级联 `shares/plans/approvals/questions/entry_kb_refs`，用户删除已清全部分享；Harness 条目仍保留 | `services/session-service.ts` 的 `remove()`；`services/user-lifecycle-service.ts`；`routes/internal.ts` | 原风险：`shares/plans/approvals/questions` 长期堆积 | 剩余：会话删除后的 Harness 条目与 `goals/automations` 清理，需要 pi-durable 删除接口或定期清理 alarm |
| R11 | P2 | ~~流式与非流式对话是两套实现~~ **已关闭（阶段 5，NERE-33）** | `services/chat-service.ts` 的 `prepare` / `submit` / `finish`；`routes/chat.ts` 的 `/chat` 与 `/chat/stream`；DO 只剩 `chatRuntime()` 端口（open/重试、conversation、configure、watchEvents、reflect） | 原风险：标题、目标续转、工具摘要逻辑漂移 | 合并为单一 ChatService，非流式复用同一提交路径；验证：`tests/api/share-tools.test.ts`「对话提交路径（NERE-33）」断言同一输入下流式/非流式 answer 与 `sessions_meta.title` 相同 |
| R12 | P2 | 入站对话没有并发闸门；`activeChats` 只挡 alarm | `2347-2362`、`3371-3383`；检查点仅 `2693/2721`；SSE 在 `3539` 之后继续 | 同会话两个请求可能交错 submit，是否被 Harness 拒绝取决于依赖行为（**未验证**） | 显式会话锁或 409；补并发用例 |
| R13 | P2 | 向量过滤回退可能被其他用户结果挤占 | `966-979`：先 filter，空则无过滤取 `topK*5` 再 Worker 侧过滤 | 元数据索引未生效时，本用户命中可能被其他 scope 的近似向量挤出 | 明确索引就绪检查/skip；或按用户独立索引 |
| R14 | P2 | 错误与可观测性弱 | 500 返回 `String(e).slice(0,500)`（`4552-4553`）；仅 17 处 console；每轮 `CHAT_TOOLS` 日志（`2386`） | 线上排障靠猜；无 request id / 错误码 / 指标 | 结构化错误 + request id + 关键路径计数 |
| R15 | P3 | 重复查询与冗余 open | `/capabilities` 两次 `COUNT(*)`（`4044-4046`）；`/kb/prefetch` 两次检索（`3738-3744`） | 轻微 CPU/请求放大 | 随手清理；分享域的重复 `open()` 已在阶段 3 去掉（`createShare` 的两次 `open()` 合并为 `shareRuntime.conversationId()` 一次） |

## 9. 测试与可观测性现状

- 用例：36 个测试文件、414 passed（`tests/api/*` 7 个、`tests/unit/*` 29 个）；接口金标覆盖会话/设置/供应商/技能/记忆/备份/导出/分享/多用户；单测覆盖 entries/format/rich/theme/sessionTree/template/kernel/迁移/分层路由表。
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

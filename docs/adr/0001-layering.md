# ADR-0001：后端分层规范（Route → Service → Repository → DO）

- 状态：提案（Proposed）
- 日期：2026-10-21
- 决策人：后端架构-hou（NERE-18）
- 范围：`src/worker.ts` 及后续拆出的后端模块
- 关联：`docs/architecture-map.md`（现状与 R1-R15 风险编号）、[`docs/adr/0002-frontend-layering.md`](./0002-frontend-layering.md)（前端分层）

## 背景

后端目前是一个 4856 行的 `src/worker.ts`：78 个 HTTP 端点、41 个 DO 方法、21 张表的 DDL 与 131 处 SQL 调用混在同一文件。路由 handler 内联了 43 处 SQL（`worker.ts:3575-4553`），模块级 helper 通过 `sqlFacade` 这个 AsyncLocalStorage 代理隐式取库（`worker.ts:52-57`），导致：

- 业务逻辑无法在 DO 之外单测，任何查询都要构造完整请求作用域。
- 依赖方向不可见：路由既能直接 SQL，也能调 DO 方法，还能调工具 helper；同一件事有三种写法。
- 改动半径大：所有后端功能都落在同一文件，任意后端 PR 都会触碰它，评审与回滚都只能整文件进行。
- 迁移逻辑在请求路径重复执行（51 次 `ensureTables`），且顺序脆弱（R4）。
- 跨 DO 的模块级可变状态（`customToolNames`、`mcpCache`）构成隔离隐患（R5）。

前端同样需要一条明确的分层边界，但前端细则由前端架构-qian 维护；本 ADR 只锁定与后端契约相关的部分。

## 决策（后端）

采用四层，依赖只能向下：

```text
Route（HTTP）
  ↓
Service（用例）
  ↓
Repository（SQL）
  ↓
Durable Object / SQLite / 外部适配器
```

### 1. Route 层：只做 HTTP

位置：`src/worker/routes/*.ts`，由 `src/worker/routes/index.ts` 汇总为路由表。

允许：method/path 匹配、读取 cookie/header、解析 JSON、基础校验、选择 Service、把 Service 结果映射为状态码/响应头。

禁止：

- 任何 SQL 字符串或 `sqlFacade`。
- 任何 `open()`/Harness/LLM/MCP/Vectorize 调用。
- 业务分支（例如"删除会话时顺带暂停目标"属于 Service）。
- 直接拼接外部错误文本；统一抛 `AppError`。

路由表形态（示意）：

```ts
type Route = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;                       // DO 内部短路径，如 "/sessions"
  handle(ctx: RequestContext): Promise<Response>;
};
```

`SpikeAgent.fetch` 只负责建立 `RequestContext`（sql、harness 惰性句柄、env、scopeId、userId）并交给路由表；`UserRegistry.fetch` 同理。

### 2. Service 层：用例与编排

位置：`src/worker/services/*.ts`，按领域一份：

| Service | 覆盖现状路径/方法 | 备注 |
|---|---|---|
| `chat-service` | `/chat`、`/chat/stream`、`/interject`、`/abort`、`/reset`、`/compact` | 合并 R11 的两套实现 |
| `session-service` | `/sessions*`、`/branches`、`/entries`、`/session` | 会话元数据与 Harness 的唯一协调点 |
| `file-service` | `/files*` | `vfs_v2` |
| `kb-service` | `/kb*` | 分块、FTS、向量、预检索 |
| `share-service` | `/share`、`/shares`、`/s/` | 渲染可作为纯函数单独存在 |
| `automation-service` | `/automations*`、`alarm`、目标续转 | 调度策略 |
| `settings-service` | `/settings`、`/providers*`、`/models`、`/model` | 触发 Harness 重建 |
| `memory-service` | `/memories*`、`/reflect` | |
| `approval-service` | `/approvals*`、审批闸门 | |
| `question-service` | `/questions*`、`ask_user` | |
| `user-service` | `/internal/*`、用户 CRUD、吊销 | UserRegistry 与用户 DO 的跨 DO 协议 |

规则：

- Service 接收显式依赖：`{ sql, harness(), env, scopeId }`，不读模块级全局。
- Service 可以组合多个 Repository，但不直接写 SQL。
- Service 负责事务边界、幂等键、级联清理与生命周期。
- 长耗时工作（向量补齐、反思、alarm 续转）由 Service 决定是否 `waitUntil`/写 `next_run_at`。
- 工具扩展（`defineTool`）只能调用 Service 或 Repository，不允许内联 SQL；审批包装在工具边界完成，不进入 Service。

### 3. Repository 层：只做 SQL

位置：`src/worker/repo/*.ts`，按聚合一份（`sessions-repo`、`files-repo`、`kb-repo`、`shares-repo`、`settings-repo`、`approvals-repo`、`automations-repo`、`providers-repo`、`memory-repo`）。

- 输入/输出都是类型化记录，不返回 `Response`，不抛 HTTP 语义错误。
- 每个表只有一个写入口；跨表写由 Service 组合（必要时传事务句柄）。
- 允许 Repository 暴露 `listX`、`getX`、`upsertX`、`deleteX`、`countX`；禁止在 Repository 里做权限判断或格式化。
- 迁移与 DDL 不属于 Repository 的运行时职责，见第 6 节。

### 4. DO 层：组合根与状态容器

- `SpikeAgent` 只保留：构造/惰性 `open()`、`fetch` 包装 `agentScope`、`alarm` 包装作用域、Harness 生命周期（`open`/`close`/`recover`）、把依赖注入给路由与 Service。
- `UserRegistry` 同样拆 route/service/repo，但它不加载 Harness。
- **不拆 DO**。本次分层是代码边界，不是部署边界；保持每用户单 DO 的事务与一致性。跨 DO 只允许显式、类型化的 `fetch` 协议（当前为 `/internal/verify-code`、`/internal/user-status`）。

### 5. 依赖规则（可自动检查）

1. `routes/**`：禁止出现 `sql`、`sqlFacade`、`Harness`、`fetch(`、`vectorUpsert`。
2. `services/**`：禁止出现 `Response`、`Request`、`crypto.subtle`（鉴权 crypto 属于 `auth/`）、直接 `fetch(`（外部适配器除外）。
3. `repo/**`：禁止 import `services`/`routes`，禁止 `Response`、`fetch`、`Math.random`（token 在 Service 生成）。
4. `worker.ts` / `do/**`：只允许 import routes、services 的入口与共享纯函数；不允许定义业务 SQL。
5. 工具扩展文件：只允许 import services/repo，不允许 `sqlFacade`。
6. 共享纯函数（markdown 渲染、token 编码、RRF、分块）放在 `src/worker/lib/`，不得 import 上述任一层。
7. 单一写者：每张表在 `architecture-map.md` 第 5 节登记唯一写入口。

CI 用 grep 检查即可（无需引入新框架）：

```bash
! grep -rE "sqlFacade|\bsql\.exec\(" src/worker/routes
! grep -rE "new Response|Response\.json" src/worker/services src/worker/repo
! grep -rE "sqlFacade" src/worker/extensions
```

### 6. 迁移与 schema

- 新增 `src/worker/db/migrations.ts`，按版本号有序执行，记录到 `schema_migrations(version, applied_at)`。
- 请求路径不再调用 `ensureTables`；只在 DO 首次 `open()` 时执行一次 `migrate(sql)`。
- 迁移必须先 `CREATE TABLE` 再 `ALTER TABLE`；不允许吞掉非"列已存在"的错误。
- 每个迁移必须能在空库上从 0 跑到最新；CI 增加"空 persist 首次请求"用例。

### 7. 错误、幂等与限额

- `AppError { code, status, message, retryable }`；Route 统一映射，禁止把内部异常原文直接回给客户端。
- 写操作明确幂等语义：`POST /sessions`、`POST /share` 允许重复创建；`POST /restore` 必须可重入；`POST /chat` 不承诺幂等，需前端去重。
- Service 内显式声明 DO 子请求/存储限额假设（例如向量索引每批 100 段、备份不分页的上限）。
- 每个外部调用（LLM/MCP/Vectorize/AI）必须有超时或降级路径；分享、设置读取等只读路径不得因外部服务不可用而失败。

### 8. 前端半（由前端架构-qian 补充）

已对齐的边界，仅约束跨端契约：

- 页面层（`App.tsx` 及路由级组合）负责会话选择与面板编排，不直接 `fetch`。
- 特性层按域拆（chat、sessions、files、knowledge、settings），持有该域的 UI 状态与副作用。
- 基础 UI 层（`components/`）无网络、无全局状态。
- hooks/状态层（`lib/`）封装 API 客户端与可复用状态；所有请求走 `lib/api.ts`。
- 首屏聚合接口（`/api/bootstrap`）落地后，页面层只保留一个引导请求；变更类操作仍走各自端点。

前端具体目录、状态归属与组件树由前端架构-qian 在 `docs/frontend-map.md` 与其 ADR 补充；本 ADR 不替前端定组件边界。

## 迁移步骤

每个步骤单独 PR、不含行为变更、测试全绿后再进入下一步：

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 建 `routes/` + `RequestContext` + `AppError` + 迁移器骨架；原逻辑原样搬入 | 端点行为不变；空库首启通过 |
| 1 | `session-service` + `file-service` + 对应 repo | 路由层不再有 `sessions_meta`/`vfs_v2` SQL |
| 2 | `kb-service` + `kb-repo`（含向量补齐） | `/kb*` 路由零 SQL |
| 3 | `share-service` + 渲染纯函数 | `/s/` 文件分享不启动 Harness |
| 4 | `settings/providers/mcp/automations/approvals/questions` | 对应路由零 SQL |
| 5 | `chat-service` 合并流式/非流式；DO 只留组合根 | `chat` 与 `chat/stream` 共用提交路径 |
| 6 | 删除 `sqlFacade` 与 `ensureTables` 请求路径调用 | CI 边界检查通过 |

约束：

- 不与功能 PR 混做；每个 PR 限定一个域，避免与 NERE-17（KB ingest）、NERE-8（分享工具）等并行改动冲突。
- 不做全文件格式化；评审用 `git diff -w` 看语义变更。
- 每阶段保留原端点与响应结构，前端无需同步改动。

## 后果

正面：

- Service 可用 fake repository 单测；路由可用纯函数测校验与状态码。
- 依赖方向由 CI 强制，新增功能不会再往路由里塞 SQL。
- 分享、鉴权、向量等热点路径可以独立优化而不牵动全局。
- 迁移可回放，空库首启可验证。

负面：

- 文件数增加、初期有转发层；需要团队遵守边界，否则会退化成"薄 Service + 胖 Route"。
- 迁移期间 PR 冲突成本上升，必须按域串行合并。
- 不拆 DO，单用户热点仍在同一 DO；本 ADR 不解决横向扩展，只解决可维护性与失败半径。

## 备选方案

1. **保持单文件**：改动最快，但已出现 43 处内联 SQL 与跨 DO 全局状态；否决。
2. **按功能拆成多个 DO**：请求放大、跨 DO 事务丢失、免费额度下子请求成本上升；否决。分层不需要拆部署单元。
3. **引入 RPC 框架（tRPC/oRPC）**：当前只有同源 HTTP 与内部 DO 协议，收益不足以抵消依赖与类型生成成本；否决。
4. **只做 lint 规则不拆文件**：规则无法消除已有耦合；作为阶段 0 的辅助手段保留。

## 回滚

- 每个阶段独立 PR，回滚即 revert 该 PR；无 schema 破坏性变更（阶段 0 的迁移器只新增 `schema_migrations`）。
- 若拆分导致线上问题，保留原 `worker.ts` 路由作为开关回退一个发布周期，再移除。

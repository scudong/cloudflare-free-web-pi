# ADR-0001：后端分层规范（Route → Service → Repository → DO）

- 状态：已接受（Accepted，2026-10-21 起按阶段执行，跟踪 NERE-21）
- 日期：2026-10-21
- 决策人：后端架构-hou（NERE-18）
- 范围：`src/worker.ts` 及后续拆出的后端模块
- 关联：`docs/architecture-map.md`（现状与 R1-R15 风险编号）、[`docs/adr/0002-frontend-layering.md`](./0002-frontend-layering.md)（前端分层）

## 背景

后端目前是一个 5249 行的 `src/worker.ts`（基线 `ce75bce`）：81 个 method+path 分支、21 张表的 DDL 与 210 处 `sqlFacade` 调用混在同一文件。`SpikeAgent.handleFetch`（`worker.ts:3903-4948`，1046 行）内含 **105 处 `sqlFacade`**、**52 次 `ensureTables`**；模块级 helper 通过 `sqlFacade` 这个 AsyncLocalStorage 代理隐式取库（`worker.ts:46-61`），导致：

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

- 新增 `src/worker/db/migrations.ts`，按版本号有序执行，记录到 `schema_migrations(version, name, applied_at)`。
- 请求路径不再调用 `ensureTables`；只在 DO 首次 `open()` 时执行一次 `migrate(sql)`。
- 本阶段只收口 `SpikeAgent` 的 DDL；`UserRegistry` 自己库里的 `users` 建表仍在其 `db()`，随阶段 0b 的路由层收口一起处理。
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
| 0a | `db/migrations.ts` 版本化迁移器；删除请求路径的 52 次 `ensureTables` | 空库首启一次得到完整 schema；`migrations.test.ts` 通过 |
| 0b | `routes/` 路由表 + `RequestContext` + `AppError` + `scripts/check-layering.sh`；未迁移端点走 legacy 委托 | 端点行为不变；CI 边界检查上线且为绿 |
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

## 9. 阶段 0 实施契约（2026-10-21 锁定）

后续阶段依赖以下签名，改动需新开 ADR。基线 `ce75bce`。

### 9.1 目录

```text
src/worker/
  db/migrations.ts        迁移清单与 migrate(sql)
  http/context.ts         RequestContext 构造
  http/errors.ts          AppError / toResponse
  http/router.ts          Route 类型与 matchRoute
  routes/index.ts         路由表（按域分文件后在此汇总）
  routes/<domain>.ts      session / file / kb / share / settings / ...
  services/<domain>.ts
  repo/<domain>.ts
  lib/*.ts                纯函数（markdown、token、RRF、分块）
src/worker.ts             DO 组合根 + 未迁移端点的 legacy handler
```

`src/worker/bootstrap.ts`（NERE-23 引入）是只读聚合 helper，不属于 route/service/repo 任一层，阶段 0b 不改它。

### 9.2 RequestContext

```ts
export type AppEnv = {
  DEEPSEEK_API_KEY?: string;
  ACCESS_PASSWORD?: string;
  AI?: unknown;
  KB_VEC?: unknown;
  CF_DISABLE_VECTOR?: string;
  DEEPSEEK_BASE_URL?: string;
  BUILD?: string;
  SpikeAgent: DurableObjectNamespace;
  UserRegistry: DurableObjectNamespace;
};

export type RequestContext = {
  readonly req: Request;
  readonly url: URL;
  readonly env: AppEnv;
  readonly scopeId: string;
  readonly userKey: string;
  readonly origin: string;
  sql(): SqlHandle;                 // 已执行迁移的句柄；调用前 dispatch 已 await ready()
  ready(): Promise<void>;           // 只跑迁移（ensureMigrated），不建 Harness
  harness(): Promise<Harness>;      // 惰性 open（内部含 ready）；只有需要的端点调用
  legacy(): Promise<Response>;      // 阶段 0/1-4 的过渡委托，阶段 6 删除
};
```

- Route：`{ method, path, needsHarness: boolean, handle(ctx): Promise<Response> }`；`matchRoute` 先于 DO 初始化执行。
- **dispatch 对每个命中路由先 `await ctx.ready()`，再按 `needsHarness` 决定是否 `await ctx.harness()`。** 迁移与 Harness 是两件事：阶段 3 把 `/s/*` 标成 `needsHarness: false` 后，分享页仍要读 `shares` 表，`sql()` 必须已经可用；把迁移绑在 `open()` 上会让冷启动分享页拿到未建表的库。
- 阶段 0b 所有现存端点 `needsHarness: true`（与现状"每个请求先 `open()`"等价）；阶段 3 起 `/s/*` 与只读端点按实测改为 `false`，这是 NERE-22 的落地方式，不另写实现。
- `agentScope`/`scope()` 保留为兼容层，供尚未迁移的模块级 helper 使用；**新代码不得调用 `scope()`**，阶段 6 删除。

### 9.3 AppError

```ts
export class AppError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryable = false);
}
export function toResponse(err: unknown): Response;
```

| 情形 | status | body |
|---|---|---|
| 入参校验失败 | 400 | `{ error }`（沿用现有中文文案） |
| 资源不存在 | 404 | `{ error: "not found" }` |
| 冲突 / 前置状态不满足 | 409 | `{ error }` |
| 上游超时 | 504 | `{ error, retryable: true }` |
| 未知异常 | 500 | `{ error: String(e).slice(0, 500) }` |

阶段 0 只抽类型与映射函数，**响应文案与状态码逐字保持**（含 500 的截断文本）；错误信息收敛到阶段 6，单独 PR，改动需列出受影响端点。

### 9.4 迁移器

```ts
type Migration = { version: number; name: string; up(sql: SqlHandle): void };
export const MIGRATIONS: readonly Migration[];
export function migrate(sql: SqlHandle, now?: () => string): number; // 返回本次应用条数
```

- 账本表：`schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`。
- 按 version 升序执行，每条执行成功后写账本；`SqlHandle` 没有事务入口，因此**每条迁移必须自身幂等**（`IF NOT EXISTS`、`INSERT OR IGNORE`、只容忍 `duplicate column name`）。
- **已应用的迁移不可编辑，只能追加新版本**：账本不会重跑旧版本，改 v1 的 SQL 会让老库永远落后且零报错。`MIGRATIONS` 的 version 必须唯一且严格递增，模块加载时断言。
- v1 = 现行 schema 全量，**先 CREATE 后 ALTER**：修掉 `sessions_meta` 现在"先 ALTER 后 CREATE、空库 ALTER 全被吞"导致首请求缺 `deleted/model/hidden/parent_id/fork_at` 的顺序缺陷。v1 必须覆盖 `ensureTables` 的全部对象，不只是表：
  - 20 张表：`pi_mem`、`vfs_v2`、`sessions_meta`、`skills`、`shares`、`automations`、`mcp_servers`、`reflect_state`、`app_settings`、`plans`、`prompts`、`rules`、`kb_docs`、`kb_chunks`、`goals`、`questions`、`custom_tools`、`approvals`、`approval_grants`、`providers`
  - 普通索引 `kb_chunks_doc`
  - FTS5 虚拟表 `kb_fts(title_tokens, body_tokens)`（`CREATE VIRTUAL TABLE`，`PRAGMA table_info` 看不到，必须单独断言可用）
  - 4 条补列：`shares.expires_at`、`shares.theme`、`kb_chunks.vectorized`、`pi_mem.source`
- v2 = `vfs_files` → `vfs_v2`（根会话 `'1'`）数据搬迁，`INSERT OR IGNORE` 后 `DROP TABLE IF EXISTS`。
- DDL **原文照抄，只调整顺序**：列名、类型、`NOT NULL`、`DEFAULT`、主键、`AUTOINCREMENT` 不得改动（例如 `sessions_meta.model ... DEFAULT 'deepseek-flash'`、`kb_chunks.vectorized ... DEFAULT 0`）。默认值漂移即行为变更。
- 必须对**已有数据的老库**幂等：线上库 `schema_migrations` 为空，首次执行 v1 会跑全部语句，`CREATE ... IF NOT EXISTS` 幂等、补列靠 `duplicate column name` 容忍；v2 在 `vfs_files` 已删的库上是 no-op。
- 一条 `exec` 只放一条语句（与现行 `ensureTables` 一致），避免依赖 DO `exec` 的多语句行为。
- 唯一入口 `ensureMigrated()`：`SpikeAgent` 上 `private migrated: Promise<void> | null`，`open()` 与 `alarm()` 先 await；请求路径**不再**出现 `ensureTables`。
- 不允许在迁移里读 `env`/发起网络请求；向量回填仍由既有后台任务负责。

### 9.5 验收测试

1. `tests/unit/migrations.test.ts`：用 `node:sqlite`（CI 的 Node 22 最新版实测 22.23.3，无需 `--experimental-sqlite`，只会打一条 ExperimentalWarning）在 `:memory:` 跑真 SQLite，断言空库一次 migrate 后 `PRAGMA table_info(sessions_meta)` 含 `deleted/model/hidden/parent_id/fork_at`；二次 migrate 返回 0；`schema_migrations` 行数等于 `MIGRATIONS.length`；预置 `vfs_files` 后迁移数据进入 `vfs_v2` 且旧表消失；`kb_fts` 可 `INSERT` + `MATCH` 查到行；`PRAGMA index_list(kb_chunks)` 含 `kb_chunks_doc`；对已含全部列的库再跑 v1 不抛错。
2. `tests/api/api.test.ts` 增加"空 persist 首请求"：`rmSync(tests/.tmp-state)` 后第一个 DO 请求为 `GET /api/sessions`，必须 200 且 `sessions` 元素带 `model` 字段定义（无会话时至少断言 200 与数组类型）。
3. `npm test` 全绿（现有金标 + 上述新增）。

### 9.6 CI 边界检查

`scripts/check-layering.sh`，在 `.github/workflows/deploy.yml` 的 test job 中 `npm test` 之前执行；目录不存在时跳过（阶段 0a 先落地，阶段 0b 起生效）：

```bash
fail=0
chk() { [ -d "$1" ] && grep -rEn "$2" "$1" --include='*.ts' && fail=1; return 0; }
chk src/worker/routes   'sqlFacade|sql\.exec\('
chk src/worker/services 'new Response|Response\.(json|redirect)|^\s*import .*routes/'
chk src/worker/repo     'new Response|Response\.(json|redirect)|from "\.\./services|from "\.\./routes'
[ "$fail" = 0 ] || { echo "分层边界检查失败"; exit 1; }
```

`worker.ts` 在阶段 6 前仍含 SQL，规则 6 的"worker.ts 不得定义业务 SQL"从阶段 6 开始启用。

### 9.7 执行顺序与并行冲突

| 顺序 | 阶段 | 前置 | 冲突面 |
|---|---|---|---|
| 1 | 0a 迁移器 | 无（可立即开） | `worker.ts:46-153`、`open()/alarm()`；PR #17 不碰这段 |
| 2 | 0b 路由表 | 0a 合并 + PR #17 合并 | `handleFetch` 全段；#17 正在改 12 处 route hunk，必须先合 |
| 3 | 1 会话/文件 | 0b | `/sessions*`、`/files*` |
| 4 | 2 知识库 | 1 | `/kb*`；NERE-17 已合并，可动 |
| 5 | 3 分享 | 2 | `/share`、`/shares`、`/s/`；**吸收 NERE-22** |
| 6 | 4 设置/供应商/MCP/自动化/审批/问答 | 3 | 同时把 `customToolNames`（`worker.ts:350`）与 `mcpCache`（`worker.ts:2063`）从模块级搬入 DO 实例，消除 R5 跨 DO 串数据 |
| 7 | 5 chat 合并 | 4 或 0b（可与 2-4 并行，但同一 PR 只做这一域） | `runChat`（2702-2769）/`runChatStream`（3699-3875） |
| 8 | 6 收口 | 全部 | 删除 `sqlFacade`/`ensureTables`/`scope()` |

## 9.8 产品需求插入顺序（operator 2026-10-22）

后端只有一名成员，同一时刻只允许一个改 `src/worker.ts` 的 run。分层阶段之间按下面顺序插入 W3 产品需求，派发前先查有没有未合并的 W3 后端 PR：

| 插入点 | 产品需求 | 之后才启动 |
|---|---|---|
| 阶段 2 合并后 | NERE-40（W3-1 kbRefs，命中随消息落库） | 阶段 3（NERE-31 分享域） |
| 阶段 3 合并后 | NERE-42（W3-3 分享打开计数/清单/撤销） | 阶段 4（NERE-32） |
| 阶段 4-6 | 不再插入 | — |

阶段 2 的关闭门禁：PR 合入 main 且 issue done 后，先确认 NERE-40 的 wakeup（condition `NERE-30 done`）已触发或已排队；未触发就手动拉起，等它合入后，才提升 NERE-31。

## 10. 执行状态

- 2026-10-21：ADR 转 Accepted（PR #18）。NERE-21 子任务按 stage 排期：0a=NERE-27、0b=NERE-28、1=NERE-29、2=NERE-30、3=NERE-31（吸收 NERE-22）、4=NERE-32、5=NERE-33、6=NERE-34。
- 2026-10-22：阶段 0a 合并（PR #21，`958c950`）：`src/worker/db/migrations.ts` 落地，`worker.ts` 内 `ensureTables` 计数 0，`open()` 走 `ensureMigrated()`。空的 `sessions_meta` 首启五列由 `tests/unit/migrations.test.ts` 与 `tests/api/api.test.ts` 空库用例守住。
- 2026-10-22：阶段 0b 路由骨架（PR #23，基线 `1553908`）：`http/context|errors|router` + `routes/index` 落地，`handleFetch` 重命名为 `handleLegacyFetch` 并委托；`scripts/check-layering.sh` 接入 CI。`npm test` 212 passed，`check-layering` 退出 0；auth/version/sessions/bootstrap/chat/`/s/`/404 探针前后响应一致。
- 2026-10-22：阶段 2 知识库（NERE-30，基线 `b071a7f`）：`routes/kb.ts`（9 个端点）→ `services/kb-service.ts` → `repo/kb-repo.ts`，纯函数迁入 `lib/kb.ts`；AI / Vectorize / settings / DeepSeek 抓取经端口注入，Service 不读 `scope()`。`RequestContext` 增加 `settings` 与 `webFetch` 端口。`/kb*` 从 `handleLegacyFetch` 删除，ingest 错误改抛 `KbIngestError`、响应体与状态码逐字不变。`npm test` 229 passed，`check-layering` 退出 0。
- 2026-10-22：operator 追加产品插入顺序（§9.8）：阶段 2 后先 NERE-40，阶段 3 后先 NERE-42，阶段 4-6 不插入；阶段 2 关闭前须确认 NERE-40 的 wakeup 已触发/排队。
- 后续每个阶段完成后在本节追加一行：阶段号、PR、验收命令结果。

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

1. **保持单文件**：改动最快，但 `handleFetch` 内已出现 105 处内联 SQL 与跨 DO 全局状态；否决。
2. **按功能拆成多个 DO**：请求放大、跨 DO 事务丢失、免费额度下子请求成本上升；否决。分层不需要拆部署单元。
3. **引入 RPC 框架（tRPC/oRPC）**：当前只有同源 HTTP 与内部 DO 协议，收益不足以抵消依赖与类型生成成本；否决。
4. **只做 lint 规则不拆文件**：规则无法消除已有耦合；作为阶段 0 的辅助手段保留。

## 回滚

- 每个阶段独立 PR，回滚即 revert 该 PR；无 schema 破坏性变更（阶段 0 的迁移器只新增 `schema_migrations`）。
- 若拆分导致线上问题，保留原 `worker.ts` 路由作为开关回退一个发布周期，再移除。

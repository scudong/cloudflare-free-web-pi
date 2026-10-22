# 掘金长文 — v1.0.0（中文技术文）

**渠道：** 掘金。**建议发布时间：** 工作日 08:30–09:30 或 20:00–22:00（技术文阅读高峰），首发选周二或周四。

**标题**

```text
把 agent 跑在 Cloudflare 免费额度上，我踩过的 5 个坑
```

## 开篇（299 字）

```text
这个项目最初只是想省一台服务器：一个多用户 AI 工作台，跑在一个 Cloudflare Worker 和每个用户一个 Durable Object 上，不接 Postgres、不接 Redis。做到 v1.0 才发现，真正的成本不在写功能，而在理解运行时的边界。下面 5 个坑都能在仓库里找到记录：一个 Durable Object 每条查询最多 100 个绑定参数、IN 列表要自己分批、同一 isolate 会共用模块级变量、分享页不该拉起 Harness、技能必须在入库前审计。每个坑给出症状、根因、修复和 PR 号，全部对应 main@65478ba。免费额度不免费，它是用约束换来的。
```

## 全文大纲（目标 3,800–4,500 字）

### 一、先交代部署形态（约 350 字）

- 一个 Worker 提供静态页 + `/api/*` + `/s/<token>`；每个用户一个 Durable Object，SQLite 就在 DO 里。
- 没有 VPS、Postgres、Redis、对象存储；模型走 DeepSeek（可换任意 OpenAI 兼容端点）。
- 免费额度的边界：Workers / Durable Objects 个人用量内不额外付费，模型按量计费。
- 引用：`wrangler.jsonc`、`docs/architecture-map.md`、`README.md` § How it works。

### 二、坑 1：长会话 500 —— 每个 DO 查询最多 100 个绑定参数（约 650 字）

- **症状**：会话页内 assistant entry 达到 100 条左右，`GET /api/entries` 直接 500。
- **根因**：`entry_kb_refs.getMany` 用 `IN (?, ?, …)` 拼动态占位符；SQLite-backed Durable Object
  每条查询最多 100 个绑定参数，超了就报错。
- **修复**：改成 `entry_id BETWEEN ? AND ?`，恒定 3 个绑定参数，与页内条数无关。
- **验证**：120 条单测 + 101 轮对话的 API 回归，旧实现能稳定复现 500。
- **PR**：#44。**代码**：`src/worker/repo/entry-kb-refs-repo.ts`。

### 三、坑 2：同一个上限，换个地方又撞一次（约 650 字）

- **症状**：设置页「重建向量索引」失败；默认 200 条、上限 500 条的批次，在 `IN (?, …)` 处报错。
- **根因**：和坑 1 是同一堵墙。`markVectorized` / `chunksByIds` 把一批 id 直接塞进 `IN`。
- **修复**：`db/sql-batch.ts` 的 `chunkIds` 按 90 个 id 一批（留 10 个参数的余量），循环到该文档
  没有剩余；中途 AI 失败保留已完成批次，剩余量可轮询或续建。
- **验证**：500 条与默认 200 条重建用例；测试用的 SqlHandle 按 100 上限主动拒绝超限绑定。
- **PR**：#63（向量重建立即失败）、#74（入库时循环建索引，不再只建前 100 段）。**代码**：
  `src/worker/services/kb-service.ts`、`src/worker/repo/kb-repo.ts`。

### 四、坑 3：同一 isolate 里的模块级变量（约 800 字）

- **症状**：每个用户一个 DO，看起来天然隔离；但同一个 isolate 里可能同时跑多个 DO，模块级
  缓存会被后一个用户的请求覆盖——工具分级和 MCP 连接串到别人身上。
- **根因**：`customToolNames`、`mcpCache` 是模块级变量，作用域是 isolate，不是 DO。
- **修复**：搬进 `SpikeAgent` 实例字段；构建器改成显式收缓存
  （`buildCustomToolsExtension(sql, names)` / `buildMcpExtension(sql, cache)`）。
- **为什么难发现**：单用户本地跑不出来，要两个用户并发才暴露。
- **验证**：`tests/unit/custom-tool-r5.test.ts` 用两个集合 / 两个缓存验证互不覆盖；
  `tests/api/multiuser.test.ts` 验证主人创建的 `owner_probe` 不出现在邀请用户的工具清单里。
- **PR**：#51。**背景**：更早的模块级 SQL / Harness 串数据用 AsyncLocalStorage 请求作用域解决
  （v0.43.0，早于本仓库的 PR 编号体系，CHANGELOG 有记录、无 PR 号）。

### 五、坑 4：分享页不该拉起 Harness（约 700 字）

- **症状**：打开一条 `/s/<token>` 分享页，冷启动里多了一次 Harness `open()`；404 和过期链接也
  会付这笔初始化成本。更隐蔽的是，一批只读写 SQL 的端点被标成 `needsHarness: true`，冷启动
  时白白拉起 Harness。
- **根因**：路由表的能力标记是手写的，复制粘贴时把「需要 Harness」当成了默认值。
- **修复**：分享页渲染走纯函数，`/s/*` 不 open Harness（#41）；24 个纯 SQL 端点改回
  `needsHarness: false`，分享读取单独标记（#74）。
- **验证**：`tests/api/share-cold.test.ts` 在空 persist 上以 `GET /s/<invalid>` 作为首个 DO 请求，
  断言 404 且 Harness `open()` 计数为 0；`tests/api/sql-cold.test.ts` 断言纯 SQL 端点零 open。
- **PR**：#41、#74。**代码**：`src/worker/routes/share.ts`、`src/worker/routes/*.ts`。

### 六、坑 5：审计必须在入库之前（约 750 字）

- **症状**：技能导入接口先写库、后补审计结论；`GET /api/skills`、`/skills/hub` 和提示词索引
  可能对同一条技能给出不同判定。另一半是用户吊销：先删注册表、再删分享，一旦第二步失败，
  用户已经不能登录，但他创建的公开链接还活着。
- **根因**：写入路径不是一个事务；审计结果没有落库，各读路径各自判定。
- **修复**：`POST /api/skills` 先审计再入库，落真实 `audit_status` / `audit_report`，`blocked`
  返回 422 且不写库；本地重审计回写 skills 行；吊销改为先删分享再删注册表，失败时保留可用性
  而不是泄露公开链接。
- **验证**：skill-hub 单测 + `wrangler` 端到端用例；`tests/unit/user-admin-service.test.ts` 覆盖
  两次删除的顺序。
- **PR**：#73。**背景**：审计引擎与能力准入在 #49。

### 七、怎么自己验证（约 300 字）

```bash
npm install
npm test            # 48 个测试文件；558 通过 / 1 跳过（559）
npm run catalog:check
npx wrangler dev    # http://localhost:8787
```

- 测试数取自 `65478ba` 的 CI `test` job，不在正文里承诺“永远 559”。
- 多用户隔离要两个用户并发才明显；本地只起一个 DO 时跑不出来。

### 八、写在最后（约 250 字）

- 这 5 个坑有 3 个和「免费额度的隐性约束」有关：绑定参数上限、isolate 共享、冷启动成本。
  免费额度不是不用付钱，是让你用理解运行时来换。
- 适合：想自己拥有一个 AI 工作台、能接受命令行部署的人。不适合：想点开即用、需要百万级语义检索。
- 仓库：`https://github.com/scudong/cloudflare-free-web-pi`（MIT）。v1.0.0 的完整变更在
  `CHANGELOG.md`。

## 事实核对表（发布前逐条对）

| 文中断言 | PR | CHANGELOG 位置 |
|---|---|---|
| 长会话 `/api/entries` 500，`BETWEEN` 恒定 3 参数 | #44 | § v1.0.0 · 修复 |
| 向量重建 `IN` 列表按 90 分批 | #63 | § v1.0.0 · 修复 |
| 向量入库循环建索引、`pending` | #74 | § 2026-10-22 · NERE-78 |
| 模块级状态搬进实例（R5） | #51 | § v1.0.0 · 架构 / 阶段 4 |
| 分享页零 Harness | #41 | § v1.0.0 · 架构 / 阶段 3 |
| `needsHarness` 误标 24 个纯 SQL 端点 | #74 | § 2026-10-22 · NERE-78 |
| 技能先审计再入库、422 不落库 | #49、#73 | § v1.0.0 · 安全与门禁 |
| 吊销先删分享再删注册表 | #73 | § v1.0.0 · 安全与门禁 |
| 8/8 架构阶段、12 条技能、559 测试 | — | § v1.0.0 开头 |

数字口径：`main@65478ba`。CI 产物：48 个测试文件，558 通过 / 1 跳过（559）。文中不出现
用户量、star 数、性能对比或未实测的 benchmark。

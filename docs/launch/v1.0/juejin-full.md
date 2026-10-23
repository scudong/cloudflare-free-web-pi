# 把 agent 跑在 Cloudflare 免费额度上，我踩过的 5 个坑

这个项目最初只是想省一台服务器：一个多用户 AI 工作台，跑在一个 Cloudflare Worker 和每个用户一个 Durable Object 上，不接 Postgres、不接 Redis。做到 v1.0 才发现，真正的成本不在写功能，而在理解运行时的边界。下面 5 个坑都能在仓库里找到记录：一个 Durable Object 每条查询最多 100 个绑定参数、IN 列表要自己分批、同一 isolate 会共用模块级变量、分享页不该拉起 Harness、技能必须在入库前审计。每个坑给出症状、根因、修复和 PR 号，全部对应 main@9c2a68a。免费额度不免费，它是用约束换来的。

## 一、先交代部署形态

整个应用是一个 Worker：`wrangler.jsonc:6` 指向 `src/worker.ts`，静态前端从 `dist-web` 出，`/api/*` 与 `/s/*` 进入 Worker，再按用户转发到 Durable Object（`wrangler.jsonc:18`）。配置里只有两个 DO 类：`SpikeAgent`（每个用户一个，业务表和 pi-durable 的会话都落在它的 SQLite 里）与 `UserRegistry`（只做邀请码和登录校验，不加载 Harness，`wrangler.jsonc:12`）。没有 VPS、Postgres、Redis、对象存储；模型默认走 DeepSeek，也可以换成任意 OpenAI 兼容端点。Workers / Durable Objects 的个人用量在免费额度内不额外计费，模型按 token 另算——所以“免费”指的是基础设施账单，不是推理成本。

按用户拆 DO 不是为了“看起来多租户”，而是因为会话、文件、记忆、知识库、分享 token 都写在同一套 SQLite 表里。按用户分库之后，备份、导出、删用户都只需要面对一个 DO；跨用户查询在代码里根本不存在。`UserRegistry` 是另一个 DO，只存邀请码和登录状态，连 Harness 都不加载。模型调用是每次请求出站到 DeepSeek 或用户自己配的端点，不占 DO 的存储。

这个形态带来三条不显眼但反复咬人的边界：Durable Object SQLite 每次查询的绑定参数有上限；Durable Object 实例之间可能共享同一个 isolate，模块级变量并不天然属于某个用户；冷启动时拉起 Harness 有实打实的初始化成本。坑 1、2 来自第一条，坑 3 来自第二条，坑 4 是第三条，坑 5 则是跨 DO 的写入顺序。

## 二、坑 1：长会话 500——每条查询最多 100 个绑定参数

**症状** 会话页里 assistant entry 到 100 条左右，`GET /api/entries` 直接 500。接口没有分页参数，一页固定 200 条，100 组 user/assistant 正好 100 个 assistant id。按上限推算，99 个 id 加上 `conversation_id` 正好 100 个绑定参数，第 100 个 assistant 就会越界。前端看起来像“历史消息太多把页面压垮了”，其实请求在 SQL 层就失败了。

**根因** `entry_kb_refs` 是一张旁路表，用来存每条 assistant entry 命中的知识库片段。`getMany` 按当前页的 assistant id 拼 `IN (?, ?, …)`，再加 `conversation_id = ?` 一共 101 个绑定参数。SQLite-backed Durable Object 每条查询最多 100 个绑定参数，超了直接抛错。这个上限不是项目自己设的，也不看行数或 CPU 时间，只数 SQL 里 `?` 的个数；理解这一点之后，所有动态 `IN` 都要先问一句“这串 id 可能有多长”。修复后的注释在 `src/worker/repo/entry-kb-refs-repo.ts:48`，旧实现就在同一个函数里拼 `IN`。

影响范围也值得记一笔：坏的是读历史这条路径，发消息的 `/chat` 仍然可用。用户看到的是“历史打不开”，而不是“不能继续聊”，这种半坏状态比整个页面挂掉更难被巡检发现。教训不是“记住 100 这个数”，而是任何按页内条目数动态拼占位符的 SQL 都要先算最坏情况：一页 200 条就是 200 个潜在参数，和用户聊了多久无关。

**修复** 把 `IN` 换成区间：`entry_id BETWEEN ? AND ?`，绑定参数恒为 3 个，与页内条数无关。entry id 全局递增，区间里会夹着别的会话或已删除的 id，读出来再用 `requested` 集合过滤。这里也可以把 `IN` 按 90 个一批切，但正常对话一页约 100 个 assistant id，切两批就是两次查询；`BETWEEN` 一次查询解决，参数个数恒定，代码也更短。区间扫描会多读一些不属于本页的行，正确性由集合过滤保证，不需要依赖 id 连续。

```ts
// src/worker/repo/entry-kb-refs-repo.ts:68
const rows = sql.exec(
  "SELECT entry_id, refs FROM entry_kb_refs WHERE conversation_id = ? AND entry_id BETWEEN ? AND ?",
  conversationId, min, max,
).toArray() as { entry_id: number; refs: string }[];
```

**验证** `tests/unit/session-kb-refs.test.ts:109` 直接建 120 行，一次读全，并覆盖稀疏区间和会话隔离；`tests/api/kb-refs.test.ts:180` 跑 101 轮真实对话并写入知识库命中，断言 `/api/entries` 仍 200，且页内每条 assistant entry 都带 `kbRefs`。前者绕开 Harness 只测仓储，后者验证完整链路；旧实现下两条都会失败（101 个绑定参数）。**PR #44。**

## 三、坑 2：同一个上限，换个地方又撞一次

**症状** 设置页点“重建向量索引”，默认 200 条、上限 500 条的批次在 `IN (?, …)` 处报错。和坑 1 的报错长得很像，但入口完全不同，第一次修完以为结束了。

**根因** 同一堵墙。`markVectorized` 与 `chunksByIds` 把一批 id 直接塞进 `IN`；一次重建 500 条就是 500 个占位符，远超 100。重建入口的 `limit` 默认是 `KB_VECTOR_BATCH=200`，上限 500（`src/worker/services/kb-service.ts:548`）；`chunksByIds` 在检索命中回读时也可能拿到很大的 id 集合。这里不适合照搬 `BETWEEN`：这些 id 是 `kb_chunks` 的自增主键，稀疏程度不可控，而且查询还要带 `doc_id`、`limit` 等其它参数。

**修复** 按 90 个 id 一批切，留 10 个绑定参数的余量给 `doc_id`、`limit` 之类的占位符。为什么不精确按 100 算：`chunksByIds` 的 SQL 还带 JOIN，`markVectorized` 之外还有别的调用点，留统一余量比逐个调用点数占位符更稳。分批后 SQL 次数变多，但 500 条只需 6 次，仍然是常数级；批与批之间没有事务语义，靠 `vectorized=1` 的幂等更新保证重跑安全。`chunkIds` 先去重再切片：同一批里重复 id 会白占占位符；空数组返回空批次，调用方不用额外判空。

```ts
// src/worker/db/sql-batch.ts:5
export const ID_BIND_LIMIT = 90;
export function chunkIds(ids: readonly number[], size = ID_BIND_LIMIT): number[][] {
  const unique = [...new Set(ids)];
  const batches: number[][] = [];
  for (let start = 0; start < unique.length; start += size) batches.push(unique.slice(start, start + size));
  return batches;
}
```

`markVectorized` / `chunksByIds` 改成 `for (const batch of chunkIds(ids))`，单条 SQL 的占位符最多 90 个（`src/worker/repo/kb-repo.ts:183`、`src/worker/repo/kb-repo.ts:212`）。

入库路径还有第二个问题：原先只给文档的前 100 段建向量，长文档的尾部永远搜不到。#74 把 `indexDoc` 改成循环：每次取 `KB_VECTOR_BATCH` 条未建向量的分块，embed、upsert、`markVectorized`，直到没有剩余（`src/worker/services/kb-service.ts:262`）。单篇正文上限 20 万字符（约 280 段），循环次数有界。每批成功就落库，后续批次失败时已完成的部分仍可召回；响应里的 `vectorized` / `pending` 报告真实进度，`pending` 是剩余量而不是本次处理数，可以轮询或继续重建。`chunksByIds` 的 id 来自向量检索命中，topK 调大时同样可能上百，所以这个修复不只服务设置页，也保护检索路径。

**验证** `tests/unit/kb-service.test.ts:241` 同时跑 500 条和默认 200 条重建；`tests/unit/kb-service.test.ts:265` 用 300 段长文档断言全部建完、`pending` 为 0；`tests/unit/kb-service.test.ts:283` 让 AI 在第二批失败，断言已完成 200 条、剩余 100 条。测试里的 SqlHandle 包装会按 DO 的 100 上限主动拒绝超限绑定，所以回归不是靠“看起来没报错”——只要有人把分批改回去，用例会直接抛错。**PR #63、#74。**

## 四、坑 3：同一 isolate 里的模块级变量

**症状** 每个用户一个 DO，看起来天然隔离。但同一个 isolate 里可能同时跑多个 DO 实例，模块级缓存会被后一个用户的请求覆盖：工具审批分级和 MCP 连接串到别人身上。表现很怪——A 用户刚配好的 MCP 服务，B 用户刷新后看到了；B 用户的自定义工具分级又影响了 A。

**根因** `customToolNames`、`mcpCache` 当时是模块级变量，作用域是 isolate，不是 DO。isolate 是 Workers 的运行单元，可以先后或同时承载多个 DO 实例；模块顶层的 `const cache = new Map()` 只初始化一次，所有实例共用。DO 的“实例隔离”只保证 `this` 上的字段不共享，管不到模块顶层的单例。

**修复** 搬进 `SpikeAgent` 实例字段（`src/worker.ts:125`、`src/worker.ts:127`），构建器改成显式收缓存：`buildCustomToolsExtension(sql, names)` / `buildMcpExtension(sql, cache)`（`src/worker.ts:274`、`src/worker.ts:277`）。这样每个 DO 实例持有自己的集合和连接缓存；配置变更时清空的是当前实例的缓存，不会波及同一 isolate 里的其他用户。

```ts
// src/worker.ts:125
private customToolNames = new Set<string>();
private mcpCache: McpCache = new Map();
// src/worker.ts:274
this.mcpExt = await buildMcpExtension(deps.sql, this.mcpCache);
this.customExt = buildCustomToolsExtension(deps.sql, this.customToolNames);
```

修复不是简单加锁：加锁只能让串用变得有序，不能让它消失；正确做法是把状态的所有权收敛到实例。构建器改成显式参数后，调用点必须自己交出缓存，模块级默认值没有藏身之处，类型检查会逼着每个调用点想清楚用哪份状态。`src/worker/services/custom-tool-service.ts:13` 的注释把这条约束写死在代码里：`buildExtension` 会先清空再写入集合，保证增删工具后审批分级只看到当前 DO 的工具。

也没有选择“模块级 `Map<DO id, cache>`”：请求上下文里没有一个稳定、可信的实例标识，自己维护一份更长生命周期的缓存还要处理清理和泄漏，反而把问题挪到了更难测的地方。实例字段由运行时跟着 DO 回收，这是更省心的生命周期。

**为什么难发现** 单用户本地跑不出来，本地只有一个 DO 在跑，模块级变量看起来完全正确；要两个用户并发，且都配置了自定义工具或 MCP，才会看到对方的配置。CI 里的多用户用例要另起一个带密码的 wrangler 实例，单测只能验证“两个集合 / 两个缓存互不覆盖”。

**验证** `tests/unit/custom-tool-r5.test.ts:23` 用两个集合验证先后构建不会互相清空；`tests/unit/custom-tool-r5.test.ts:54` 用两个缓存验证连接结果不串；`tests/api/multiuser.test.ts:164` 验证主人创建的 `owner_probe` 不出现在邀请用户的工具清单里。**PR #51。**

**背景** 更早的模块级 SQL / Harness / API Key 串数据，是用 AsyncLocalStorage 给每个请求绑定自己的作用域解决的（v0.43.0）。那次早于本仓库的 PR 编号体系，CHANGELOG 有记录、没有 PR 号，这里不硬编一个。

## 五、坑 4：分享页不该拉起 Harness

**症状** 打开一条 `/s/<token>` 分享页，冷启动里多了一次 Harness `open()`；404 和过期链接也会付这笔初始化成本。更隐蔽的是，一批只读写 SQL 的端点被标成 `needsHarness: true`，冷启动时白白拉起 Harness——接口能返回，但首个请求慢了一大截。

**根因** 路由表的能力标记是手写的，复制粘贴时把“需要 Harness”当成了默认值。分享页其实只需要读分享行和渲染 HTML；只有会话分享命中 token 后才需要读 Harness 条目。`/api/automations`、`/api/files`、`/api/kb` 这些纯 SQL 端点也不需要 Harness。

**修复** 分享页渲染走纯函数，`/s/*` 标 `needsHarness: false`（#41，`src/worker/routes/share.ts:99`）；24 个只读写 SQL 的 method+path 改回 `false`，分享读取单独标记（#74）。这批端点包括 automations / files / kb / data 的 `/memories`、capabilities 的 `/capabilities`、`GET /mcp` 等；共同点不是“实现简单”，而是“只碰 SQL”：读的表都在 DO SQLite 里，不经过 pi-durable 的会话。`POST /goal` 仍保持 `true`，因为 `baselineTokens` 要读 Harness 用量，标成 `false` 会让目标续转的预算算错——能力标记不能机械地全部改 `false`。路由匹配未命中直接 404，未知路径也不会触发 Harness（`src/worker/http/router.ts`）。

```ts
// src/worker/routes/share.ts:99
{
  method: "GET",
  path: "/s/",
  needsHarness: false,
  handle: async (ctx) => { /* 纯函数渲染，失效 token 直接 404 */ },
}
```

判定的标准不是“这个 handler 里有没有出现 Harness”，而是“这次请求是否真的需要 Harness 的数据”。分享页的渲染是纯函数，输入是 token 和 theme，输出是 HTML；只有会话分享命中后才通过 `shareRuntime.entries()` 读条目。文件分享直接读 `shares` + `vfs_v2`，全程不碰 Harness；会话分享先查 token，命中后才读条目。冷启动时 `Harness.open()` 要打开 storage、跑迁移、装配扩展，再加载 pi-durable 的会话和任务；把这些从 404 路径上拿掉，省的是整条链。

**验证** `tests/api/share-cold.test.ts:86` 在空 persist 上以 `GET /s/<invalid>` 作为首个 DO 请求，断言 404 且 `GET /api/debug/harness` 的 `opens` 为 0；`tests/api/share-cold.test.ts:94` 验证文件分享冷启动可读且不增加计数；`tests/api/sql-cold.test.ts:88` 断言纯 SQL 端点零 open，`tests/api/sql-cold.test.ts:142` 反向验证需要 Harness 的路由确实会抬高 `opens`，防止观测点本身失效。测试看的是计数而不是响应时间：时间受机器影响，计数是确定性的。观测点只在 `TEST_HARNESS_STATS=1` 时启用，不会出现在生产路由里。**PR #41、#74。**

能力标记和路由放在同一个对象里，review 时能一眼看到 handler 与它的依赖；如果拆到单独的配置表，复制粘贴的错误会更隐蔽，改路由时也容易忘了改标记。这次修复没有引入新机制，只是把已有字段改回真实值，再加一条测试守住计数。

## 六、坑 5：审计必须在入库之前

**症状** 技能导入接口先写库、后补审计结论；`GET /api/skills`、`/api/skills/hub` 和提示词索引可能对同一条技能给出不同判定。三个读路径口径不同：一个返回已安装列表，一个合并目录与已安装，提示词索引只接受非 blocked。审计结论如果只在导入时算一次、不落库，三个路径就会各自用默认值或缓存判断，出现同一条技能三种状态。另一半是用户吊销：先删注册表、再删分享，一旦第二步失败，用户已经不能登录，但他创建的公开链接还活着。

**根因** 写入路径不是一个事务；审计结果没有落库，各读路径各自判定。吊销则是跨 DO 的两步操作，顺序决定了失败时偏向哪一边。

**修复** 导入改成先审计再入库：`auditSkill` 返回 blocked 时直接 422，`putCachedAudit` 和 `upsertSkill` 都不会执行；pass / warn 才写 skills 行，并落真实的 `audit_status` / `audit_report`（`src/worker/services/skill-service.ts:751`、`src/worker/services/skill-service.ts:774`）。审计结果按 hash + 规则版本缓存进 `skill_audits`，`GET /api/skills/:name/audit` 可以直接读，不必每次重扫正文。本地重审计也回写 skills 行，读路径不用再各自算一遍。顺序反过来还有一层代价：先写后审时，审计失败库里已经有一行，重试要么覆盖、要么撞同名冲突，用户得先删再导；先审后写把失败留在 422，库是干净的，重试成本最低。老的 `POST /api/skills` 保留“blocked 内容仍写入”的兼容语义，但 blocked 不会进入提示词索引——这是有意的区分，不是遗漏。

```ts
// src/worker/services/skill-service.ts:751
if (audit.status === "blocked") {
  throw new SkillApiError(422, "audit_blocked", "审计未通过", { audit });
}
// 只有 pass / warn 才走到这里
upsertSkill(sql, { /* ... */ auditStatus: audit.status, auditReport: JSON.stringify(audit) });
```

吊销改成先删分享再删注册表（`src/worker/services/user-admin-service.ts:39`、`src/worker/services/user-admin-service.ts:40`）。旧顺序下，注册表删除成功后用户 token 立即 401，无法再登录；如果随后删分享失败，公开链接仍然 200——用户已经失去控制权，链接却还活着，这是最坏的失败方向。反过来先删分享，最坏情况是用户暂时还能登录、但分享已经没了，可以重试。两个端口都幂等，重试安全。

吊销本身不等于删数据：分享行删掉，会话、文件、知识库仍保留，符合“立即失效访问、不删除数据”的产品语义；真正的清空是另一个带 `confirm` 的动作。跨 DO 没有事务，只能靠顺序加幂等，所以这段顺序必须固定在 service 里并被单测钉住，不能散落在 handler 里。

**验证** `tests/unit/skill-hub-service.test.ts:87` 与 `tests/api/skill-hub.test.ts:109` 都断言 Python 技能导入返回 422 `audit_blocked` 且库中无记录；`tests/unit/user-admin-service.test.ts:20` 让吊销失败，断言注册表行保留、接口报错、重试幂等，`tests/unit/user-admin-service.test.ts:36` 断言成功路径按 `revoke` → `deleteRegistryUser` 调用。**PR #73**；审计引擎与能力准入在 **#49**。

## 七、怎么自己验证

所有命令都能在仓库根目录跑：

```bash
npm install
npm test
npm run catalog:check
npx wrangler dev   # http://localhost:8787
npx vitest run tests/api/share-cold.test.ts   # 单跑一条金标
```

`npm test` 跑 vitest 全量（单测 + API 金标），`catalog:check` 只跑目录校验，`wrangler dev` 起本地 Worker + DO。只想跑一个路子时，`npm run test:unit`、`npm run test:api`，或者 `npx vitest run tests/api/share-cold.test.ts` 单跑一条金标。在 `main@9c2a68a` 上本机实测：`npm test` 是 54 个测试文件，598 通过 / 1 跳过（599）；`catalog:check` 校验目录里没有 blocked 技能、sha256 与正文一致——它是 CI 硬门禁，哈希对不上就直接失败。这个数字会随提交变化，文章不把它当成永久承诺。

多用户隔离要两个用户并发才明显；本地只起一个 DO 时跑不出来。知识库的向量检索需要部署后的 `AI` 与 `Vectorize` 绑定，`wrangler dev` 下这两项不可用，只能验证 FTS5 关键词检索。

## 八、写在最后

这 5 个坑有 3 个和“免费额度的隐性约束”有关：绑定参数上限、isolate 共享、冷启动成本。它们都不是文档首页会写的 API，而是运行时边界。免费额度不是不用付钱，是让你用理解运行时来换——把边界写进测试，比把“免费”写进文案有用。如果你也在 Durable Object 上做多用户，先把这三条写成测试：动态 `IN` 的绑定参数、isolate 里的模块级状态、冷启动的 `open` 计数。它们会比功能测试更早暴露架构问题。

适合：想自己拥有一个 AI 工作台、能接受命令行部署的人。不适合：想点开即用、需要百万级语义检索的人。

仓库：<https://github.com/scudong/cloudflare-free-web-pi>（MIT）。v1.0.0 的完整变更在 `CHANGELOG.md`。

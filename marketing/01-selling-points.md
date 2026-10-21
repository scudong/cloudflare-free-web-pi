# 卖点与亮点

> 对外统一叫法：**Cloudflare + pi agent + Web + 文件分享**。前三个是技术底座，第四个是最容易被感知的用户价值。

## 一句话

把 pi 的 durable agent 内核部署成你自己的 AI 网站：Cloudflare 免费额度内，多用户、文件工作台、知识库、分享链接，一个 `wrangler deploy` 搞定。

## 三句电梯陈述

- **对开发者**：A durable, multi-user AI agent runtime on Cloudflare Workers + Durable Objects — no server, no external database.
- **对投研 / 咨询 / 内容工作者**：把自己的资料库和 AI 助手装进一个网页；报告写完，一键分享给同事。
- **对成本敏感的人**：不用买 VPS。Cloudflare 免费额度 + DeepSeek 按量计费，个人用量每月几块钱。

## 目标人群

| 人群 | 他们要什么 | 这个项目给什么 |
|---|---|---|
| 独立开发者 / 小团队 | 一个能长期用的 AI 工作台，不想运维 | 一个 Worker 部署，GitHub Actions 自动上线 |
| 投研 / 咨询 / 内容 | 资料越积越多，产出要能发出去 | 每人独立知识库 + 文件工作台 + 分享链接 |
| 小团队负责人 | 给同事开账号，但不想共用一份数据 | 邀请码 + 每人独立 DO 空间 + 用户管理页 |
| Cloudflare / pi 生态爱好者 | 想看 Durable Objects 能做成什么 | 完整产品，不只是 SDK 示例 |

## 核心卖点

### 1. 零服务器、零外部数据库

一个 Worker + Durable Objects，会话、文件、记忆、知识库、分享全部存在 DO SQLite 里。没有 VPS、没有 Postgres、没有 Redis、没有对象存储。

**用户价值**：部署成本接近零，不用维护任何基础设施。
**证据**：`wrangler.jsonc` 只有一个 Worker + 两个 DO 类；`/api/backup` 能导出全部数据。

### 2. Durable：不是「一问一答」的聊天壳

任务提交前落盘，DO 重启后继续跑；工具循环原生支持多步调用；另有定时任务（DO alarm）和目标模式（按 token 预算自动续转）。

**用户价值**：长任务不怕断，定时任务不用开着网页。
**证据**：`pi-durable` 的 generation 任务；`automations`、`goals` 表；会话失败自动 close + reopen 重试。

### 3. 真·多用户隔离

邀请码登录，每个用户一个独立 Durable Object：会话、文件、记忆、知识库、分享链接完全隔离。主人在界面里发码、重置、删人；删人后 cookie 立即失效。

**用户价值**：可以放心把工作台分享给同事，各用各的空间。
**证据**：`UserRegistry` DO；`user:<id>` 路由；多用户隔离金标（带密码的 wrangler dev 实测）。

### 4. 文件工作台 + 自己域名上的分享链接

Agent 用 `write_file` 写的 Markdown / HTML 直接在右栏预览；「全部文件」跨会话汇总；一键生成**走你自己 Cloudflare 域名**（默认 `*.pages.dev`，可绑自定义域名）、可设有效期（1 小时 / 1 天 / 7 天 / 30 天 / 永久）的公开链接。

分享页还带：标题目录、四套配色（`?theme=`）、HTML sandbox、链接复用（同一个文件不重复发 token）。

**用户价值**：AI 写完的报告，直接变成同事能打开的网页。
**证据**：`/api/share`、`/s/<token>`、`ShareDialog`、分享金标。

### 5. 每人独立知识库

每个用户一个知识库：文档自动分块，FTS5 + bm25 检索；中文按重叠二元组索引，「久期」「信用债」这类两字词也能命中。每轮对话前自动检索，命中就把前 3 段放进系统提示；也可以让模型主动 `kb_search`。

**用户价值**：资料越存越懂你，不用每次重新贴背景。
**证据**：`kb_docs` / `kb_chunks` / `kb_fts`；`kb_add` / `kb_search` / `kb_list` / `kb_delete`；`/api/kb/prefetch`。

### 6. 能力全家桶

27 个已接入工具（当前实例）：文件读写、网页搜索与抓取、MCP、Skills（可从 SKILL.md 链接安装）、提示模板、规则文件、自定义工具（用户贴 JS，QuickJS 沙箱执行）、子代理并行、Code Mode（模型写 JS 调其它工具）。

**用户价值**：不是只能聊天，是真的能干活。
**证据**：`/api/tools`、`/api/capabilities`、`codemode` 扩展、`dispatch_tasks`。

### 7. 可控

工具审批三档（读取 / 写入 / 执行，可逐工具覆盖）、思考等级、上下文占用百分比、手动压缩、分步计划清单、`ask_user` 结构化问答卡片。

**用户价值**：知道 Agent 在干什么，也能在关键操作前拦住它。
**证据**：`approvals` / `approval_grants` 表；`withApproval` 包裹全部工具；`/api/context`。

### 8. 中文优先 + 模型自由 + 工程可信

界面、提示词、文档全中文；四套主题（浅色默认 / 深色 / 米黄 / 午夜蓝）；默认 DeepSeek，也可接任意 OpenAI 兼容端点；pages.dev 反代，国内可直接访问。

金标回归（单元 + API + 多用户隔离，CI 每次 push 都跑）、CI 自动部署 + 线上冒烟、`/api/version` 构建校验。

## 技术亮点（写给开发者）

- **Durable Object SQLite 上的 pi-durable**：会话与任务落盘，DO 重启自动恢复。
- **多 DO 共 isolate 的隔离**：用 `AsyncLocalStorage` 给每个请求绑定自己的 SQL / Harness / API Key，修掉模块级单例串数据。
- **中文全文检索不引第三方**：FTS5 + 重叠二元组 + bm25 列权重；查询先 AND、全空退 OR，过滤口语停用词。
- **分享页服务端渲染**：Markdown 渲染、目录锚点、四套配色、HTML CSP `sandbox allow-scripts`。
- **流式工具可视化**：SSE 事件把 thinking / tool_start / tool_end / codemode 内嵌调用挂在同一条消息上。
- **自愈**：存储错误触发 `SessionFailed` 时自动 close + reopen 重试；定时任务遇到会话忙会顺延。
- **测试**：金标会真的拉起 `wrangler dev`（独立 persist 目录）打接口，多用户用例另起一个带密码的实例。

## 与常见方案的差异

| | 本项目 | ChatGPT / Claude Projects | Open WebUI / LibreChat | Cloudflare Agents SDK |
|---|---|---|---|---|
| 自己部署、自己的域名 | ✅ 一个 Worker | ❌ SaaS | ✅ 需要服务器 + 数据库 | ✅ 但只是原语 |
| 多用户独立运行时 | ✅ 每人一个 DO | 账号级 | 应用层数据库隔离 | 需自己实现 |
| 文件产出 + 公开分享链接 | ✅ 带有效期 / 主题 | 分享到厂商链接 | 视插件而定 | 需自己实现 |
| 无外部数据库 | ✅ DO SQLite | — | ❌ | ✅ |
| 完整中文 Web 界面 | ✅ | ✅（但不可改） | ✅（可汉化） | ❌ 只有 SDK |

> 表格只描述形态差异，不评价产品优劣；公开使用时避免写「比 X 更好」。

## 可验证的数字

- 金标回归全绿（单元 + API + 多用户隔离）；**不在文案里写具体条数** —— 条数会随每次提交变化，写死就是在造一个下一轮就过期的事实。要看就看去 CI 徽章。
- 24 个内置工具，13 项能力
- 4 套主题，4 种分享有效期档位
- 前端产物约 408 KB（gzip 119 KB）
- 一次 `wrangler deploy`，CI 约 6 分钟（含测试与线上冒烟）

## 常见异议

**「和直接用 ChatGPT 有什么区别？」**
ChatGPT 是租的；这是你自己的网站。数据在自己的 DO 里，文件能生成自己域名的分享链接，同事可以用邀请码进来，各有各的空间。

**「要花多少钱？」**
Cloudflare Workers / DO / QuickJS 在免费额度内；DeepSeek 按量计费，个人用量每月几元。没有 VPS 和数据库账单。

**「安全吗？」**
访问密码 / 邀请码 + 签名 cookie；每个用户独立 DO；工具审批可分三档；分享页只读、可设过期时间；备份文件自己保管。

**「只能接 DeepSeek 吗？」**
默认 DeepSeek，也支持任意 OpenAI 兼容端点（设置 → 模型 → 供应商）。

## 推广钩子（短句）

- 月成本几块钱，跑一个只属于你的 AI 工作台。
- 不是聊天框，是能写文件、能分享、能记住资料的工作台。
- 给每个同事发一个邀请码，各有各的空间。
- Cloudflare 免费额度 + 一个 Worker = 多用户 AI agent。
- AI 写完的报告，一键变成同事能打开的网页。

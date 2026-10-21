# 前 7 天逐日文案

> 一天两条：一条 X（英文）、一条小红书（中文）。直接复制，替换 `<repo>` 为
> `https://github.com/scudong/cloudflare-free-web-pi`。
> 配图路径都在 `marketing/assets/` 或 `docs/`。
> 没有公开演示：所有文案都不写「在线试用」。

---

## Day 1 · 首发

### X（thread，7 条）

**1/**
Most AI chat apps are rented, not owned.

I built the opposite: a multi-user AI workspace on Cloudflare's free tier.

One Worker. No server. No external database.

🧵

**2/**
The problem:

• close the tab → context gone
• reports live in chat logs
• sharing = copy/paste
• a team sharing one account shares one history

**3/**
So I built a workspace:

• durable agent (survives restarts)
• per-user spaces via invite codes
• a knowledge base per user
• files with public share links

**4/**
Stack:

• 1 Cloudflare Worker + static React app
• Durable Objects + SQLite (no Postgres/Redis)
• pi-durable agent loop
• golden test suite, CI deploy + live smoke

`wrangler deploy` and you're done.

**5/**
Files are first-class:

the agent writes Markdown/HTML into a workbench.
One click → a public page on **your own domain** (pages.dev or a custom domain you bind), with an expiry (1h → forever), four themes, and a TOC.

The recipient doesn't log in.

**6/**
Knowledge base without a vector DB:

FTS5 + overlapping Chinese bigrams + bm25.
Top 3 chunks are injected before each turn; the model can also call `kb_search`.

Per user, isolated.

**7/**
Repo: `<repo>`

MIT. Built on pi-durable.

If you want your own AI workspace, star it — and tell me what to build next.

配图：`docs/screenshot.png`（第 1 条）+ `marketing/assets/share-dialog.png`（第 5 条）

### 小红书

**标题**：我把 AI 助手做成自己的网站

**正文**：
之前一直用网页版 AI，关掉标签页，上下文就没了；资料每次都要重新贴。

后来干脆自己搭了一个网站：
左边是会话和知识库，中间聊天，右边是它写出来的文件。

每天会用到的三件事：
1. 存进去的资料会自动切块、建索引，提问时先检索再回答
2. 结果直接写成 Markdown / HTML 文件，能预览
3. 文件可以生成分享链接，设置 1 小时到 30 天过期

跑在 Cloudflare 上，没有服务器、没有数据库；模型按量计费，个人用下来一个月几块钱。

⚠️ 说明：这是开源自部署项目，不是点开就能用的 SaaS；需要 Cloudflare 账号和模型 key。

**配图**：`marketing/assets/xhs-cover-1.png`、`docs/screenshot.png`、`marketing/assets/kb-search.png`

**标签**：#AI工具 #效率工具 #开源 #Cloudflare #自托管 #AI助手 #知识管理

**置顶评论**：
仓库在 GitHub：`github.com/scudong/cloudflare-free-web-pi`（MIT）。需要一点命令行基础，README 里有四步部署。

---

## Day 2 · 技术贴

### X

Chinese has no spaces, so FTS5's default tokenizer is useless.

My fix: index overlapping bigrams (知识库 → 知识 / 识库), query with the same split, try AND then OR, rank with bm25.

No vector DB. No external search service.

Design notes: `<repo>/blob/main/docs/knowledge-base.md`

配图：`marketing/assets/kb-search.png`

### 小红书

**标题**：中文搜索，不一定要向量库

**正文**：
做知识库时最头疼的是中文检索。

英文按空格切词就行；中文没有空格，FTS5 默认分词几乎不可用。

我的做法：
把连续汉字切成重叠的二元组——「知识库」变成「知识」「识库」，查询也用同样切法，先 AND 再退 OR，最后用 bm25 排序。

好处：
· 不用向量库，不用额外服务
· 「久期」「信用债」这种两字词能命中
· 每条结果带标题和片段，模型能直接引用

坏处也说清楚：
这是关键词检索，不是语义检索；问法和原文差太远时可能不命中。

设计记录在仓库 `docs/knowledge-base.md`。

**配图**：`marketing/assets/kb-search.png`

**标签**：#AI工具 #知识库 #全文检索 #开源 #Cloudflare #独立开发

---

## Day 3 · 文件分享

### X

Your AI writes a report. Then what?

In this workspace it writes Markdown/HTML into a file panel. One click → a public page with:

• expiry (1h / 1d / 7d / 30d / forever)
• four themes
• a table of contents

No login for the recipient.

配图：`marketing/assets/share-dialog.png`

### 小红书

**标题**：AI 报告一键变分享链接

**正文**：
以前让 AI 写报告，流程是：复制 → 排版 → 传网盘 → 发微信。

现在它直接把内容写进右侧工作台，Markdown 或 HTML 都能预览。
点分享，生成一个**走你自己域名**的网页链接（默认 pages.dev，也可以绑自己的域名）：

· 可以设置有效期：1 小时 / 1 天 / 7 天 / 30 天 / 永久
· 可以带当前配色（浅色、深色、米黄、午夜蓝）
· Markdown 自动生成标题目录

对方不用登录，打开就是排版好的页面。
文件更新，链接里的内容也跟着更新。

适合：周报、复盘、调研提纲、会议纪要。

**配图**：`marketing/assets/xhs-cover-2.png`、`marketing/assets/share-dialog.png`

**标签**：#AI写作 #效率工具 #报告 #知识管理 #开源 #Cloudflare

---

## Day 4 · Build in public

### X

Full golden test suite. 0 servers.

The API suite spawns a real `wrangler dev` with its own SQLite. A second run starts a password-protected instance to prove user isolation. CI deploys, then smoke-tests the live Worker.

Boring infrastructure is the feature.

配图：无（或 GitHub Actions 运行截图）

### 小红书

**标题**：金标回归全绿后才敢开源

**正文**：
把这个项目开源之前，我先补了测试。

现在有一整套金标：
· 单元测试
· 接口测试：真的拉起一个 `wrangler dev`，用独立的 SQLite
· 多用户隔离：再起一个带密码的实例，确认两个用户互相看不到数据

为什么较真：
这个项目里最容易出错的不是 UI，是「多用户会不会串数据」。
每个用户一个 Durable Object，听起来很安全，但同一 isolate 里的模块级变量会串——这个坑我踩过。

所以 CI 里除了跑测试，还会部署后打一遍线上接口。

开源不是把代码传上去，是敢让别人用。

**配图**：`docs/screenshot.png`、`marketing/assets/all-files.png`

**标签**：#独立开发 #开源 #测试 #Cloudflare #AI工具 #buildinpublic

---

## Day 5 · 多用户隔离踩坑

### X（thread，5 条）

**1/**
I gave every user their own Durable Object.

Then two DOs landed in the same isolate and started reading each other's SQL.

Here's the bug and the fix. 🧵

**2/**
Durable Objects can share an isolate.

My `sql` handle and harness were module-level globals — per isolate, not per DO.

Interleave an owner request and a user request, and they can read the wrong database.

**3/**
The fix: AsyncLocalStorage.

Every `fetch` / `alarm` runs inside a scope carrying `{ sql, harness, apiKey }`. A Proxy forwards `sqlFacade.exec(...)` to the current scope.

**4/**
Result: same isolate, N users, zero cross-talk.

Multi-user isolation is a runtime property, not just a `WHERE user_id = ?`.

**5/**
Repo: `<repo>`

MIT. If you're building multi-tenant agents on Durable Objects, this is the part nobody warns you about.

配图：`docs/architecture.png`

### 小红书

**标题**：多用户隔离，不是加个 WHERE

**正文**：
这个项目每个用户一个独立空间。
听起来简单：查询都带上用户 id 不就行了？

真正踩坑的是运行时。

Cloudflare 的 Durable Object 可能共用一个 isolate。
我一开始把数据库句柄和 Agent 实例放在模块级变量里——结果两个用户同时请求时，可能读到对方的库。

修复方式：
用 AsyncLocalStorage 给每个请求包一层作用域，里面放自己的 SQL、Harness、API Key；所有调用从当前作用域取。

结论：
多用户隔离是运行时属性，不是 SQL 里加一列。

**配图**：`docs/architecture.png`、`marketing/assets/all-files.png`

**标签**：#后端开发 #Cloudflare #多租户 #AI工具 #开源 #独立开发

---

## Day 6 · 成本

### X

What it actually costs to run a personal AI workspace:

• Cloudflare Workers/DO: $0 on the free tier (personal use)
• Postgres / Redis / VPS: $0 — there are none
• DeepSeek: pay-as-you-go, a few dollars a month

Trade-off: you own the ops. That's the point.

配图：`docs/social-preview.png`

### 小红书

**标题**：不买服务器也能跑 AI 工作台

**正文**：
搭这个工作台，我没有买服务器，也没有买数据库。

结构很简单：
· 一个 Cloudflare Worker 跑网页和接口
· Durable Objects 存会话、文件、知识库
· 数据在 SQLite 里，不依赖外部数据库

费用：
· Cloudflare 这部分在免费额度内（个人用量）
· 模型走 DeepSeek，按量计费，个人一个月几块钱

代价也要说：
你得自己有 Cloudflare 账号、配好模型 key；出问题也得自己看日志。
它不是「打开就能用」的 SaaS，是「部署一次，长期归你」的工具。

**配图**：`marketing/assets/xhs-cover-1.png`、`docs/architecture.png`

**标签**：#AI工具 #Cloudflare #独立开发 #自托管 #效率工具 #开源

---

## Day 7 · 求反馈

### X

Shipped this week: English README, share links, per-user KB.

What should I build next?

A) one-click Deploy to Cloudflare
B) PDF/DOCX import into the KB
C) read-only demo mode
D) mobile polish

Reply with a letter.

配图：`docs/screenshot.png`

### 小红书

**标题**：先说清楚：它不适合谁

**正文**：
这个开源项目最近被一些人收藏，我想先把边界说清楚，省得你白部署。

适合：
· 想要一个自己的 AI 工作台，而不是再开一个 SaaS 账号
· 需要把资料长期存起来、提问时自动检索
· 小团队想每人一个独立空间
· 有一点命令行基础，愿意自己部署

不适合：
· 想点开就能用、不想碰命令行
· 需要处理几百万份文档、要语义检索
· 想要的是一个写代码的 IDE

部署需要：Cloudflare 账号 + 一个模型 key。
如果你只是想要「更好的聊天框」，市面上的产品更省事。

**配图**：`marketing/assets/all-files.png`、`docs/screenshot.png`

**标签**：#AI工具 #开源 #自托管 #效率工具 #Cloudflare #独立开发

---

## 通用回复模板

**「需要服务器吗？」**
不需要。Cloudflare Worker + Durable Objects，个人用量在免费额度内；模型按量计费。

**「和 ChatGPT 有什么区别？」**
ChatGPT 是租的，这个是自己的网站：自己的域名、自己的数据，可以给同事发邀请码，每人一个独立空间。

**「小白能装吗？」**
需要一点命令行基础：克隆、填两个 key、`wrangler deploy`。README 里有四步；卡住可以把报错发我。

**「有在线演示吗？」**
暂时没有公开演示，避免模型费用被滥用；仓库有截图、架构图和完整金标回归。

**「为什么不做成 SaaS？」**
数据在自己手里是这类工具的核心价值；做成 SaaS 就回到了「租用」。

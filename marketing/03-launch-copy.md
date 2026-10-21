# 发布文案

> 占位符：`<repo>` = 仓库地址，`<shot>` = 截图。
> 当前决定：暂不做公开演示；帖子只放仓库与截图，不写「在线试用」。

## X（英文 thread，6 条）

**1/**
Most AI chat apps forget everything when the tab closes.

I built a different one: a self-hosted AI workspace that runs entirely on Cloudflare's free tier — with per-user spaces, a knowledge base, and shareable files.

🧵

**2/**
The stack is deliberately boring:

• 1 Worker
• Durable Objects + SQLite
• No VPS, no Postgres, no Redis

Deploy = `wrangler deploy`. CI runs 126 golden tests and a live smoke test.

**3/**
It's durable, not a chat wrapper.

Work is persisted before it runs. Restart the Durable Object and the agent picks up where it left off. Cron automations and goal mode keep going with the browser closed.

**4/**
Multi-user from day one.

Each invitee gets their own Durable Object: sessions, files, memory, knowledge base, share tokens — all isolated. The owner issues and revokes codes from the UI.

**5/**
The agent writes Markdown/HTML into a workbench.

One click → a public link on **your own domain**, with an expiry (1h / 1d / 7d / 30d / forever), four themes, and a table of contents. Reports become web pages you can send to a colleague.

**6/**
Per-user knowledge base, no vector DB:

FTS5 + Chinese bigram tokenization + bm25. Before every turn, the top 3 chunks are injected automatically. The model can also call `kb_search` itself.

Built on pi-durable. Repo: `<repo>`

## X（短版，中英都可发）

**EN**
Self-hosted AI workspace on Cloudflare: one Worker, no server, no database. Per-user spaces, a Chinese knowledge base, and shareable files with expiry. `<repo>`

**中文**
把自己的 AI 助手做成网站：一个 Cloudflare Worker + Durable Objects，不用服务器和数据库。每人一个独立空间、独立知识库；Agent 写的报告能一键生成带有效期的分享链接。`<repo>`

## 小红书（3 篇）

### 篇 1：个人 AI 网站

**标题**：我把 AI 助手做成了自己的网站，月成本几块钱

**正文**：
之前一直用网页版 AI，关掉标签页就什么都不记得，资料也要每次重新贴。

后来干脆自己搭了一个：一个网页，左边是会话和知识库，中间聊天，右边是生成的文件。

它能做三件我每天都要做的事：
1. 记住我存的资料（每份资料会自动切块、建索引，提问时先检索再回答）
2. 把结果写成 Markdown / HTML 文件，直接预览
3. 文件一键生成分享链接，可以设 1 小时 / 1 天 / 7 天 / 30 天过期

部署在 Cloudflare 上，没有服务器、没有数据库；模型按量计费，个人用下来一个月几块钱。

截图放这里 👉 `<shot>`

**标签**：#AI工具 #个人网站 #效率工具 #Cloudflare #AI助手

### 篇 2：团队空间

**标题**：给同事发了个邀请码，每人一个 AI 空间

**正文**：
之前团队共用一个大模型账号，历史记录混在一起，谁也不想用。

现在改成邀请码：主人在后台生成一个码，同事登录后就是完全独立的空间——会话、文件、记忆、知识库、分享链接都分开。

- 每人一个独立的 Durable Object，数据不串
- 主人可以随时重置码、删人
- 同事不用装任何东西，打开网页就能用

适合小团队、课题组、投研小组这种「想共用工具但不想共用数据」的场景。

**标签**：#团队协作 #AI工具 #效率提升 #自托管

### 篇 3：文件分享

**标题**：AI 写完的报告，一键变成同事能打开的链接

**正文**：
以前让 AI 写报告，复制出来还要排版、传网盘、发微信。

现在它在右侧工作台直接写成 Markdown 文件，点分享就生成一个网页链接：带标题目录、可以选配色、能设置有效期（1 小时到永久）。

同事不需要登录，打开就是排版好的页面；文件更新，链接内容也跟着变。

适合：周报、复盘、调研提纲、会议纪要。

**标签**：#AI写作 #效率工具 #报告 #知识管理

## 配图与发布

- 首图用 README 的主截图（1500×940），信息密度够；第二张放「分享链接」弹窗；第三张放知识库面板。
- 架构图可以用 README 里的 ASCII 改一张极简图：浏览器 → Worker → Durable Object。
- X 发 thread 时，第 1 条配主截图；第 5 条配分享弹窗；第 6 条配知识库。
- 避免写「完全免费」：统一说「Cloudflare 免费额度内，模型按量计费」。
- 当前没有公开演示，帖子不要写「在线试用」或放登录页链接。

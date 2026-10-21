# X / 小红书流量计划（14 天）

> 目标不是「发一条爆款」，而是用两周时间验证：哪个角度能让人点进仓库、哪个角度能让人留下 star。
> 基线（2026-10-21）：GitHub 14 天 1 个独立访客、0 个外部来源。所有增长都从这条线开始算。

## 先定转化路径

**X（英文，开发者）**
帖子 → thread → 仓库 → README → star / 部署。

**小红书（中文，效率工具人群）**
封面 → 收藏 → 主页 → GitHub（评论区/简介）→ README → star / 私信问部署。
小红书不适合放长链接，CTA 用「GitHub 搜 `cloudflare-free-web-pi`」，链接放第一条评论和主页。

**共同前提**：没有公开演示。文案不要写「在线试用」，写「开源、自己部署」；把预期放在第一屏。

## 内容四支柱

| 支柱 | 心理抓手 | 主要平台 |
|---|---|---|
| **所有权 vs 租用**：关掉标签页就丢、数据在别人家 | 损失厌恶 | X、小红书 |
| **技术深度**：DO SQLite、中文 FTS5、多用户隔离 | 权威感 / 具体性 | X |
| **工作流演示**：报告 → 文件 → 分享链接 | 可用性启发（看得见的成功） | 小红书 |
| **成本透明**：1 个 Worker、0 台服务器、几块钱 | 具体数字 / 低激活能量 | 两个平台 |

## 14 天日历

| 天 | X | 小红书 |
|---|---|---|
| D1 | Launch thread（03 里的英文 thread）+ 主截图 | 篇 1：我把 AI 助手做成了自己的网站（03） |
| D2 | 技术贴：在 DO SQLite 里做中文全文检索，不引向量库 → `docs/knowledge-base.md` | — |
| D3 | — | 篇 2：AI 写完的报告，一键变成分享链接（03） |
| D4 | Build in public：golden tests / 0 servers，配 CI 截图 | — |
| D5 | 只回复，不发帖：Cloudflare / DO / self-hosted AI 相关 5 条 | 回复所有评论，置顶补仓库名 |
| D6 | — | 篇 3：给同事发邀请码，每人一个 AI 空间（03） |
| D7 | 技术 thread：多用户隔离踩坑（AsyncLocalStorage 串数据） | — |
| D8 | 成本贴：一个月的真实账单区间 + 免费额度边界 | — |
| D9 | — | 篇 4：金标回归全绿之后才敢开源（质量故事） |
| D10 | 引用转发一条 Cloudflare 官方/社区内容，补一句架构评论 | 回复 + 收藏引导 |
| D11 | 分享链接功能贴：有效期 / 主题 / 目录，配分享弹窗截图 | — |
| D12 | — | 篇 5：这个项目不适合谁（反向筛选，提升信任） |
| D13 |  Roadmap + 求反馈：下一个功能投票 | 投票贴：最想要哪个功能 |
| D14 | 复盘：数据 + 学到的东西（build in public） | 复盘/答疑：部署常见问题 |

## 已写好 / 待写的文案

- 现成：`03-launch-copy.md` 的 X thread、短版中英文、小红书 3 篇。
- 新增 4 条 X 钩子（写成帖子时保持一条一个观点）：
  1. **所有权**：`Your AI chat history is rented. I built the 1-Worker alternative: durable, multi-user, and it runs on Cloudflare's free tier.`
  2. **技术**：`Chinese full-text search in SQLite, no vector DB. The trick: overlapping bigrams + bm25 + an AND→OR fallback. Here's the 90-line version:`
  3. **踩坑**：`I gave every user their own Durable Object. Then two DOs shared one isolate and started reading each other's SQL. The fix was AsyncLocalStorage. Story:`
  4. **成本**：`What it actually costs to run a personal AI workspace: 1 Worker, 2 Durable Objects, 1 SQLite per user, $0 infrastructure. The model bill: a few dollars a month. Breakdown:`
- 新增 2 条小红书钩子：
  1. `不买服务器，我把 AI 工作台塞进了一个 Worker`
  2. `这个开源项目不适合谁？先说清楚，省得你白部署`

## 钩子的写法（营销心理学）

- **第一行只做一件事**：让人停下来。用损失/反差/具体数字，不用「分享一个项目」。
- **具体性**：`1 个 Worker`、`0 台服务器`、`3.2 年久期` 比「强大、高效」有用。
- **低激活能量**：X 上先给 3 行命令；小红书上先给「收藏」理由，再给部署步骤。
- **开放循环**：技术 thread 的第一条只抛问题，第二条给答案，最后一条给仓库。
- **承诺一致**：先让人收藏/评论（小承诺），再让人点仓库（大承诺）。
- **损失厌恶**：说「你会失去什么」（关掉就丢、平台迁移、团队共用历史），比说「你能得到什么」更强。
- **社会证明**：只用真实的（金标回归、CI 冒烟、开源代码）；没有用户数据就不要编。

## 发布与互动

**X**
- 时间：北京时间 21:00–23:00（覆盖美国上午 + 国内晚间）。
- 频率：每周 3–4 条原创；其余时间每天回复 5 条相关帖子。
- 链接放 thread 最后一条，正文少放链接；首条用截图。
- 标签最多 1–2 个：`#Cloudflare` `#buildinpublic`。

**小红书**
- 时间：12:00–13:00 或 20:00–22:00；周二/周四/周日优先。
- 封面 3:4，标题 2 行以内，第一行给结果，第二行给代价/限制。
- 正文前 2 行决定展开率；每段不超过 3 行；结尾抛一个问题。
- 标签 6–8 个：`#AI工具` `#效率工具` `#开源` `#Cloudflare` `#自托管` `#AI助手` `#知识管理`。
- 发布后 30 分钟内回复所有评论；置顶评论放仓库名。

## 素材清单

需要准备（本轮已生成 3 张封面，见 `marketing/assets/`）：

- [x] 小红书封面 ×3：个人网站 / 报告分享 / 团队空间
- [x] X 配图：主截图 + 社交卡片
- [x] 分享弹窗截图（有效期/主题）：`assets/share-dialog.png`
- [x] 知识库面板截图（检索命中）：`assets/kb-search.png`
- [x] 「全部文件」面板截图：`assets/all-files.png`
- [ ] CI 通过截图（golden tests + 冒烟）
- [ ] 架构图（已有 `docs/architecture.svg`）

## 指标与迭代

**每周看一次**（GitHub Traffic API，保留 14 天）：

```bash
gh api repos/scudong/cloudflare-free-web-pi/traffic/views --jq '{count, uniques}'
gh api repos/scudong/cloudflare-free-web-pi/traffic/popular/referrers --jq '.[0:5]'
```

| 指标 | 第一周目标 | 第二周目标 | 说明 |
|---|---|---|---|
| GitHub 独立访客 | 150 | 400 | 只算真实增长 |
| 外部来源 | 2 个 | 4 个 | x.com / t.co / 小红书 |
| Star | 10 | 30 | 转化率 ≈ 5% 已不错 |
| 小红书收藏 | 30 | 80 | 收藏比点赞重要 |
| 评论/私信 | 5 | 15 | 部署问题就是内容选题 |

**迭代规则**：同一角度连发两次，数据没有起色就换角度；不要靠加频率硬推。

## 不要做

- 不买粉、不互赞、不进互关群；短期数据会污染判断。
- 不写「完全免费」；统一「Cloudflare 免费额度内，模型按量计费」。
- 不虚构用户案例、不 P 图数据、不假装有在线 demo。
- 不在技术帖里放纯广告链接；先给可复用的信息，再给仓库。

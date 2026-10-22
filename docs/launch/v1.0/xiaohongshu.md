# 小红书 — v1.0.0（中文，1 篇）

**渠道：** 小红书。**建议发布时间：** 周二 / 周四 / 周日，12:00–13:00 或 20:00–22:00（`marketing/05-traffic-playbook.md`）。**配图：** 封面 3:4 用 `marketing/assets/xhs-cover-1.png`，正文图用 `docs/screenshot.png` + `docs/assets/v1/share-page.png`。

**目标读者：** 不想租服务器、但想有一个自己的 agent 的人。

---

## 标题（20 字）

```text
不租服务器，我给自己搭了个 AI 工作台
```

## 正文（288 字，含换行）

```text
不想再租一个 AI 账号，也不想买服务器，我把 agent 跑在了 Cloudflare 免费额度上。

一个 Worker + Durable Objects，没有数据库要运维。会话、文件、知识库各自隔离；报告写完，一键生成只读分享链接。

代价先说：需要自己的 Cloudflare 账号和模型 key，模型按量计费。

复现一步：clone 仓库，把 DEEPSEEK_API_KEY 和 ACCESS_PASSWORD 写进 .dev.vars，运行 npx wrangler dev，本地就能打开。

GitHub 搜 cloudflare-free-web-pi。
```

## 标签（5 个）

```text
#AI工具 #效率工具 #自托管 #Cloudflare #开源
```

## 置顶评论

```text
仓库在 GitHub：github.com/scudong/cloudflare-free-web-pi（MIT）。README 里有本地和部署两条路径，卡住可以把报错发我。
```

---

## 发布说明

- **前两行决定展开率。** 第一段给结果（不租账号、不买服务器），第二段立刻给代价（要自己的
  Cloudflare 账号和模型 key）。这是 playbook 的“损失厌恶 + 低激活能量”写法，正文顺序不要调换。
- **“免费”的口径。** 全文只说“Cloudflare 免费额度上”，不说“完全免费”。模型费用按量计费，
  个人用量一个月几块钱，这是实测量级，不写具体金额。
- **可复现步骤只有一步。** `clone → 填两个变量 → npx wrangler dev`，对应 README 的本地路径。
  不在正文里展开部署（一行装不下，也会劝退收藏）。
- **标签数量。** 本篇按 issue 要求给 5 个；playbook 的常用池是 6–8 个，如需补齐可在评论区补
  `#AI助手 #知识管理`，不要改正文。
- **不放外链。** 小红书正文和评论都不放 https 链接；CTA 统一为“GitHub 搜
  cloudflare-free-web-pi”，链接放主页。playbook 明确写了这一点。
- **不写“在线试用”。** 生产实例需要邀请码；唯一公开产物是一条只读分享页，正文没有声称可试用。

## 事实来源

- 能力与数字：`CHANGELOG.md` § v1.0.0（`main@65478ba`）——1 个 Worker、Durable Objects + SQLite、
  按用户隔离、分享链接（#11、#27、#29、#30、#42、#45）。
- 本地三步：`README.md` § 5-minute quick start。

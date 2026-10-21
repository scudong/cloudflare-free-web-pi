# 推广素材（2026-10-21）

这个目录记录公开发布前的定位、卖点、命名与渠道文案。代码之外的「怎么讲清楚它」都放在这里。

| 文件 | 内容 |
|---|---|
| [01-selling-points.md](01-selling-points.md) | 一句话定位、目标人群、核心卖点、技术亮点、与常见方案的差异、可验证证据 |
| [02-repo-name.md](02-repo-name.md) | 仓库改名候选、推荐名、改名清单 |
| [03-launch-copy.md](03-launch-copy.md) | X 与小红书的现成文案（含英文 thread） |
| [04-demo-plan.md](04-demo-plan.md) | 公开演示的三种方案、45 秒录屏分镜、发布节奏 |

## 一句话

把 pi 的 durable agent 内核部署成你自己的 AI 网站：Cloudflare 免费额度内，多用户、文件工作台、知识库、分享链接，一个 `wrangler deploy` 搞定。

## 四个支柱

1. **Cloudflare**：一个 Worker + Durable Objects + SQLite，没有 VPS、没有外部数据库。
2. **pi agent**：durable 运行时，任务落盘，重启续跑；工具循环、子代理、定时与目标模式。
3. **Web**：中文优先的完整界面，流式对话、文件预览、四套主题、移动端可用。
4. **文件分享**：Agent 写的 Markdown / HTML 一键生成带域名、可设有效期的公开链接。

加两条差异化：**每人独立空间**（邀请码 + 独立 DO）、**每人独立知识库**（中文 FTS5 + 每轮自动预检索）。

## 发布前待办

- [x] 仓库名改为 `cloudflare-free-web-pi`（见 02；短名备选 `cf-free-web-pi`）
- [x] 加 LICENSE（MIT）
- [x] 公开演示：已决定首发暂不做（见 04）；只发仓库 + 截图
- [x] README 补一段英文摘要（X 受众）
- [x] GitHub Description / Topics 更新；1200×630 社交预览图已生成（`docs/social-preview.png`），GitHub 设置里手动上传
- [x] 确认 `.dev.vars`、备份文件、真实用户数据没有进仓库（历史里只有占位符 `sk-...`）

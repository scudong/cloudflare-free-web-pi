# Cloudflare Free Web Pi v1.0.0 发布

2026-10-22，第一个稳定版。`main@36ada72`：49 个 issue 关闭，8/8 架构阶段合并，12 条可安装技能，515 个测试（514 通过、1 跳过）。生产实例：https://pi-harness-gw.pages.dev

## 这个版本带来了什么

**Skill Hub 全链路。** 12 条纯提示词技能（6 条内置、6 条外部）进入构建期目录，左栏可筛选、看审计报告、一键安装。安装前先跑确定性审计：prompt / JS / TS 放行，Python、shell、二进制、宿主 API 和未声明联网在写库前拦下，`blocked` 直接 422。装完能看到运行时、审计结论和上次使用时间。

**分享即产出。** 模型可以调 `share_file` / `share_conversation` 直接给链接；同一个文件复用未过期 token。分享页有目录、四套主题、打印 / 存 PDF，链接走你自己的域名。左栏分享面板能看打开次数、列出全部链接、随时撤销，撤销后原链接立即 404。

**知识库闭环。** PDF / DOCX / Markdown / TXT 和网页都能导入；同来源同正文去重，正文变了原地替换。每轮自动检索前 3 段，命中的片段随消息落库并在下方显示「参考资料」。

**定时任务可编辑。** `PATCH /api/automations` 能改名称、提示词、调度和会话；每行显示上次运行时间和 ok / failed / deferred 状态。

**架构收口。** ADR-0001 的 8 个阶段全部合并：版本化迁移、routes → services → repo 分层、分享页零 Harness、`worker.ts` 只留组合根。`GET /api/bootstrap` 把 17 个首屏面板合成 1 个请求。

**安全与门禁。** 吊销用户 = 立即失效登录态和全部分享链接，数据默认保留；要删数据必须显式 export + confirm。CI 跑构建、全量测试、分层检查和 `catalog:check`。

**多用户边界。** 邀请码登录后每人一个独立 Durable Object，会话、文件、记忆、知识库、分享 token 互不可见。主人可以生成、重置、吊销邀请码；吊销立即生效，数据默认保留，导出后再显式清空。

**升级提示。** 老库首次启动会自动跑迁移补列（当前 v8），技能正文与历史会话不动。部署后旧 DO 实例可能继续跑旧代码 5–10 分钟，用 `GET /api/version` 确认构建号，不要凭「功能没生效」下结论。

## 三个演示

1. 一条真实的周报会话分享（只读、带文件卡）：https://pi-harness-gw.pages.dev/s/jrbxvkz8em3u
2. 知识库演示：TODO(demo-link) —— 生产实例需要邀请码，暂时没有公开的知识库分享链接；部署自己的实例后，把资料导入知识库再提问，分享这条会话即可。
3. Skill Hub 演示：TODO(demo-link) —— 同上，暂无公开链接；本地 `npx wrangler dev` 打开左栏「技能」即可看到完整市场与审计详情。

## 怎么开始

需要 Node.js 22、Cloudflare 账号（免费版够用）和 DeepSeek API Key。本地三步：`npm install`、`npm run build:web`、`npx wrangler dev`，把 `DEEPSEEK_API_KEY` 和 `ACCESS_PASSWORD` 写进 `.dev.vars` 后打开 http://localhost:8787。部署用一键按钮，或先 `npx wrangler vectorize create pi-kb --dimensions=1024 --metric=cosine`，再 `npx wrangler deploy`，最后用 `wrangler secret put` 补两个密钥。

仓库：https://github.com/scudong/cloudflare-free-web-pi
更新记录：[CHANGELOG.md](../CHANGELOG.md)

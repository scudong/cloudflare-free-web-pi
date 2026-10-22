<div align="center">

<img src="docs/icon.svg" width="96" alt="Cloudflare Free Web Pi">

# Cloudflare Free Web Pi（π Harness）

[![Release](https://img.shields.io/github/v/release/scudong/cloudflare-free-web-pi?label=release&color=0ea5e9)](https://github.com/scudong/cloudflare-free-web-pi/releases) [![Stars](https://img.shields.io/github/stars/scudong/cloudflare-free-web-pi?style=flat&color=0ea5e9)](https://github.com/scudong/cloudflare-free-web-pi/stargazers) [![License](https://img.shields.io/badge/license-MIT-0ea5e9)](LICENSE) [![Deploy](https://github.com/scudong/cloudflare-free-web-pi/actions/workflows/deploy.yml/badge.svg)](https://github.com/scudong/cloudflare-free-web-pi/actions/workflows/deploy.yml)

[English](README.md) · **简体中文** · [快速开始](#快速开始) · [部署](#部署)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/scudong/cloudflare-free-web-pi)

<sub>一键部署到自己的 Cloudflare 账号；部署时 Build command 填 <code>npm run build:web</code>，详见[部署](#部署)</sub>

</div>

把 [pi](https://github.com/earendil-works/pi) 的 **durable harness 内核**跑在 Cloudflare Worker 上：会话、工具调用、记忆、文件全部持久化在 Durable Object 的 SQLite 里，不依赖任何外部数据库。

- **运行成本**：Cloudflare 免费额度内；模型走 DeepSeek（按量计费，个人用量每月几元）
- **作者实例**：https://pi-harness-gw.pages.dev （需邀请码；仅供体验，长期使用请部署自己的实例）

> 本项目是社区项目，与 Cloudflare, Inc. 无隶属关系；Cloudflare、Workers、Durable Objects 是其商标。

![界面](docs/screenshot.png)

---

## 功能

| 模块 | 能力 |
|---|---|
| 会话 | 多会话隔离、首条消息自动命名（前 24 字）、重命名、删除、**按会话选择模型**（`deepseek-flash` / `deepseek-v4-pro`） |
| 对话 | SSE 流式逐字输出、**可折叠思考过程**、**吸顶计划清单**（`update_plan`）、工具调用实时 pill（含 codemode 内嵌调用）、**产出文件卡**、完整 Markdown（表格/任务列表/代码复制）、图片输入（粘贴或上传，自动压缩 ≤1568px） |
| 执行 | `codemode`：模型写 JavaScript 在 QuickJS 沙箱里跑，脚本内可 `await tools.<name>()` 调用其它工具；`dispatch_tasks`：2–4 个独立子任务并行分派给子代理后汇总 |
| 网页 | `web_search` 联网搜索 + `web_fetch_page` 抓取正文（DeepSeek 搜索 API，设置中可开关）；`http_fetch` 直接抓取；**Browserbase MCP** 云端浏览器（导航/点击/提取，无需本地 Chrome） |
| 记忆 | `remember` / `recall` + 每 6 条自动 `reflect` 抽取长期事实（带去重） |
| 文件 | 按会话隔离的虚拟文件系统（`write_file` / `read_file` / `list_files`），右栏可预览 Markdown 与 HTML；**左栏「全部文件」跨会话汇总当前用户的所有产出**；Markdown / HTML 可生成**走你自己域名**、带有效期的公开分享链接；模型可用 `share_file` / `share_conversation` 直接产出链接卡（同一文件复用未过期 token） |
| 知识库 | **每个用户独立的知识库**（每人一个 DO）：粘贴资料自动分块 + 中文全文索引（FTS5 / bm25），模型侧 `kb_search` / `kb_add` / `kb_list` / `kb_delete`；**每轮按用户消息自动预检索并注入前 3 段**（设置→对话可关）；左栏「知识库」可检索、查看全文、删除 |
| 能力 | **能力注册表**（内置/数据/协议三类汇总）、**提示模板**（`/` 展开，支持 `$1` 占位）、**规则文件**（每轮注入）、自定义技能（`SKILL.md` 规范）+ 一键安装 `badlogic/pi-skills` 社区技能；模型按需 `load_skill`，也可在输入框用 `/技能名` 显式调用 |
| 扩展 | 任意 **MCP** 服务器（Streamable HTTP，支持自定义请求头） |
| 定时 | Durable Object alarm 驱动的定时任务（每天 HH:MM / 每隔 N 分钟） |
| 其他 | **左侧工具栏**（新会话/全部文件/知识库/会话/连接/定时/技能/用户/设置）、**设置页**（分 tab：通用/对话/模型/记忆/数据）、**模型供应商管理**（任意 OpenAI 兼容端点，CCswitch 式切换）、一键清空记忆、只读分享链接（会话 / Markdown / HTML，可设有效期，走自己的 Cloudflare 域名）、Markdown 导出、全量备份/恢复、四套主题（深色/浅色/米黄/午夜蓝，Arco 字节色卡）、访问密码 + 邀请码多用户（独立空间） |

---

## 架构

```
浏览器
  │  https://<你的 Worker 域名>           ← 可绑定自定义域名 / pages.dev 反代
  ▼
Cloudflare Worker（静态前端 + API 入口）
  ├── 静态资源：dist-web（React + Vite + Tailwind）
  └── /api/*、/s/* → Durable Object
                     ├── pi-durable Harness（会话 / 任务 / 工具调度）
                     ├── Storage = openDurableObjectSqliteStorage（DO SQLite）
                     ├── 模型：pi-ai deepseekProvider
                     ├── codemode：QuickJS WASM 沙箱
                     └── MCP 客户端（Streamable HTTP）
```

**关键设计**

- **持久化**：`@earendil-works/pi-durable` 的 `Storage` 接口 + 官方 DO SQLite 适配器，会话/任务提交前落盘，进程重启自动续跑
- **工具循环**：pi-durable 的 `generation` 任务原生支持多步工具调用与 `tool_search` 渐进披露
- **扩展注入**：扩展必须在 `Harness.open` 之前 `registry.install`，否则已存在会话解析不到
- **自愈**：存储类错误触发 `close + reopen`；定时任务遇到会话忙会顺延，避免并发写坏会话

---

## 快速开始

从零到本机可用约三分钟（依赖安装 1–2 分钟，前端构建十秒内，首次启动 `wrangler dev` 约 10–20 秒）。

```bash
git clone https://github.com/scudong/cloudflare-free-web-pi.git
cd cloudflare-free-web-pi
npm install

# 前端必须先在本地构建：wrangler 把 dist-web/ 当静态资产目录，缺了会直接报错
npm run build:web

# 本地密钥（只写入 .dev.vars，不会提交）
echo "DEEPSEEK_API_KEY=sk-..." >> .dev.vars
echo "ACCESS_PASSWORD=你的访问密码" >> .dev.vars

npx wrangler dev             # Worker + DO：http://localhost:8787
```

打开 http://localhost:8787 、输入 `ACCESS_PASSWORD` 即可对话。确认服务起来了：

```bash
curl http://localhost:8787/api/auth
# {"required":true,"authenticated":false,"owner":false}   ← 密码已生效，尚未登录
```

改前端时用热更新：另开一个终端跑 `npm run dev:web`（http://localhost:5173，`/api` 已代理到 8787）；`wrangler dev` 读的是 `dist-web/`，改完需重跑 `npm run build:web`。

**本地限制**：`wrangler dev` 下 `AI` 与 `Vectorize` 绑定不可用，知识库的向量 / 混合检索在本地是空的；默认的 FTS5 关键词检索正常。向量检索要在部署后的实例上验证。

金标回归（单元 + 接口，约 40 秒）：

```bash
npm test
```

---

## 部署

### 一键部署到自己的账号

点首屏的 **Deploy to Cloudflare** 按钮，或用[这个链接](https://deploy.workers.cloudflare.com/?url=https://github.com/scudong/cloudflare-free-web-pi)。Cloudflare 会把仓库复制到你的 GitHub 账号，用 Workers Builds 构建并部署：

- **Build command**：填 `npm run build:web`（仓库没有 `build` 脚本，留空会因缺 `dist-web/` 而失败）
- **Deploy command**：保持默认 `npx wrangler deploy`
- 部署完成后到 Worker → Settings → Variables and Secrets 添加 `DEEPSEEK_API_KEY` 和 `ACCESS_PASSWORD`。**不设 `ACCESS_PASSWORD` 时站点是开放模式，任何人都能使用**；改完变量需重新部署一次

Durable Objects、Workers AI 和 Vectorize 索引会按 `wrangler.jsonc` 自动创建并绑定。

### 命令行部署

```bash
npm install
npm run build:web                      # 手动部署同样要先构建前端
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put BUILD          # 可选：构建号，用于判断线上是否更新
npx wrangler deploy
```

推送 `main` 会自动部署（`.github/workflows/deploy.yml`），需要仓库 secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

---

## HTTP API

除 `/api/auth`、`/api/login`、`/s/*` 外，均需登录 cookie。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth` | 是否需要登录 / 当前是否已登录 |
| POST | `/api/login` | `{password}` → 下发签名 cookie |
| GET | `/api/bootstrap?sessionId=` | 首屏聚合：一次返回 `session` / `entries` / `sessions` / `files` / `memories` / `approvals` / `settings` / `plan` / `goal` / `questions` / `prompts` / `rules` / `customTools` / `skills` / `automations` / `mcpServers` / `models`；单个面板失败时该字段为 `null` 或 `[]`，并在 `errors` 里给出原因 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 新建会话 |
| PATCH / DELETE | `/api/sessions` | 重命名 / 删除。删除会级联清空该会话的分享、文件、计划、审批/许可、问题与 KB 命中旁路；响应 `{ok:true,deleted:{shares,files,plans,approvals,approvalGrants,questions,kbRefs}}` |
| POST | `/api/chat` | `{message, sessionId?, images?}` → `{answer, tools}` |
| POST | `/api/chat/stream` | 同上，SSE：`text` / `tool_start` / `tool_end` / `done`；`done` 在本轮命中知识库时透传 `kbRefs`（与 entry 同一份，未命中不带该字段） |
| GET | `/api/entries?sessionId=` | 会话转录；命中知识库的 assistant entry 带 `kbRefs: {docId, chunkId, chunkSeq, title, source?}[]`，未命中不带该字段 |
| GET | `/api/files?sessionId=` | 工作台文件列表 |
| GET | `/api/files/content?sessionId=&name=` | 文件内容 |
| GET | `/api/files/all?q=` | 当前用户所有会话的文件（跨会话总览） |
| GET / POST / DELETE | `/api/kb` | 用户知识库：文档列表 / 入库 / 删除 |
| POST | `/api/kb/ingest` | 导入文件（`multipart/form-data` 的 `file`：PDF / DOCX / MD / TXT）或网页（JSON `{url}`），服务端解析后入库；同 source 同正文返回 `updated:false` 不重复入库，正文变化则原地替换并返回 `updated:true` |
| GET | `/api/kb/doc?id=` · `/api/kb/search?q=` | 知识库文档全文 / 检索片段 |
| GET | `/api/kb/prefetch?q=` | 本轮会自动注入的知识库参考资料（调试 / 排查用） |
| GET / POST / DELETE | `/api/skills` | 技能增删查（兼容旧字段；每条新增 `lastInvokedAt`） |
| GET | `/api/skills/hub` | Skill Hub 市场：目录快照 + 已安装合并；`q` / `runtime` / `tag` / `audit` / `source` / `origin` / `installed` / `sort` / `limit` / `offset`；`runtime` 接受 `prompt/javascript/typescript/python/shell/binary/other`，列表零抓取 |
| GET | `/api/skills/:name/audit` | 单技能审计：已安装走本地重审计（`auditSource:"local"`），仅目录存在时返回快照（`"catalog"`），不存在 404 |
| POST | `/api/skills/import` | `{url}` 或 `{manifest, content}`，**先审计再入库**；`blocked` → 422 `{ok:false, installed:false, code:"audit_blocked", details:{audit}}` 且不写库；同名不同哈希 409，`overwrite:true` 覆盖 |
| GET | `/api/skills/community` | 社区技能目录（badlogic/pi-skills）：8 条固定 `audit_status:"blocked"`（需要本地运行时），不可安装 |
| GET | `/api/metrics/skill-hub?days=7` | 技能域指标：`{hubViews, installOk, installBlocked, blockedRatio, installed, called7d}`；与分享计数完全独立 |
| GET / POST / DELETE | `/api/mcp` | MCP 服务器配置（支持 `headers`） |
| GET / POST / DELETE | `/api/providers` · `/api/providers/activate` | LLM 供应商（自定义 OpenAI 兼容端点） |
| GET / POST | `/api/settings` | 全局设置（网页搜索开关 `webSearch`、思考档位 `thinkingLevel`、分享页署名 `displayName`、分享默认有效期 `shareTtlSeconds`） |
| GET | `/api/plan?sessionId=` | 当前会话的分步计划 |
| GET | `/api/context?sessionId=` | 上下文占用估算（百分比 / 窗口） |
| GET / POST / PATCH / DELETE | `/api/automations` | 定时任务。PATCH `{id, name?, prompt?, schedule?, sessionId?, enabled?}`：字段均可选，只传 `enabled` 时与旧启停语义完全一致；改 `schedule` 后按新调度重算 `next_run_at`（daily 按 UTC+8）并重挂 alarm，只改名称/提示词/会话则保留原 `next_run_at`；校验失败 400 且不落库，返回 `{ok:true, automation:{id,name,prompt,schedule,sessionId,enabled,last_run_at,next_run_at}}` |
| POST | `/api/share` · GET `/s/<token>` | 只读分享（`kind=conversation/file`，`ttlSeconds` 可选，不传用 `shareTtlSeconds` 设置、0 = 永久；`theme` 记录分享页配色；页脚署名 + 生成时间）。每次有效打开计入 `openCount` / `lastOpenedAt`；同一 IP（`CF-Connecting-IP`，反代看 `X-Forwarded-For` 首跳）1 小时内只计 1 次，库里只存哈希 |
| GET | `/api/shares?sessionId=&kind=&name=` | 未过期的分享链接（打开弹窗时复用） |
| GET | `/api/shares/all?status=active\|expired\|all` | 全量分享清单（缺省 `active`）：`{ shares: [{ token, kind, name, expiresAt, theme, createdAt, openCount, lastOpenedAt, sessionId, url }] }`，`url` 为相对路径 `/s/<token>` |
| DELETE | `/api/shares/<token>` | 撤销分享 → `{ ok: true }`，立即生效（原链接 404）；越权 403，不存在 404 |
| GET | `/api/export?format=md` | 导出 Markdown |
| GET / POST | `/api/backup` · `/api/restore` | 全量备份 / 合并恢复 |
| GET | `/api/version` | 线上构建号（CI 注入 git SHA） |
| GET / POST / DELETE | `/api/users` · `POST /api/users/reset` | 邀请用户管理（仅主人；码只返回一次）。`DELETE?id=` 吊销访问：注册表行删除、该用户全部分享立即失效，**数据默认保留**；响应 `{ok,id,deleted,shares,retained:{sessions,files,kbDocs,...}}`，重复调用幂等 |
| GET | `/api/users/export?id=` | 导出某用户的完整备份（仅主人；与 `/api/backup` 同形，purge 前留档用） |
| DELETE | `/api/users/data?id=&confirm=<id>` | 显式清空某用户 DO 的全部数据（仅主人；必须已吊销且 `confirm` 等于用户 id）。不可逆；返回 `{ok,id,purged:{...}}`，重复调用为 0 |

---

## 内置工具

`now` · `remember` · `recall` · `kb_search` · `kb_add` · `kb_list` · `kb_delete` · `update_plan` · `dispatch_tasks` · `list_skills` · `load_skill` · `install_skill` · `web_search` · `web_fetch_page` · `http_fetch` · `write_file` · `read_file` · `list_files` · `codemode` · `tool_search` · `set_goal` · `complete_goal` · `report_goal` · `ask_user`，以及所有已配置 MCP 服务器的工具（`mcp__<服务器>__<工具>`）。

共 24 个内置工具；另可在左栏「技能 → 自定义工具」用 JS 写自定义工具。

---

## 注意事项

- **Durable Object 换代码有延迟**：部署后旧实例可能继续运行旧代码 **5–10 分钟**，且持续请求会让它不驱逐。判断线上是否真的更新，看 `GET /api/version` 返回的 git SHA，不要凭「功能没生效」下结论。
- **访问密码与邀请码**：`ACCESS_PASSWORD` 是主人密码；左栏「用户」可生成邀请码，邀请码登录后进入独立空间（自己的会话 / 文件 / 记忆）。删除用户 = **吊销访问**：旧登录态立即失效、该用户所有 `/s/*` 分享链接立即 404，会话/文件/知识库数据默认保留；需要彻底删除时先 `GET /api/users/export` 留档，再调 `DELETE /api/users/data?id=&confirm=<id>`（不可逆，无自动回滚）。改密码会让所有设备立即退出（邀请码仍可重新登录）。
- **数据隔离**：主人沿用历史数据所在的 Durable Object；每个邀请用户使用独立的 `user:<id>` Durable Object，互不可见。会话、文件、记忆、知识库、分享链接都按这套边界隔离。
- **密钥落库**：MCP 的请求头（如 `x-bb-api-key`）存在 DO 数据库里，**会随 `/api/backup` 导出**，分享备份时注意。
- **免费额度**：Workers / DO / QuickJS 均在免费额度内；DeepSeek 与 Browserbase 按量计费。

---

## 目录结构

```
src/
  worker.ts              # Worker 入口 + Durable Object（API、工具、存储、调度）
  web/                   # React 前端
    components/          #   Rail / Sidebar / LeftPanels / ChatHeader / MessageList / Composer / Workbench / TopBar / SettingsDialog
    lib/                 #   api 客户端、SSE 解析、Markdown 渲染、宽容解析器
wrangler.jsonc           # Worker + DO + 静态资源绑定
.github/workflows/deploy.yml
tests/                   # 金标用例（unit 纯函数 / api 接口），见 tests/README.md
CHANGELOG.md             # 逐版本更新记录
```

---

## 版本

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。里程碑：

`v0.10` 访问密码 · `v0.11` 主题 · `v0.12` 图片输入 · `v0.13` 工具搜索 · `v0.14` 备份恢复 · `v0.15` 技能/预览 · `v0.16` 右栏可伸缩 · `v0.17` 社区技能 · `v0.18` Browserbase 云端浏览器 · `v0.19` 服务端停止 · `v0.20` 设置页/联网搜索 · `v0.21` 左栏工具栏 · `v0.22` 思考/计划/轨迹 · `v0.23` 输入框调用技能 · `v0.24` 四套主题 · `v0.25` Arco 色卡 · `v0.26` 设置分 tab · `v0.27` 模型供应商 · `v0.28` 金标回归 · `v0.29` 子代理编排 · `v0.30` 能力注册表 · `v0.49` README 英文首页 · `v0.50` 流量计划与素材 · `v0.51` 前 7 天逐日文案 · `v0.52` 独立域名分享 · `v0.53` 知识库向量检索

## 致谢

- [earendil-works/pi](https://github.com/earendil-works/pi) — durable agent harness、pi-ai、pi-codemode、pi-mcp
- [badlogic/pi-skills](https://github.com/badlogic/pi-skills) — 社区技能目录

# 更新记录

本文件记录每次功能迭代。每次 push 到 `main` 都会自动部署（GitHub Actions → Cloudflare Worker）。

## 2026-10-21（公开发布准备）

### X / 小红书流量计划与素材（v0.50.0）
- 新增 `marketing/05-traffic-playbook.md`：14 天发布日历、四类内容支柱、钩子写法、发布与互动规则、指标与迭代
- 新增 3 张小红书封面（2160×2880）与分享弹窗 / 知识库 / 全部文件截图
- 记录 GitHub 流量基线（1 个独立访客、0 个外部来源）与每周 Traffic API 检查命令
- 明确不做刷量/互赞，不使用「完全免费」或虚构案例

### README 重构：英文首页 + 中文副页（v0.49.0）
- 参考 magpie 的结构重写首页：图标、标题、一句话、徽章、产品截图、问题、卖点、快速开始、架构图、部署、适用人群
- `README.md` 默认英文；完整中文文档移到 `README.zh-CN.md`，两个页面顶部互相切换
- 新增 `docs/icon.svg` 与 `docs/architecture.svg`
- 移除中文 README 里原给英文读者的摘要（由英文首页承担）
- 代码无改动

### 首发不设公开演示（v0.48.2）
- 决定首发只发仓库 + 截图，不做公开演示码或只读入口
- 同步更新 `marketing/03-launch-copy.md`：移除 `<demo>` 占位与「在线试用」表述
- `marketing/04-demo-plan.md` 保留三种备选方案，等有真实案例再启用
- 发布前状态：仓库已 public、Social preview 已上传、homepage 指向线上站点

### 公开演示方案（v0.48.1）
- 新增 `marketing/04-demo-plan.md`：演示邀请码 / 录屏 / 只读模式三种方案与取舍
- 给出 45 秒录屏分镜与两周发布节奏；建议先发录屏，演示码只在私信/评论区补充
- 明确演示码的计费风险与 DeepSeek 消费上限设置

### LICENSE、英文摘要、社交预览（v0.48.0）
- 新增 MIT LICENSE（版权人 scudong）
- README 增加英文摘要，方便 X / GitHub 英文读者快速理解
- 新增 `docs/social-preview.png`（1200×630）与 OG / Twitter Card 元数据；站点 `/social-preview.png` 可直接访问
- 核对仓库与历史记录，没有真实密钥（只有文档占位符 `sk-...` 与测试假密钥）
- 剩余：公开演示邀请码、仓库转 public、在 GitHub 设置里上传社交预览

### 命名调整：Cloudflare Free Web Pi（v0.47.1）
- 仓库名改为 `cloudflare-free-web-pi`（v0.47.0 的 `cloudflare-free-pi-agent` 已被替换，GitHub 旧链接 301）
- README / 页面 title / 顶栏 / worker 指令 / CI 仓库守卫同步改为 Web Pi
- 重新生成 README 截图，顶栏显示 **Free Web Pi**
- 命名依据：Cloudflare + Free + Web + Pi 四个词完整可搜；GitHub / npm 均无同名

### 仓库改名 Cloudflare Free Pi Agent（v0.47.0）
- GitHub 仓库：`scudong/pi-harness` → `scudong/cloudflare-free-pi-agent`（GitHub 会自动 301 旧链接）
- README 标题、页面 `<title>` / description、顶栏品牌同步改为 **Cloudflare Free Pi Agent / Free Pi Agent**
- CI 的仓库守卫、worker 指令里的仓库引用同步更新
- README 增加 Cloudflare 商标声明（非官方项目）
- 保持不变：Worker 名 `pi-harness-spike`、pages.dev 域名、DO 数据、cookie 签名与 localStorage 键

### 推广素材与命名建议（v0.46.3）
- 新增 `marketing/` 目录：一句话定位、8 个核心卖点、技术亮点、与常见方案的形态对比、目标人群、常见异议
- 命名调研：推荐 `pi-station`（π 空间站），备选 `pi-harbor`（π 港湾）；附 GitHub/npm 撞名检索结果与改名清单
- 渠道文案：X 英文 thread / 短版中英文、小红书 3 篇（个人网站 / 团队空间 / 文件分享）
- 发布前清单：LICENSE、公开演示、README 英文摘要、社交预览图、GitHub Description / Topics
- 代码无改动；`.gitignore` 补上 `tests/.tmp-state*/`

## 2026-10-20（多用户）

### README 截图更新（v0.46.2）
- 换成当前界面：浅色主题、左侧工具栏（含「全部文件」「知识库」）、输入框上方的模型 / 思考 / 上下文控制、右侧 Markdown 预览
- 截图来自本地演示会话（久期说明 + `duration.md`），不含真实数据；尺寸与旧图一致（1500×940）

### 输入框字号 + 会话失败自愈（v0.46.1）
- 聊天输入框（Composer）在桌面端从 16px 调到 15px，与消息正文一致；移动端保持 16px，避免 iOS 聚焦时自动放大页面
- 修复：部署或存储中断后 pi-durable 进入 `SessionFailed`，`/api/sessions` 持续 500，必须重启 DO 才能恢复
- 现在 `root` / `conversation` / `newSession` 遇到 `SessionFailed | storage error` 会自动 `close + reopen` 并重试一次，会话列表与调试接口自愈

### 知识库每轮预检索（v0.46.0）
- 每轮发送前用用户消息检索知识库，命中时把前 3 段（每段 ≤600 字）作为「知识库参考资料」注入本轮 instructions；没命中不增加内容
- 默认开启；设置 → 对话 → 「知识库预检索」可关闭，关闭后模型仍可主动调用 `kb_search`
- 检索先按 AND、全空退回 OR，并过滤「怎么 / 什么 / 如何」等口语停用词，自然语言问句也能命中
- 预检索在 `buildInstructions` 末尾拼接，位于显式技能正文之后、用户消息之前
- 新增 `GET /api/kb/prefetch?q=` 预览本轮注入内容；`/api/debug/agent?message=` 返回本轮完整 instructions
- 冒烟新增预检索接口检查；金标新增 3 条，总计 **126 条**

### 用户知识库 + 全部文件总览（v0.45.0）

**知识库（每人独立）**
- 每人一个独立知识库：文档、分块与索引都存在自己的 DO SQLite，邀请用户之间、与主人之间互不可见
- 检索用 FTS5 + `bm25`；中文按重叠二元组索引（「知识库」→ 知识/识库），两字词也能命中；单字查询退回 `LIKE`
- 自动分段：按空行聚合约 800 字，超长段落 720 字步长切分并留 80 字重叠；单篇上限 20 万字符
- 新工具：`kb_search`（读）、`kb_add`（写）、`kb_list`（读）、`kb_delete`（写，参与审批分级）
- 提示词明确：涉及用户资料先 `kb_search`，用户说「存到知识库」用 `kb_add`，工作台文件不会被检索
- 左栏新增「知识库」：检索、粘贴正文入库、查看全文、删除；空库与结果为空都有引导
- 新接口：`GET/POST/DELETE /api/kb`、`GET /api/kb/doc`、`GET /api/kb/search`
- 备份新增 `kbDocs`（只含正文）；恢复时重新分块并重建索引
- 设计 / 方案调研记录见 `docs/knowledge-base.md`

**全部文件（跨会话）**
- 左栏新增「全部文件」：汇总当前用户所有会话产出的文件，显示所属会话、大小与时间
- 支持按文件名 / 会话名筛选；点击文件自动切到所属会话并在右栏打开
- 可在列表内直接删除（同步刷新右栏工作台与会话列表）
- 新接口 `GET /api/files/all?q=`：返回 `sessionId / name / size / updatedAt / sessionTitle`
- 修复跨会话打开时「文件不存在」守卫误关文件（新增 `filesForSession` 判断）

**测试**
- 新增知识库金标 8 条、全部文件 3 条、多用户隔离 5 条（独立跑带密码的 wrangler dev，验证知识库与文件互不可见、普通用户不能管理用户、删除用户后 401）
- 总计 **123 条**

### 分享链接自动带主题参数（v0.44.1）
- 复制 / 在新窗口打开分享链接时，自动追加 `?theme=<当前主题>`（深色 / 浅色 / 米黄 / 午夜蓝）
- 旧的分享 token 仍可复用；重新打开分享弹窗复制一次，链接就会跟随当前主题
- 分享页仍保留 `?theme=` 覆盖与服务端记录的主题
- 金标新增 1 条，总计 **107 条**

### 模型可以自己安装技能（v0.44.0）
- 新工具 `install_skill({ url, name? })`：抓取 SKILL.md、解析 frontmatter、写入当前用户的技能库（同名覆盖）
- GitHub blob 链接自动转 raw；兼容「入口 stub」：`Call the Skill tool with "x"` 自动改写为 `load_skill("x")`
- 按「写入级」参与工具审批；工具名加入内置保留名
- 提示词明确：用户给 SKILL.md 链接时用 `install_skill`，不要往工作台写技能文件（工作台文件不会被注册）
- 冒烟与金标补充工具注册断言，总计 **106 条**

### 新用户登录后刷新数据（v0.43.2）
- 修复：登录页阶段面板已经用无 cookie 状态请求过一次，401 结果被缓存；新用户登录后技能 / MCP / 定时 / 文件 / 历史都显示「加载失败」
- 登录成功后整页重载，所有数据用新 cookie 重新加载；同时清掉上一账号的残留状态

### 首次进入默认浅色（v0.43.1）
- 未保存过主题时默认浅色（之前是深色）；已保存的主题与 `?theme=` 参数不变
- 首屏内联脚本同步改为浅色，避免先深后浅的闪烁
- 「跟随系统」仍按系统偏好解析

### 邀请码 + 独立空间 + 用户管理页（v0.43.0）
- 登录页改为「访问密码或邀请码」：主人密码行为不变，旧 cookie 继续有效
- 每个邀请码对应一个独立的 Durable Object：会话、文件、记忆、设置完全隔离
- 左侧导航新增「用户」（仅主人）：生成邀请码、复制、重置、删除；码只在生成时显示一次
- 邀请码 16 位无歧义字符（去掉 0/1/l/o），库里只存 SHA-256 哈希与尾号
- 删除用户后其 cookie 立即失效（每次请求校验注册表）；空间数据保留但无法再登录
- 分享链接带用户前缀（`u_xxx.token`），按前缀路由到对应空间；旧链接仍指向主人空间
- 修复：同一 isolate 承载多个 DO 时模块级 SQL / Harness 串数据（改用 AsyncLocalStorage 请求作用域）
- 安全：`/agent/*` 也纳入登录校验
- 新增 `UserRegistry` DO（迁移 v2）与 `GET/POST/DELETE /api/users`、`POST /api/users/reset`
- 金标新增 4 条，总计 **106 条**

### 输入框上方的模型 / 思考 / 上下文控制（v0.42.0）
- 聊天头部不再显示模型选择；模型与思考等级移到输入框上方右侧
- 新增思考等级下拉（不思考 / 低思考 / 高思考），写入全局设置
- 新增上下文占用条：百分比 + 已用 / 窗口（估算：最近一次模型用量 + 之后新增内容按字符折算）
- 新增「压缩」按钮：确认后调用手动压缩，15 秒内轮询刷新占用
- 新增 `GET /api/context?sessionId=`，返回 `{ usedTokens, contextWindow, percent, approximate }`
- 金标新增 1 条，总计 **102 条**

### 分享页标题目录（v0.41.0）
- Markdown 分享页自动生成目录（h1–h4），点击跳到对应标题
- 标题自动加锚点 id：保留中英文与数字，重复标题加序号（`重复` / `重复-2`）
- 少于两个标题不显示目录；最多列出 60 条
- 宽屏目录固定在左侧随页滚动，窄屏收到正文上方（最高 40vh）
- 对话分享里的标题也会汇总进目录
- 金标新增 1 条，总计 **101 条**

### 输入框高度可调 + 分享链接复用（v0.40.0）
- 消息输入框顶部新增拖动手柄：上下拖动调整高度（44–480px，不超过视口 60%）
- 双击手柄恢复内容自适应；聚焦手柄时可用 ↑/↓ 每次调 16px
- 高度记在 `localStorage`（`pi-harness.composer-height`），刷新与重启后保持
- 手动高度下内容超出时输入框内部滚动，不再挤压聊天区
- 桌面与移动端都可拖，触摸时不会带动页面滚动
- **分享链接复用**：打开文件分享弹窗时读取已有链接并直接展示，不再每次生成新 token；设置里的「分享当前会话」同样先复用
- 调整有效期后点「重新生成链接」才会创建新链接；已过期链接自动过滤
- 新增 `GET /api/shares?sessionId=&kind=file|conversation&name=`，返回未过期的分享链接
- 金标新增 3 条，总计 **100 条**

### 分享页跟随原主题（v0.39.1）
- 生成分享链接时把当前主题（深色 / 浅色 / 米黄 / 午夜蓝）记入 `shares.theme`，Markdown 与对话分享页按同一套 Arco 配色渲染
- 分享页改用 CSS 变量（`--bg` / `--panel` / `--border` / `--fg` / `--accent`），不再写死深蓝色
- 支持 `?theme=light|sepia|midnight` 临时覆盖；老链接默认深色
- HTML 文件分享仍原样输出（产物自带样式）
- 金标新增 1 条，总计 **97 条**

### 全站图标统一（v0.39.0）
- 引入 `lucide-react`（按需 tree-shake），新增 `components/Icon.tsx` 语义图标表：统一线性风格、1.75 描边、`currentColor`，颜色沿用 slate / sky / emerald / amber / violet 色系
- 替换范围：左侧导航与会话栏、聊天头部与目标/审批/问答条、工具调用与思考块、计划卡片、文件卡与工作台、设置弹窗五个 tab、分享弹窗、移动端底栏、Markdown 任务列表
- 去掉 emoji 图标（🗑 ⚙️ 🎯 💬 🔗 📄 等），同类操作只用一种图标：删除统一垃圾桶、收起统一双箭头、设置统一齿轮、文件统一文档、分享统一链接
- 主题选择器改用 Moon / Sun / Scroll / MoonStar，与主题语义对应
- 浅色 / 米黄主题下图标随文字色自动适配
- 依赖新增：`lucide-react ^1.59.0`（构建产物 +23 KB raw / +7.6 KB gzip）

### 金标
- 更新 1 条（Markdown 任务列表改为断言图标名），总计 **96 条**

### 分享弹窗新增「在新窗口打开」（v0.38.2）
- 生成链接后可直接在新标签页打开，不用先复制
- 用普通 `<a target="_blank" rel="noopener noreferrer">`，不受弹窗拦截影响

### 分享链接改用当前域名（v0.38.1）
- 修复：通过 pages.dev 反代访问时，服务端 `request.url` 是上游 workers.dev 地址，生成的链接在国内打不开
- 前端统一用 `window.location.origin + /s/<token>`（`shareUrlFor`），文件分享与会话分享都走这条逻辑
- 已生成的链接不用重建：把域名换成 `https://pi-harness-gw.pages.dev` 即可打开
- 金标新增 2 条，总计 **96 条**

### Markdown / HTML 文件分享 + 有效期（v0.38.0）
- 工作台打开 `.md` / `.html` 文件时，标题栏出现 🔗：选有效期（1 小时 / 1 天 / 7 天 / 30 天 / 永久）→ 生成链接 → 复制
- 链接带域名前缀（服务端用请求自身的 origin 拼），拿到链接的人**无需登录**即可打开
- Markdown：服务端渲染成完整分享页（标题 / 列表 / 代码块 / 引用 / 表格 / 任务项），手机可直接阅读
- HTML：原样输出，可交互；响应头带 `Content-Security-Policy: sandbox allow-scripts`，产物落在不透明源，读不到本站 cookie / Storage
- 过期：`shares.expires_at`（0 = 永久），过期页返回 **410** 并显示失效时间；创建新链接时顺手清理过期记录
- 会话分享接口同样接受 `ttlSeconds`；旧链接（无过期字段）行为不变，页脚显示「链接有效期至 …」
- `POST /api/share` 新增 `kind=file`、`name`、`ttlSeconds`；响应返回绝对 `url` 与 `expiresAt`
- 分享页统一 `noindex` / `no-referrer` / `X-Content-Type-Options: nosniff`

### 金标
- 新增 5 条（Markdown 渲染 / HTML + CSP / 过期 410 / 文件不存在 400 / 未知 token 404），总计 **94 条**

## 2026-10-20（冒烟接入 CI）

### 部署后自动冒烟 + 每 6 小时巡检（v0.37.2）
- `deploy.yml` 在 `wrangler deploy` 之后加一步：轮询 `/api/version` 等 DO 换到本次构建（最多 6 分钟），然后 `npm run smoke -- --deep`
- 新增 `smoke.yml`：每 6 小时 + 手动触发跑一次线上冒烟，抓「部署几天后才坏」的问题
- 密码走仓库 secret `SMOKE_PASSWORD`（已配置）；未配置时自动跳过而不是失败
- 冒烟脚本的 `--deep` 会清掉自己创建的会话，不在侧栏堆积

## 2026-10-20（线上冒烟测试）

### npm run smoke：部署后一条命令验收（v0.37.1）
- `scripts/smoke.mjs`：登录 → 打 10 个关键接口 → 逐项断言（首页 / 版本 / 能力注册表 / 工具清单 / 内核版本 / 会话 / 设置 / 待答问题 / 待审批 / 自定义工具）
- `--deep` 额外跑一次真实对话，断言 **codemode 实际执行成功**——专门防「接口都通但工具坏了」这类回归（审批那次就是这种）
- 密码从 `PI_PASSWORD` 或 macOS 钥匙串读，站点可 `PI_BASE` 覆盖；失败退出码 1

### 金标
- 冒烟脚本本身不占金标用例（它打线上，不进 CI 单测）

## 2026-10-20（交互式问答卡片）

### ask_user：把「问你几个问题」变成可点的卡片（v0.37.0）
- 新工具 `ask_user`：一次问 1–6 题，每题可带选项（`recommended: true` 标推荐）与自由输入
- 提问记录进 `questions` 表，工具返回「已提交，等待回答」，本轮结束
- 聊天输入框上方渲染**问答卡片**：题号、选项单选、推荐徽标、自由输入框、提交按钮
- 提交后服务端生成结构化回报（`- q1「问题」：答案`）并自动发回模型继续，不用手动重述
- `GET /api/questions`、`POST /api/questions {id, answers}`
- **与目标模式联动**：有待回答问题时会暂停自动续转（请求内与 alarm 两条路径都处理），答完再继续
- 系统提示里加了使用指引：需要用户决策时用 ask_user，而不是在正文里罗列问题
- 实测：两题卡片选中「老板 / 要」→ 提交 → 模型据此确认报告定位并继续

### 金标
- 新增 4 条（空列表 / 缺 id / 不存在 / 工具注册），总计 **89 条**

## 2026-10-20（自定义工具 + 项目身份）

### 用户贴 JS 即成为工具（v0.36.0）
- **`custom_tools` 表**：工具名 / 描述 / 参数 JSON Schema / 代码；`GET/POST/DELETE /api/custom-tools`
- **执行在 QuickJS 沙箱**（复用 codemode 的内联沙箱，32 MB 内存、15 秒超时）：代码是函数体，`args` 是入参，返回值即工具结果；返回值自动 JSON 序列化
- **注册时机**：与 MCP 一样在 `Harness.open` 之前构建并 `registry.install`，每轮 `configure()` 带上 → 新工具对已有会话也生效
- **安全**：自定义工具归 **exec** 级，默认跟随工具审批策略；参数 schema 必须是 `{"type":"object"}`；工具名不能覆盖内置工具
- **界面**：能力面板新增「🧩 自定义工具」折叠区，含名称/描述/schema/代码表单与删除
- 实测：新增 `word_count` → 模型调用 → 返回 `{"chars":15,"words":3}`

### 项目身份写进 instructions
- 系统提示里明确「你在 scudong/pi-harness」，避免与 GitHub 上同名项目（如 wangmiaozero/pi-harness）混淆

### 金标
- 新增 5 条（非法名 / 内置名 / schema 非对象 / 空代码 / 增删与分级），总计 **85 条**

## 2026-10-20（pi 内核版本管理）

### 内核版本可见 + 手动/自动升级 + 兼容性门禁（v0.35.0）
- **运行时可见**：`GET /api/kernel` 返回四个内核包（pi-durable / pi-ai / pi-mcp / pi-codemode）的声明版本、npm 最新版本、是否可升级；最新版本缓存 6 小时，`?refresh=1` 强刷
- **设置 → 通用 → pi 内核**：显示每个包的版本，发现新版本时标黄并给出升级路径，带「检查更新」按钮
- **手动升级**：`npm run upgrade:pi`（`scripts/upgrade-pi.mjs`）——查最新版 → 安装 → `build:web` → 全部金标 → `wrangler deploy --dry-run` 打包校验；**任何一步失败自动回滚 package.json / package-lock.json**
- **自动升级**：`.github/workflows/pi-upgrade.yml`，每周一 09:00 UTC 检查，有更新就开 PR（也可在 Actions 手动触发）；PR 合并后走既有部署流水线
- **兼容性**：升级脚本把「构建 + 80 条金标 + Workers 打包校验」作为硬门禁；`tests/unit/kernel.test.ts` 额外守住四个包版本锁步、升级入口与工作流存在
- 顺带把 `@earendil-works/pi-codemode` 显式写进 dependencies（此前是传递依赖但直接 import）

### 金标
- 新增 4 条（内核包声明 / 版本锁步 / 升级入口 / 脚本与工作流存在），总计 **80 条**

## 2026-10-20（生成中插话）

### 流式插话：生成中补一句话（v0.34.0）
- 后端 `POST /api/interject {sessionId, message}`：用 pi-durable 的 `submit(..., {whenBusy:"steer"})` 提交
- steer 输入在**下一个边界**（通常是下一次工具调用之后）被放进本轮，不打断当前生成；会话空闲时等同普通发送
- 输入框在生成中显示「插话」按钮（有文字时才出现），Enter 也走插话；停止按钮保留
- 插话立即以用户气泡显示，随后一条提示「已插入本轮：模型会在下一次工具调用后看到」
- 实测：长任务生成中插入「最终回答最后一行必须是『收到插话 v0.34』」，转录里出现两条 `pi.user`，模型继续跑完

### 金标
- 新增 1 条（空插话被拒绝），总计 **76 条**

## 2026-10-20（修复 codemode 回归）

### 修：审批包装漏传第三个参数导致 codemode 报 abortSignal 错误（v0.33.1）
- 原因：`withApproval()` 只转发了 `(args, api)`，而工具 `execute` 的第三个参数是调用上下文（含 `abortSignal`），codemode 在初始化时读它 → `Cannot read properties of undefined (reading 'abortSignal')`
- 修复：包装层改为 `(...rest)` 原样转发全部参数
- 加上回归验证：本地实测 codemode `123*456 = 56088`

## 2026-10-20（工具审批）

### read / write / exec 三档审批 + 逐工具覆盖（v0.33.0）
- 工具按三档分级：**读取**（read_file / web_search / recall / update_plan…）、**写入**（write_file / remember / MCP 工具）、**执行**（codemode / dispatch_tasks）
- 每档三种策略：**放行**（默认，行为不变）/ **询问**（聊天里出现待审批条）/ **禁止**（直接拒绝并提示去设置里改）
- **待审批条**（输入框上方）：显示工具名、级别、参数预览，三个按钮「允许一次 / 始终允许 / 拒绝」；决定后自动把结果告诉模型让它继续（拒绝则让它改方案）
- **逐工具覆盖**：设置 → 对话 → 工具审批，16+ 个内置与 MCP 工具各有一个「跟随分级 / 放行 / 询问 / 禁止」下拉
- 审批闸门套在 `spike` / `codemode` / `tool-search` / `mcp` 四类扩展的 execute 外面，codemode 脚本里嵌套调用的工具同样受控
- 子代理会话（侧栏不可见）自动放行，避免子任务卡在没人能点的审批上
- `GET /api/approvals`、`POST /api/approvals {id, action}`、`GET /api/tools`；能力注册表新增「工具审批」
- 实测：写=询问 → 模型提交审批（#1）→ 允许一次 → 自动续跑 → 文件落盘；执行=询问 → codemode 同样被拦下并记录参数

### 金标
- 新增 5 条（分级映射、策略跟随、逐工具覆盖优先、非法决定、空列表），总计 **75 条**

## 2026-10-20（会话分支 + 面板伸缩）

### 会话分支：从任意消息分叉（v0.32.0）
- `POST /api/branches {sessionId, entryId}` → 调 pi-durable 的 `conversation.fork(at)`，新会话**继承分叉点之前的全部历史**，之后各自追加互不影响
- 分叉点取「这条消息的**前一条**」：新会话历史停在上一条，可以直接换个问法，不会把原问题再答一遍
- `sessions_meta` 新增 `parent_id` / `fork_at`，`GET /api/sessions` 一并返回
- 聊天里用户消息悬停出现「⑂ 分支」按钮（第一条消息没有历史，不显示）
- 侧栏按分支关系渲染成树：子会话缩进 + ⑂ 图标；父会话被删时子会话自动回到顶层
- 会话标题默认 `⑂ 父会话标题`

### 面板伸缩（v0.32.0）
- **会话栏可拖拽调宽**：拖右侧分隔条，范围 200px ~ 视口 45%，宽度记在 `localStorage`（`pi-left-width`）
- **左栏收起 / 展开**：会话栏、连接、定时、能力四个面板标题栏都有「«」；收起后聊天顶栏左侧出现「»」展开
- **工作台收起 / 展开**：文件列表与文件预览标题栏都有「»」；收起后聊天顶栏右侧出现「«」展开
- 拖拽宽度在 `pointerup` 时以最后一次拖动的值为准，避免快速拖动丢掉最终位置

### 金标
- 新增 8 条（分支树 6 条 + 分支 API 2 条），总计 **70 条**

## 2026-10-19（HTML 预览高度修复）

### 修：HTML 文件预览只占窗口一半（v0.31.1）
- 原因：iframe 的 `h-full` 依赖父级有确定高度，而包裹层高度是 auto（由内容撑开）→ 百分比失效，回落到默认高度
- 修复：HTML 预览时给包裹层补 `h-full`，高度链「滚动容器 → 包裹层 → iframe」打通，iframe 铺满右栏
- 本地 1440×900 实测：demo.html 预览从半屏变为整屏

## 2026-10-19（目标模式 + 压缩收尾）

### 目标模式：目标 + token 预算 + 自动续转 + 完成硬校验（v0.31.0）
- **一个会话一个目标**（`goals` 表）：目标描述、token 预算（默认 20 万）、最大续转轮次（默认 12）
- **自动续转**：每轮结束后若目标仍在进行，自动提交「继续推进目标」提示并接着跑
  - 单次请求内最多续转 3 轮（`GOAL_ROUNDS_PER_REQUEST`），剩下的交给 DO alarm 跨请求接续（15 秒后）
  - 每次续转前端都能看到新的助手气泡 + 「🎯 继续推进目标（第 N 轮）」提示，不是黑盒
- **token 记账**：读 `pi.usage` 会话账本（models + tools 两个桶），按目标建立时的基线算增量
- **完成硬校验** `complete_goal`：必须给 ≥10 字的验证证据；如果 `update_plan` 里还有未完成步骤会**被拒绝**
- **受阻出口** `report_goal`：模型说明缺什么、状态转 blocked、停止续转
- 预算或轮次用尽 → 状态 `exhausted`，自动收尾不再续转
- **界面**：
  - 聊天顶栏新增「🎯 目标」按钮 → 弹窗填写目标 / 预算 / 轮次，点开始后立刻发第一轮
  - 输入框上方常驻**目标条**：状态、第几轮、token 进度条、停止 / 新目标
  - SSE 新增 `goal` 帧（continuing / finished / scheduled）
- `GET/POST/DELETE /api/goal`；备份恢复纳入 `goals`；删除会话时目标自动暂停
- 实测（本地 + 真实模型）：单轮目标 1 轮完成并给出证据；三阶段目标 3 轮完成（`turns=2`、25,874 tokens）；`maxTurns=1` 正确进入 `exhausted`

### 压缩收尾：聊天提示 + 手动压缩（补完 P0）
- SSE `compaction` 帧渲染成聊天提示：开始「上下文较长，正在压缩更早的内容…」→ 结束「上下文已压缩」
- 历史回放：`pi.compaction` 条目解析成一条系统提示，刷新后仍能看到
- 设置 → 对话 →「立即压缩当前会话」按钮（`POST /api/compact`），完成后回显

### 金标
- 新增 5 条：目标模式 CRUD（空目标拒绝 / 建立→读取→停止 / 覆盖）、`pi.compaction` 解析、目标工具注册防回归，总计 **62 条**

## 2026-10-19（能力注册表 + 提示模板 + 规则 + 压缩配置）

### 三类能力统一注册，数据型能力可运行时加载（v0.30.0）
- **能力注册表** `GET /api/capabilities`：把能力分三组汇总成一张表
  - **内置**（编译进 bundle，靠 `registry.install`）：Code Mode、工具搜索、上下文压缩、计划清单、子代理、联网搜索
  - **数据**（运行时从 DO 加载）：技能、提示模板、规则文件
  - **协议**（运行时配置）：MCP 服务器、模型供应商
- **提示模板**（`prompts` 表 + CRUD）：输入框打 `/` 与技能一起出现在菜单（⚡ 技能 / 📝 模板）；选中模板会把**正文填进输入框**而不是发 `/名字`
  - `lib/template.ts` 支持 `$1..$9`、`$@` / `$ARGUMENTS` 占位符，缺参时保留占位符
- **规则文件**（`rules` 表 + CRUD + 启用开关）：启用的规则每轮以「## 项目规则（必须遵守）」注入 instructions
- 左侧工具栏「技能」更名「**能力**」，面板内新增「📝 提示模板」「📏 规则」两个折叠区（含新增表单、逐条删除、规则启用勾选）
- **上下文压缩可配置**：设置 → 对话 新增「上下文压缩」——开关 + 保留原文 tokens + 预留回答 tokens；改动后重建 Harness 下一轮生效
- `POST /api/compact` 手动触发压缩（v0.30.0 接口先行，UI 按钮后续接）
- 备份/恢复纳入 `prompts` 与 `rules`
- 金标新增 10 条（模板展开、模板 CRUD、规则 CRUD + 开关、能力注册表结构、计数跟随），总计 **57 条**

## 2026-10-19（子代理编排）

### dispatch_tasks：可并行的子代理（v0.29.0）
- 新工具 `dispatch_tasks`：把 2–4 个**互不依赖**的子任务并行分派给子代理，各自独立完成后汇总
- 每个子代理是一个独立会话（不影响主对话上下文），只用**只读类工具**（now / recall / read_file / list_files / http_fetch / web_search / web_fetch_page / codemode），避免并发写文件或记忆
- 子代理会话在 `sessions_meta.hidden = 1`，**不出现在侧栏**；标题形如「子代理 1：查 Deno 版本」，可在备份里看到
- 提示词里告诉模型：有 2–4 个可并行的独立任务时优先用 `dispatch_tasks`
- 聊天里渲染成一条绿色 pill：徽标显示「N 个子代理」，展开先列子任务标题，再按 Markdown 渲染汇总结果（历史回放同样生效——从结果首部反解标题）
- 实测：两个子任务并行（2.8s / 17.0s）各自查到 Deno v2.9.7 与 Bun v1.4.3 并正确汇总
- 同时补了 3 条金标：工具注册表防回归（`/api/debug/agent` 必须含 dispatch_tasks 等 8 个工具）、codemode 可调用工具清单、子任务标题反解

## 2026-10-19（金标回归测试体系）

### 每个功能配金标用例，CI 卡门禁（v0.28.0）
- 引入 **Vitest**，新增 44 条确定性用例，`npm test` 一条命令全跑（约 3 秒）
- **单元金标**（30 条，纯函数，毫秒级）：
  - `rich.test.tsx`：Markdown 标题/表格（含「分隔行不入数据行」）/ 任务列表 / 嵌套列表 / 代码块 props / HTML 与 `javascript:` 链接的 XSS 防护 / 行内格式
  - `entries.test.ts`：转录倒序自动反转、思考块提取、工具归属、`write_file` 文件产出、空输入与未知 kind 容错
  - `theme.test.ts`：四套主题注册表、`isThemeId`、无 DOM 环境下安全降级
  - `format.test.ts`：文件大小与时间格式化
- **接口金标**（14 条，自动 `wrangler dev --persist-to tests/.tmp-state`，用完即清）：访问控制、会话增删改查、思考档位读写、**模型供应商全链路**（新增/掩码/启用/模型跟随/切回默认/删除/404/缺密钥 400）、技能、记忆一键清空、备份键完整性、恢复、导出、版本
- **CI 门禁**：`.github/workflows/deploy.yml` 在 `wrangler deploy` 前插入 `npm test`，用例不过不部署
- 文档：`tests/README.md` 写明「一个功能至少一条用例」的约定、目录结构、启动方式与已知未覆盖项
- 顺带修了用例暴露出的两个真实问题：`applyTheme` 在无 DOM 环境会抛错；文件产出原先挂到上一条助手消息，改为与工具 pill 一致挂到下一条

## 2026-10-19（LLM 供应商管理）

### 设置新增「模型」tab：CCswitch 式供应商切换（v0.27.0）
- 新增 **LLM 供应商** 管理，任意 OpenAI 兼容端点都能接入：
  - 字段：名称 / Base URL / API Key / 模型 ID 列表（逗号分隔）
  - 列表里显示当前生效项（`使用中` 高亮）+ 密钥掩码（`••••1234`）
  - 每项可 **启用 / 编辑 / 删除**；编辑时 API Key 留空 = 保持原值
  - 内置「DeepSeek 官方」作为默认项，随时可切回
- 切换后：`/api/models` 返回新供应商的模型，聊天顶栏的模型选择器立即更新；已开会话需要重新选模型
- 后端用 pi-ai 的 `createProvider` + `openAICompletionsApi()` 动态构造 Provider，供应商配置存 DO（`providers` 表），随备份/恢复迁移
- 新增接口：`GET/POST/DELETE /api/providers`、`POST /api/providers/activate`
- 实测：新增 Moonshot（kimi-k2 / kimi-k1.5）→ 启用 → 模型选择器变 `kimi-k2` → 切回默认恢复 `deepseek-flash`

## 2026-10-19（设置分 tab + 记忆清空）

### 设置弹窗按子功能分 tab（v0.26.0）
- 原来一长条的设置项拆成四个 tab：
  - **通用**：外观（四套主题）、布局（左右栏开关）、账号（退出登录）
  - **对话**：思考档位、网页搜索
  - **记忆**：记忆库列表（可单条删除）
  - **数据**：分享 / 导出 / 备份 / 恢复
- 弹窗改为「标题 + tab 栏 + 滚动内容区」三段式，不再需要滚很久才能看到底部
- 每次打开回到「通用」tab；Esc 仍可关闭

### 记忆库一键清空
- 新增 `DELETE /api/memories?all=1`，返回实际删除条数
- 记忆 tab 右上角「清空全部」按钮，执行前二次确认（提示条数）
- 实测：本地 34 条 → 返回 `{"ok":true,"deleted":34}` → 列表清空

## 2026-10-19（产出文件配色 + 统一宽度 + Markdown 排版）

### 气泡宽度统一 / 产出文件配色 / 排版规范化（v0.25.2）
- **产出文件**新增独立配色 **Arco cyan**（`#14C9C9` 系列）：文件卡、产出清单的边框、图标、文件名按钮都是青色，与工具调用（绿）、思维链（紫）区分开
- **统一气泡宽度**：思维链块、计划卡、工具 pill、文件卡、产出清单、助手正文统一为**整栏满宽**，左对齐；只有用户消息保持右对齐窄气泡（区分「我说的」和「系统活动」）
  - 工具 pill 从自适应宽度改成整行，长摘要自动截断
- **Markdown 排版**：新增 `.md-prose` 排版层，标题/代码/表格用 `em` 相对缩放，字号跟随容器——窄栏 12px、文件预览 14→16px（随屏幕宽度）、聊天气泡 15px，比例始终一致
- 文件预览正文改为**响应式字号** `14px → 15px(sm) → 16px(xl)`，标题层级、列表缩进、引用、表格边框、代码块留白全部规范化
- **修复**：Markdown 表格的分隔行（`| --- |`）被当成数据行渲染——重构时把布尔判断换成了返回 `undefined` 的 `parseAlign`，已改为独立的 `isSeparatorCell`

## 2026-10-19（工具/思维链配色对齐）

### 工具调用与思维链改用 Arco 语义色（v0.25.1）
- **工具调用**：从 Tailwind 默认绿换成 Arco green（`#00B42A` 系列）；深色下用 green-9/3 做底与字，浅色下底为 green-1 `#E8FFEA`、字为 green-8 `#007A21`
- **思维链**：从 Tailwind 默认紫换成 Arco purple（`#722ED1` 系列）；深色底 `#1E1233`、字 `#C396ED`，浅色底 `#F5E8FF`、字 `#3C108F`
- 思维链块的背景透明度从 `20%` 提到 `50%`、边框 `25%→35%`，深色下层次更清楚
- 错误气泡（Arco red `#F53F3F`）与警示条（Arco orange `#FF7D00`）一并换成对应色卡
- 浅色系下这些 `*-950` 底色统一改成色卡最浅一级，`bg-*-950/40` 才呈现为淡淡的同色背景

## 2026-10-19（字节系色卡）

### 改用 Arco Design 调色板（v0.25.0）
- 四套主题的中性色与强调色全部换成 **Arco Design（字节跳动开源设计系统）** 的色卡：
  - 灰阶 `gray-1..10`：`#F7F8FA #F2F3F5 #E5E6EB #C9CDD4 #A9AEB8 #86909C #6B7785 #4E5969 #272E3B #1D2129`
  - 品牌蓝 `arcoblue`：`#165DFF`（浅 `#4080FF` / `#6AA1FF` / `#94BFFF`，深 `#0E42D2`）
  - 金 `gold`：`#F7BA1E`（`#D99800` / `#B37A00`）
- **深色** 改为 Arco Dark（页面 `#17171A`、面板 `#232324`），主按钮为品牌蓝 `#165DFF`
- **浅色** 改为 Arco Light（页面 `#F7F8FA`、卡片 `#FFFFFF`、分隔 `#E5E6EB`）
- **米黄** 改用 Arco 金色系（暖底 + 金色强调），替换原先的青色
- **午夜蓝** 用 arcoblue 压暗做中性底
- 主题元数据（浏览器地址栏色、选择器色块）同步更新

## 2026-10-19（浅色/米黄样式修正）

### 浅色系可读性调整（v0.24.1）
- **开关**：关闭态轨道从 `slate-700` 改 `slate-600` 并给滑块加描边，浅底上不再「看不见滑块」
- **紫色选中按钮**（思考档位）：`bg-violet-600 text-white` 之前被全局 `.text-white` 改成深色，现补进实心色例外表（同时补 sky-600/90、emerald/indigo/amber 等）
- **hover:text-white**：浅底上悬停变白字会消失，浅色系统一改回深色；实心强调色按钮仍保持白字
- **语义色反转**：工具 pill（emerald）、思考块（violet）、错误气泡（rose/red）、计划进行中步骤（sky-200）原本是「深底浅字」，浅色系下统一反转成「浅底深字」
- **吸顶计划卡**：背景改为不透明，滚动时不再透出下方正文
- **弹窗**：浅色/米黄下遮罩从 `black/60` 降到 `slate-900/32`，边框与分节线加深，数据按钮加 `shadow-sm`

## 2026-10-19（四套主题）

### 新增米黄、午夜蓝主题（v0.24.0）
- 外观从「深/浅」两套扩展为**四套**：深色（默认）、浅色、**米黄**（暖色浅底，长时间阅读更柔和）、**午夜蓝**（冷色深底）
- 设置 → 外观改为四宫格选择器，每格带色块预览
- 实现沿用变量覆盖：只改 `--color-slate-*` 调色板 + 少量对比度修正，组件零改动
- `?theme=sepia` / `?theme=midnight` 可直接指定；`pi-theme` 记住选择，首屏内联脚本防闪烁
- 主题逻辑抽到 `lib/theme.ts`（`THEMES` / `readTheme` / `applyTheme`）
- 实测四套主题的 `<html>` class 与 body 背景色：`theme-sepia` #f4eee1、`theme-midnight` #060b18、`theme-light` #f8fafc、深色 slate-950

## 2026-10-19（输入框调用技能）

### 输入框 `/` 唤起技能（v0.23.0）
- **输入框输入 `/`** 自动弹出技能菜单（名称 + 描述，↑↓ 选择 / Enter 确认 / Esc 取消 / Tab 也可确认），选中后写入 `/技能名 `
- 输入框左侧新增 **⚡ 按钮**，点击在光标处插入 `/` 并展开菜单
- **后端识别**：消息以 `/技能名` 开头且命中已安装技能时，把该技能完整正文注入本轮 instructions，并告诉模型「严格按它执行」；未命中则当普通消息处理
- 转录保留 `/技能名` 原文（与气泡一致），技能正文只进本轮提示词，不写进对话历史
- 会话标题取去掉 `/技能名` 后的内容
- 实测：`/债券研报摘要 帮我提炼…` 输出严格遵循技能的「核心结论/关键数据/风险点/对投资的含义」结构，并遵守「不编造未出现数字」的约束

## 2026-10-19（右栏布局还原）

### 关闭文件预览后右栏没恢复（v0.22.1）
- 症状：打开文件时右栏自动加宽到 560px，关掉标签页后仍停在 560px；在全宽阅读模式下关闭文件，聊天栏还会一直隐藏
- 原因：`handleFileOpenChange` 只在 `open === true` 时动作，`false` 直接 return；全宽模式也没退出
- 修复：打开前记住原宽度，关闭时还原并退出全宽；用户在看文件时手动拖过分隔条则以手动值为准
- 同时补齐两条没通知外层的关闭路径：删除正在看的文件、文件列表刷新后文件消失
- 实测：340 → 560（打开）→ 340（关闭）；全宽 1208 + 聊天隐藏 → 340 + 聊天恢复

## 2026-10-19（Codex 式对话展示）

### 思考过程 / 计划 / 工具轨迹 / 文档卡 / Markdown（v0.22.0）
- **思考过程**：后端开 `thinkingLevel`（deepseek-flash 支持 low/high），SSE 新增 `thinking_start` / `thinking` 帧；聊天里渲染为可折叠的紫色「思考过程」块，流式时自动展开、完成后收起，历史回放也能看到（解析 `thinking` 内容块）
- **计划列表**：新增 `update_plan` 工具 + `plans` 表；聊天顶部**吸顶计划卡**，带进度条与 ✓/◐/○ 三态，全部完成后自动收成一行；模型多步任务会自己列计划
- **工具轨迹**：SSE 工具事件带 `toolCallId` / `parentToolCallId`，codemode 脚本里的内嵌调用挂到父调用下显示（「N 子调用」可展开），不再塌缩成一条
- **文档产出**：`write_file` 名字直接从工具入参取，流式中出「文件卡」；历史回放时在会话末尾显示「产出文件」清单，点击直接在右栏打开
- **Markdown 渲染升级**：任务列表 `- [ ]`、嵌套列表、`*斜体*` / `~~删除线~~`、图片、代码块带语言标签与**复制按钮**、表格对齐与斑马纹；助手气泡改用完整 Markdown（之前只处理行内格式）
- **设置页新增「思考过程」**：关闭 / 低 / 高，默认低；关闭后不产生 reasoning token
- **修复历史消息倒序**：`/api/entries` 返回倒序而前端没反转，聊天一直是「新消息在上」，工具结果还会挂到错误的助手消息上——现在按 id 自动判断并反转
- 验收：CDP 驱动真实浏览器点击截图（吸顶计划、思考块展开、流式中表格、任务列表、设置页）

## 2026-10-19（左栏工具栏 + 右栏专注预览）

### 布局重构（v0.21.0）
- **最左侧新增固定工具栏**（Rail，48px）：新会话 ＋ · 会话 💬 · 连接 🔌 · 定时 ⏰ · 技能 ⚡，底部 ⚙ 设置；图标切换对应的左侧面板，会话栏可独立折叠
- **右侧工作台只保留文件预览**：文件列表 + 预览/源码/全宽阅读；连接、定时、技能整体移到左栏
- **记忆库移入设置弹窗**：可查看/删除，自动抽取的记忆标注「自动抽取」；侧栏底部的「记忆库」入口与工作台「记忆」tab 移除
- 移动端：抽屉里是「Rail + 会话列表」，底部导航改为 聊天 / 文件 / 设置
- 顺手修复：技能面板的「URL 导入 + 社区安装」区块曾整段重复渲染两次
- 视觉验收：Chrome CDP 驱动点击截图（桌面四栏、三个左栏面板、设置弹窗、移动端抽屉）

## 2026-10-19（设置页 + 联网搜索）

### 设置页与 DeepSeek 联网搜索（v0.20.0）
- **设置页**（参照 Codex/Trae）：顶栏右侧按钮全部收进「设置」弹窗——主题、会话栏/工作台开关、分享、导出、备份、恢复，并新增「退出登录」；顶栏只保留品牌、状态与 ⚙ 入口
- **DeepSeek 联网搜索**：新工具 `web_search`（`POST /v1/tools/search`，返回标题+链接+摘要列表）与 `web_fetch_page`（`POST /v1/tools/fetch`，返回干净 Markdown 正文），复用现有 `DEEPSEEK_API_KEY`
- 搜索开关在 **设置 → 网页搜索**（默认开启；关闭后模型调用工具会得到「到设置中开启」的提示），按成功请求计费（约 ¥5/1000 次）
- 设置持久化在 `app_settings` 表，随备份/恢复迁移；新增 `GET/POST /api/settings`
- 实测：搜索「DeepSeek 最新模型」返回带日期的真实链接；抓取 `api-docs.deepseek.com` 指南页返回完整 Markdown

## 2026-10-19（真正的停止）

### 停止按钮改为服务端中止（v0.19.0）
- 新增 `POST /api/abort {sessionId}` → `conversation.abort()`：撤回排队输入、中止当前生成并等待会话空闲
- 前端「停止」先调中止接口再断开 SSE，避免「界面停了但服务端继续跑、继续烧 token」
- 中止后会话仍可继续对话（不会进入失败态）

## 2026-10-19（免本地浏览器的网页操作）

### MCP 请求头 + Browserbase 接入（v0.18.0）
- MCP 服务器支持自定义**请求头**（表单新增「请求头名/值」两栏），用于 API key 类服务
- 延迟披露阈值从 6 提高到 **12**：6–9 个工具的服务器（如 Browserbase）直接可用，更大的集合才走 tool_search
- 实测 Browserbase MCP（`https://mcp.browserbase.com/mcp`，请求头 `x-bb-api-key`）：
  `start` → `navigate` → 读标题 `Example Domain` → `end` 全部成功，无需本地 Chrome

### 说明
- API key 存在 DO 的 `mcp_servers.headers` 里（随备份导出，注意备份文件保密）

## 2026-10-19（社区技能）

### 安装 pi 社区技能（v0.17.0）
- 技能遵循 Agent Skills 规范（`SKILL.md` + YAML frontmatter）
- `GET /api/skills/community`：内置 `badlogic/pi-skills` 目录（brave-search / youtube-transcript / browser-tools / transcribe / gdcli / gccli / gmcli / vscode），标注「需本地命令行」
- `POST /api/skills/import {url}`：支持 GitHub 目录/文件链接、raw 链接、任意 `.md`；自动规范化到 SKILL.md 并解析 frontmatter
- 技能页新增「从社区安装」列表（一键安装/重装）与 URL 导入框

### 修复：定时任务与对话并发破坏会话
- 症状：`SessionFailed: Session failed after a storage error; close and reopen it`，且之后该会话所有请求都失败
- 原因：定时任务在会话正忙时仍然 `submit`，并发写入破坏 `pi.live` 文档
- 修复：`activeChats` 记录进行中的会话，忙时把定时任务顺延 5 分钟；`chat`/`chatStream` 出错若为存储类错误则 `close + reopen` Harness 自愈

## 2026-10-19（右栏可伸缩）

### 右栏不再固定 320px（v0.16.0）
- **拖拽分隔条**调整宽度（260px ~ 视口 65%），宽度写入 `localStorage.pi-right-width`
- **打开文件自动加宽**：当前宽度 < 560px 时自动拉到 560px，保证文档可读
- **全宽阅读（⤢）**：文件视图新增按钮，切换后右栏占满剩余空间、桌面上隐藏聊天栏、正文居中限宽 `max-w-4xl`；再点一次返回
- 修复：全宽时右栏曾按固定宽度计算导致右侧留白

## 2026-10-19（技能 / 预览 / 侧栏）

### 技能扩展与按需加载（v0.15.0）
- `skills` 表 + `GET/POST/DELETE /api/skills`；工作台新增「技能」tab（名称+描述+正文，可展开预览、删除）
- 提示词自动注入技能索引（名称+用途），模型需要时调用 `load_skill` 读取完整正文，`list_skills` 可随时查看
- 技能纳入 `/api/backup` 与 `/api/restore`

### Markdown / HTML 预览增强
- Markdown 渲染补齐：1–6 级标题、有序/无序列表、代码块、引用、分隔线、管道表格、行内代码与安全链接
- `.html/.htm` 文件用 **sandbox iframe**（`allow-scripts`）渲染，可直接看生成的网页

### 侧栏自动扩展
- 首次进入按视口宽度决定：宽度 ≥1024 展开左栏、≥1280 同时展开右栏；窗口跨断点自动跟随
- 用户手动切换后写入 localStorage，此后以用户选择为准

### 其他
- 工作台 tab 过多时改为横向滚动、不换行

## 2026-10-19（备份 / 恢复）

### 全量备份与恢复（v0.14.0）
- `GET /api/backup` → JSON（记忆、文件、定时任务、MCP 配置、会话元数据、分享记录；对话正文请用 `/api/export`）
- `POST /api/restore` → 按主键 upsert 合并，**不删除现有数据**；记忆按内容去重
- 顶栏新增备份（下载）/ 恢复（选文件上传）两个按钮，恢复后提示各类写入条数
- 验证：本地备份 21 记忆 / 4 文件 / 1 定时 / 1 MCP / 6 会话；原样恢复无重复（记忆 0 新增，其余覆盖）

## 2026-10-19（工具搜索）

### 工具搜索与延迟披露（v0.13.0）
- 安装 `createToolSearchExtension()`：模型可用 `tool_search` 搜索尚未披露的工具并按需加载
- MCP 工具总数 **≥ 6** 时标记为 `deferred`（不进模型工具列表），避免工具过多撑爆上下文；少于阈值时直接可用
- 与 codemode 并存：脚本内 `searchTools()` 也能发现被延迟的工具（两条发现路径）
- 验证：阈值调为 1 时 deepwiki 三个工具进入 `deferred`，模型经搜索后成功调用并拿到真实回答

## 2026-10-19（图片输入 + 历史修复）

### 图片输入（v0.12.0）
- `POST /api/chat` 与 `/api/chat/stream` 接受 `images: string[]`（data URL，最多 4 张），转为 pi-ai `ImageContent` 内容块提交
- 输入框新增 📎 附件按钮 + 粘贴图片；前端压缩到最长边 1568px（有透明保 PNG，否则 JPEG 0.85），带缩略图预览与移除
- 用户气泡渲染图片；导出/分享仍只取文字

### 修复：历史消息不显示（重要）
- `GET /api/entries` 返回的是**数组**，前端却按 `{ entries }` 读取 → 历史一直为空（界面停在「开始与 π 对话」）
- 条目 `kind` 形如 `pi.user` / `pi.assistant`，解析时未去前缀 → 进一步导致匹配失败；现已统一归一化
- 工具活动 pill 的 `toolName` / 内容在 `model[0]` 里，已补充解析（此前显示为空 pill）
- 助手仅含工具调用时不再渲染空气泡

## 2026-10-19（主题切换）

### 浅色 / 深色主题（v0.11.0）
- 顶栏新增主题切换按钮（太阳/月亮），选择写入 `localStorage.pi-theme`，首屏内联脚本先行应用避免闪烁
- 实现方式：浅色主题直接反转 Tailwind v4 的 `--color-slate-*` 等调色板变量，组件代码零改动
- 对比度修正：选中会话（`bg-sky-500/15` + `text-white`）在浅底上改为深色文字；实心主按钮保持白字
- 支持 `?theme=light` URL 参数（便于分享/截图）

## 2026-10-19（访问控制）

### 访问密码登录（v0.10.0）
- 环境变量 `ACCESS_PASSWORD`（wrangler secret）；未设置时服务保持开放（向后兼容）
- `GET /api/auth` 返回是否需要登录；`POST /api/login` 校验后下发 `pi_access` cookie（HMAC-SHA256，HttpOnly/Secure/SameSite=Lax，30 天）；`POST /api/logout` 清除
- 外层 Worker 统一拦截：`/api/*` 未登录返回 401；`/s/*` 分享页保持公开
- 改密码 = 全部会话立即失效（token 由密码派生）
- 前端未登录时显示整屏登录闸门
- 注意：本版本之前部署是**完全开放**的，若曾暴露需更换 DeepSeek key

## 2026-10-19（只读分享）

### 只读分享链接（v0.9.0）
- `POST /api/share {sessionId, kind}` → 随机 token；`GET /s/<token>` 返回服务端渲染的只读页（深色、移动端友好）
- `shares` 表记录 token；`wrangler.jsonc` 的 `run_worker_first` 增加 `/s/*`
- 顶栏分享按钮：生成链接并自动复制到剪贴板
- 注意：当前整套服务没有登录鉴权，分享链接的意义是「只读视图」而非访问控制；token 不可猜测（12 位随机）

## 2026-10-19（定时任务）

### 定时任务（v0.8.0）
- `automations` 表 + `GET/POST/PATCH/DELETE /api/automations`
- 调度基于 **Durable Object alarm**（pi-durable 不含 cron）：每次变更重算最早 `next_run_at` 并 `setAlarm`
- 支持「每天 HH:MM（UTC+8）」与「每隔 N 分钟」；到点在指定会话里自动执行提示词，执行完自动排下一次
- 工作台新增「定时」tab：创建 / 暂停启用 / 删除，显示调度说明与下次执行时间
- 验证：建 1 分钟间隔任务，到点自动在会话里调用 `now` 工具并回报时间

## 2026-10-19（对话导出）

### 会话导出 Markdown（v0.7.0）
- `GET /api/export?sessionId=&format=md` 返回完整转录（用户/助手消息 + 工具调用摘要），带 `Content-Disposition` 文件名
- 顶栏新增下载按钮，一键导出当前会话
- 条目按 id 倒序存储，导出时反转成时间正序

## 2026-10-19（多模型切换）

### 按会话选择模型（v0.6.0）
- `GET /api/models`（deepseek-flash / deepseek-v4-pro）、`POST /api/model {sessionId, modelId}`
- `sessions_meta.model` 持久化，会话列表返回该字段；聊天时 `configure({model})` 生效
- 中栏顶条模型名改为下拉选择，切换即保存（按会话，不影响其他会话）
- 验证：两个会话分别用 flash / v4-pro，回答风格与模型一致

## 2026-10-19（MCP 接入）

### MCP（Model Context Protocol）工具接入（本条提交）
- `mcp_servers` 表 + `GET/POST/DELETE /api/mcp`；工作台新增「连接」tab，可添加/移除 Streamable HTTP MCP 服务器
- 启动时连接并列出工具，包装为 `mcp__<服务器>__<工具>`，仅模型可调用
- **踩坑：** 扩展必须在 `Harness.open` 前 `registry.install`；早期版本每轮重建导致工具反复添加/移除，污染老会话转录（`pi.system` 的 toolsAdded/toolsRemoved 记录），表现为模型只看到旧工具集——新会话正常。现改为「构建一次常驻 + 配置变更时重建，失败保留上次成功结果」
- 验证：新会话中模型调用 `mcp__deepwiki__ask_wiki_question` 得到真实回答

## 2026-10-19

### 文件按会话隔离 + 会话重命名/删除（`201bb89`）
- `vfs_v2(conversation_id, name)` 复合主键，旧全局文件表自动迁移到根会话
- `write_file` / `read_file` / `list_files` 使用 `api.conversationId`；`/api/files*` 支持 `sessionId`
- `PATCH /api/sessions` 重命名、`DELETE /api/sessions` 删除（墓碑防列表复活，同时清空该会话文件）
- 侧栏会话项悬停显示 ✎ / 🗑

### reflect：会话洞察自动入库（`eea259d`）
- 每 6 个新条目后台触发一次，DeepSeek 低成本抽取 ≤3 条长期事实
- 规范化去重（去空白/标点后互为子串即跳过）；`pi_mem.source` 区分 manual / reflect
- `POST /api/reflect` 可手动触发

### SSE 流式输出（`a17e652`）
- `POST /api/chat/stream`：`watchEvents` → SSE（text 增量 / tool_start / tool_end / done）
- 前端增量渲染到气泡，工具 pill 实时出现
- 注意：部署后旧 Durable Object 实例会继续运行旧代码（活跃请求使其不被驱逐），约 5 分钟后才切换

### 多会话（`5de940e`）
- `createConversation` 新建会话，`sessions_meta` 存标题/时间，首轮消息自动生成标题
- 会话隔离：chat / entries / reset 均按 `sessionId`
- 会话列表由元数据表 + `storage.scanConversations` 补齐

### codemode：QuickJS 沙箱执行（`09e9b1d`）
- `createCodemodeExtension` + `createInlineCodemodeSandbox`（WASM 由 wrangler 打包）
- 模型可写 JavaScript，脚本内 `await tools.<name>(args)` 调用任意工具
- 会话的 agent 选择固化在 `pi.agent`，需 `root.configure()` 幂等重设才对老会话生效

## 2026-10-16

### Codex 式三栏布局 + 虚拟文件系统（`9bb4c5e`）
- 左会话栏 / 中聊天（可展开工具 pill）/ 右工作台（文件预览/源码切换 + 记忆管理）
- `vfs_files` 表 + `write_file` / `read_file` / `list_files`；`/api/files*`、`/api/memories`、`/api/sessions`

### 中文聊天前端（`413f8fb`）
- React + Vite + Tailwind SPA，经 wrangler assets 与 API 同 Worker 部署
- `/api/*` 与 `/agent/*` 路由进 Durable Object（`run_worker_first`）

### CI 自动部署（`0d7f458`）
- push `main` → `npm ci` → `build:web` → `wrangler deploy`
- 仓库 secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

### pi-durable harness 上 Cloudflare（`398ea69`）
- Durable Object 内运行 `Harness`，存储用官方 `openDurableObjectSqliteStorage`（DO SQLite）
- `pi-ai` 的 `deepseekProvider`（模型目录 id：`deepseek-flash` / `deepseek-v4-pro`）
- 工具：`now` / `remember` / `recall` / `http_fetch`
- 验证：工具调用、跨请求记忆、进程重启后会话恢复

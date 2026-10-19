# 更新记录

本文件记录每次功能迭代。每次 push 到 `main` 都会自动部署（GitHub Actions → Cloudflare Worker）。

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

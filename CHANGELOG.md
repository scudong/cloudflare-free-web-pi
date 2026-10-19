# 更新记录

本文件记录每次功能迭代。每次 push 到 `main` 都会自动部署（GitHub Actions → Cloudflare Worker）。

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

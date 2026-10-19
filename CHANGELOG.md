# 更新记录

本文件记录每次功能迭代。每次 push 到 `main` 都会自动部署（GitHub Actions → Cloudflare Worker）。

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

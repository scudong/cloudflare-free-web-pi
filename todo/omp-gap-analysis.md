# omp 能力差距分析

> 对照对象：[omp.sh/docs](https://omp.sh/docs)（oh-my-pi，终端优先编码代理，45 个文档页）
> 对照方：pi-harness v0.22.1
> 分析日期：2026-10-19
> 结论摘要：**omp 是「终端里的编码代理」，pi-harness 是「云端的通用助手」。会话状态机层落后约 2/3；本地文件/进程层不是落后，是平台边界。**

---

## 一、能力对照

图例：✅ 已满足　🟡 部分满足　❌ 缺失但可补　🚫 平台不支持

### 1.1 会话与上下文

| 能力 | omp | pi-harness | 状态 |
|---|---|---|---|
| 多会话 / 改名 / 删除 | JSONL 按工作目录落盘 | `sessions_meta` + DO | ✅ |
| 会话搜索 | 全文（标题/ID/路径/正文） | 仅标题 | 🟡 |
| 会话分支 / 树 / 回退 | `/branch` `/tree` `/fork` | pi-durable 有 `head`/`edits` 原语，未暴露 | ❌ |
| 上下文压缩 | 5 级方法链（remote→snapcompact→handoff→shake→soft），阈值/保留量可配 | 框架有 `compaction_start/end` 事件，无配置与 UI | 🟡 |
| 交接简报 handoff | ✅ 结构化简报替换旧上下文 | 无 | ❌ |
| Plan 模式 | 只读规划轮 + 5 种审批出口（execute/compact/keep context/refine/save&quit） | `update_plan` 清单，执行中实时更新；无「批准后才执行」闸门 | 🟡 |
| Goal 模式 | ✅ 目标绑定 + 自动续转 + token 预算 + 完成硬校验 | 定时任务（alarm）近似，但非目标驱动 | 🟡 |
| 记忆 | 三后端（local/mnemopi/hindsight）、项目作用域、嵌入检索 | `remember`/`recall` + 每 6 条自动 `reflect`；关键词匹配、全局作用域、无向量 | 🟡 |
| 实时引导（流式途中插话） | ✅ | 框架有 inbox / submission 队列，未接 UI | ❌ |
| 思考过程 | ✅ | ✅ 折叠块 + 档位设置 | ✅ |

### 1.2 工具与执行

| 能力 | omp | pi-harness | 状态 |
|---|---|---|---|
| 文件读写 | 本地 FS，含 PDF/DOCX/ZIP/SQLite 解析、SSH | 会话级虚拟文件系统 | 🟡 |
| shell / bash | ✅ | 无进程 | 🚫 |
| glob / grep | ✅ | 无（可基于 VFS 实现） | ❌ |
| LSP 代码智能 | 定义/引用/重命名/诊断 | 无 | 🚫 |
| DAP 调试 | 断点/单步/变量/表达式 | 无 | 🚫 |
| AST 结构化编辑 | `ast_grep` / `ast_edit` | 无（codemode 可做文本处理） | 🚫 |
| 代码沙箱执行 | `eval` | `codemode`（QuickJS WASM，可回调其它工具） | ✅ |
| 网页搜索 / 抓正文 | 四路自动路由 | `web_search` + `web_fetch_page`（DeepSeek） | ✅ |
| 浏览器自动化 | 受管 Chromium + Chrome 扩展中继 | Browserbase MCP | 🟡 |
| 桌面控制 | 原生 AX / 截图 / 输入（macOS/X11/Wayland/Win32） | 无 | 🚫 |
| GitHub | `gh` + PR worktree + Actions | 无（可用 REST API） | ❌ |
| 代码评审 / 提交 / 安全扫描 | 三套内置工作流 | 无 | ❌ |

### 1.3 扩展与定制

| 能力 | omp | pi-harness | 状态 |
|---|---|---|---|
| Skills | `SKILL.md` + frontmatter，惰性加载 | 同规范 + 社区一键安装 + URL 导入 | ✅ |
| MCP | stdio / http / sse，多工具配置导入，OAuth | Streamable HTTP + 自定义请求头 | 🟡 |
| 自定义工具 | 本地 TS 模块，`pi.zod` 校验 | 无 | ❌ |
| Hooks | TS/JS 模块，可阻断/改写工具调用与模型请求 | 无 | ❌ |
| Prompt 模板 / 斜杠命令 | Markdown 即命令，`$1`/Handlebars | 无 | ❌ |
| Context files | AGENTS.md / RULES.md / SYSTEM.md 等 8 类来源，`@path` 导入 | instructions 硬编码 | ❌ |
| 插件 / 市场 | npm / Git / marketplace | 只有技能目录 | 🟡 |
| 主题 | JSON 主题系统 + 符号集 + 无障碍 | 深/浅两套 | 🟡 |

### 1.4 模型与协作

| 能力 | omp | pi-harness | 状态 |
|---|---|---|---|
| 多 provider / 自定义模型 | 9 种 API 协议，YAML 自定义 | 固定 2 个 DeepSeek 模型 | 🟡 |
| 模型角色路由 | default/smol/slow/vision/plan/task/advisor… | 无 | ❌ |
| prewalk 模型接力 | 强模型开局 → 廉价模型接手 | 无 | ❌ |
| 思考档位 | ✅ | ✅ off/low/high | ✅ |
| 多人实时协作 | WebSocket relay + AES-256-GCM 端到端加密 | 只读分享链接 | 🟡 |
| SDK / RPC / ACP | 三套程序化接口 | HTTP API + SSE | 🟡 |
| 工具审批 | read/write/exec 三级 + 逐工具策略 | 只有访问密码 | ❌ |
| 密钥管理 | `agent.db` + auth broker/gateway | env secret；MCP 头存库（随备份导出） | 🟡 |

---

## 二、已满足（不需要动）

1. **Skills 体系** — 同为 `SKILL.md` + frontmatter + 按需 `load_skill`，另有社区目录与 URL 导入
2. **代码沙箱** — codemode 在 QuickJS 里跑 JS 并回调其它工具，等价 omp 的 `eval`
3. **联网能力** — 搜索 + 正文抽取，已实测真实结果
4. **会话基础** — 多会话隔离、按会话选模型、自动标题、服务端中止
5. **交付形态** — 只读分享、Markdown 导出、JSON 备份恢复

---

## 三、缺失但可补（按性价比排序）

| 优先级 | 能力 | 工作量 | 落点 | 验收标准 |
|---|---|---|---|---|
| P0 | **子代理编排** | 中 | DO 内 `createConversation` 扇出 + 汇总 | 一句话触发 N 个只读子任务并行跑，结果汇总回主会话 |
| P0 | **上下文压缩可配置** | 小 | 框架已有 compaction，接设置项 + UI 提示 | 设置里能调阈值/保留量；压缩发生时聊天里有提示 |
| P1 | **Goal 模式** | 中 | 复用 alarm + 预算计数 | 设定目标后自动续转，到预算强制收尾 |
| P1 | **会话分支 / 回退** | 中 | pi-durable `head` / `edits` | 可从任意用户消息处分叉，旧路径不删 |
| P1 | **工具审批分级** | 小 | read/write/exec 三档 + 逐工具覆盖 | MCP 写操作/删文件前需确认 |
| P2 | **Context files** | 小 | instructions 改为可编辑的项目规则 | 用户可维护一份项目约定，注入每次对话 |
| P2 | **实时引导（流式插话）** | 小 | 框架 inbox + SSE | 生成中可追加一句，不必等结束 |
| P3 | **多 provider** | 中 | pi-ai 已支持多家 | 设置里可加 OpenAI/Anthropic 兼容端点 |
| P3 | **自定义工具（存 DO 的 JS）** | 中 | codemode 基础上做注册表 | 用户贴一段 JS 即成为可调用工具 |

---

## 四、不该补（平台边界）

`bash` · `LSP` · `DAP 调试` · `AST 编辑` · `git worktree` · `桌面控制` · `Chrome 扩展中继` · `本地模型服务`

统一原因：这些都需要**用户机器上的进程与文件系统**。Workers 没有进程、没有本地盘。要做只能外挂一个本机 agent 连回云端 —— 那是另一个产品形态（而且 omp 已经把它做到极致）。

---

## 五、可执行 TODO

- [x] P0 子代理编排：`createSubagent(task, {tools})` + 并行扇出 + 结果汇总
- [x] P0 压缩可配置：设置页加阈值/保留量，压缩时聊天里给提示
- [x] P1 Goal 模式：目标 + token 预算 + 自动续转 + 完成校验
- [ ] P1 会话分支：从任意消息分叉，侧栏显示分支树
- [ ] P1 工具审批：read/write/exec 三档
- [ ] P2 Context files：项目级可编辑 instructions
- [ ] P2 流式插话：生成中追加消息进入 inbox
- [ ] P3 多 provider：OpenAI/Anthropic 兼容端点配置
- [ ] P3 自定义工具：DO 内 JS 工具注册表

---

## 六、来源

- [omp overview](https://omp.sh/docs)
- 会话与模式：`/docs/sessions` `/docs/session-tree` `/docs/memory` `/docs/compaction` `/docs/plan` `/docs/goal` `/docs/handoff` `/docs/modes` `/docs/slash` `/docs/keybindings` `/docs/settings`
- 能力：`/docs/files` `/docs/code-intelligence` `/docs/debugging` `/docs/editing` `/docs/review` `/docs/commit` `/docs/security` `/docs/subagents` `/docs/advisor` `/docs/vibe` `/docs/collab` `/docs/web` `/docs/computer` `/docs/github`
- 模型与定制：`/docs/providers` `/docs/roles` `/docs/agents-and-roles` `/docs/custom-models` `/docs/prewalk` `/docs/context-files` `/docs/skills` `/docs/prompt-templates` `/docs/magic-keywords` `/docs/hooks` `/docs/custom-tools` `/docs/mcp`
- 扩展与程序化：`/docs/themes` `/docs/ttsr` `/docs/plugins` `/docs/extension-authoring` `/docs/marketplace` `/docs/sdk` `/docs/rpc` `/docs/acp` `/docs/approvals` `/docs/secrets` `/docs/session-format` `/docs/tools`

# 前端地图（src/web）

维护人：前端架构-qian。基线提交：v0.56.0（PR #11 / #14 之后）。改动前端结构时同步更新本文件。

用途：回答「这个页面由哪些组件拼成、状态属于谁、数据从哪个接口来」。评审时用它判断改动是否越层。

分层与命名规则见 [`docs/adr/0002-frontend-layering.md`](./adr/0002-frontend-layering.md)。
当前迭代的数据契约与组件落点见 [`docs/frontend-contract-w3.md`](./frontend-contract-w3.md)（NERE-44，W3 参考资料条 / 分享面板）。
信息架构变更（知识库 / MCP / 技能三个左栏面板改为弹窗）见 [`docs/ui-modal-contract.md`](./ui-modal-contract.md)（NERE-62）。**已在 NERE-63 实施**：本文 §2 组件树、§3 状态表已同步（契约 §9 第 11 条）。

## 1. 目录即分层

| 层 | 目录 | 允许做的事 | 不允许做的事 |
| --- | --- | --- | --- |
| 页面层 | `src/web/App.tsx`、`main.tsx` | 组装布局、持有页面级服务端状态、写事件处理 | 内联大段渲染细节、直接拼 URL |
| hooks 层 | `src/web/hooks/*.ts` | 一个 hook 拥有一个服务端资源的读 / 写 / 刷新；只在 hook 内调 `api.*`，向页面返回领域模型与加载 / 错误状态 | 渲染 JSX、拼接口 URL、在页面层重复写取数 effect |
| 特性组件层 | `src/web/components/*.tsx` | 一个领域块（消息、工作台、设置、分享…）的渲染与交互 | 绕过 `lib/api.ts` 发请求、自定义一套全局设置读写 |
| 基础 UI 层 | `components/Icon.tsx`、`components/*` 内的纯展示子组件 | 无业务语义的展示与样式聚合 | 认识 `api.*`、认识具体接口字段 |
| 逻辑与数据层 | `src/web/lib/*` | `api.ts` 是唯一传输层；`entries.ts`/`collections.ts` 把响应解析成领域模型；`format.ts`/`localStore.ts`/`theme.ts` 放纯函数与本地持久化 | 引 React 组件（`rich.tsx` 除外，它是渲染函数库）、抛业务文案 |
| 类型 | `src/web/types.ts` | 唯一的领域类型来源（`ChatMessage`、`FileArtifact`、`ShareLink` …） | 在组件文件里重复声明同名领域类型 |

现状硬约束：`src/web/**` 内除 `lib/api.ts` 外**没有**任何 `fetch(`。新增请求一律加到 `api.ts` 并给返回类型；首屏资源优先走 `hooks/useBootstrap.ts`（见 3.1）。

传输层还有一个聚合入口 `api.bootstrap(sessionId)`（NERE-23 / NERE-26）：一次返回 17 个只读面板，逐面板失败写进 `errors`，旧单端点保留但标记 deprecated。

## 2. 入口与页面

单页应用，无路由库。`src/web/main.tsx` 挂载 `App`；「页面」由 `railView` + `overlay`（设置 / 知识库 / MCP / 技能）+ `leftOpen` + `rightOpen` + `mobileTab` 组合出来。

```
App（页面层，1847 行）
├─ LoginGate                          未登录整屏闸门
├─ Rail                               常驻竖栏：sessions / files / 分享 / 定时 / 用户 + kb / mcp / skills 三个弹窗入口（分享 / 定时带未读圆点，NERE-74）
├─ 左栏内容（随 railView 切换，可收起）
│  ├─ Sidebar          会话列表 + 搜索 + 重命名/删除
│  ├─ FilesPanel       全库文件（自取数）
│  ├─ SharesPanel      分享清单（NERE-56 能力门禁）
│  ├─ AutomationPanel  定时任务（行内「编辑」→ AutomationEditDialog / ModalShell md，NERE-65；行内「上次 / 状态徽标 / 失败原因 / 查看产出」跳转，NERE-68 / NERE-86；编辑弹窗含「每次执行用新会话」开关，NERE-86）
│  └─ UsersPanel       用户管理（owner 可见，自取数）
├─ TopBar              在线状态 / 会话名 / 打开设置 / 移动端抽屉
├─ 聊天栏
│  ├─ ChatHeader       会话标题 / 目标模式 / 收展左右栏
│  ├─ MessageList      ← 唯一消息渲染出口
│  │  └─ AssistantBubble
│  │     ├─ ThinkingBlock   思考过程（折叠）
│  │     ├─ ToolBar         工具活动条（含 args/full 结果）
│  │     ├─ ArtifactCard    本轮产出文件卡
│  │     ├─ ShareLinkCard   本轮分享链接卡（v0.55.0）
│  │     └─ rich.tsx        正文 Markdown 子集渲染
│  ├─ PlanCard         计划清单（update_plan）
│  ├─ GoalBar          目标进度
│  ├─ ApprovalBar      待审批工具
│  ├─ AskUserCard      待回答问题
│  └─ Composer         输入 / 图片 / 技能 / 模板 / 模型切换 / 插话
├─ Workbench           右栏文件阅读器（自取文件正文）
├─ 面板弹窗（ModalShell，portal 到 body，同一时刻最多一个；NERE-62 / NERE-63）
│  ├─ 知识库 ModalShell lg（880px）→ KnowledgePanel（自取数，5 处 api.*）
│  │  └─ KbImport 导入文件 / 链接 / 粘贴（自取数，3 处 api.*）
│  ├─ 连接 · MCP ModalShell md（720px）→ McpPanel
│  └─ 技能 ModalShell xl（960px）→ SkillPanel
│     ├─ SkillCard         已安装技能行：运行时 / 审计 / 上次使用 / 试用（NERE-59）
│     └─ SkillHubPanel     技能 Hub（已安装 / Hub 两个视图，自取数；安装结果行内反馈 + 一键试用，NERE-69）
├─ GoalDialog          设定目标
└─ SettingsDialog      设置（主题 / 聊天 / 模型 / 知识库 / 部署自检 / 分享 / 备份；懒加载，NERE-81）
   └─ ShareDialog      文件分享链接弹窗
```

移动端：`useMediaQuery` 切换 `mobileTab`（chat / files），左栏进抽屉；Rail 上的 kb / mcp / skills 先收起抽屉，再以全屏 sheet 打开（≤720px，`ModalShell` 内切换形态）。

## 3. 状态归属

### 3.1 页面级服务端状态（都在 `App` 的 `useState`）

首屏的 17 个只读面板由 `hooks/useBootstrap.ts` 一次取回（`GET /api/bootstrap?sessionId=`），解析在 `lib/bootstrap.ts`。`App` 只消费 `bootstrap.data / errors / loading`：

- `refreshKey = reloadKey:panelTick:modelsTick` —— 面板刷新、重试、模型变更都会重取一次 bootstrap；首次进入页面只有这一个业务请求。
- 同会话刷新失败保留上一份数据；跨会话失败清空，避免串会话。
- 后端逐面板失败（`errors`）映射到对应面板的「加载失败」空态，页面不崩。
- 上下文占用条（`Composer`）不在 bootstrap 的 17 个面板内，首屏不取；切换会话、轮次结束或点击刷新时再更新。

| 状态 | 变量 | 刷新机制 |
| --- | --- | --- |
| 会话列表 / 当前会话 | `sessions`, `sessionId`, `sessionName` | bootstrap |
| 消息流 | `messages` | 流式事件 + bootstrap `entries` 回放 |
| 文件（当前会话 / 全库） | `files`, `filesState` | bootstrap（`panelTick` 重取） |
| 记忆 | `memories`, `memoriesState` | bootstrap（`panelTick` 重取） |
| 技能 / 模板 / 规则 / 自定义工具 / MCP / 定时任务 | `skills`, `prompts`, `rules`, `customTools`, `mcpServers`, `automations` | bootstrap（`panelTick` 重取）；技能行额外带 `runtime` / `auditStatus` / `lastInvokedAt`（NERE-59）；定时任务编辑用 PATCH 返回值就地合并（NERE-65），不整表重取；定时任务行读 `last_run_at` / `session_id` / `last_status` 渲染「上次」、成功/失败/顺延徽标并可跳转会话（NERE-68） |
| 分享清单（快照） | `useSharesSnapshot`（App 内，NERE-74） | 登录态确定后取一次 `GET /api/shares/all`（同时充当 NERE-56 能力探测）；切回标签页 / 窗口聚焦重拉。面板自身仍走 `useShares` |
| 未读水位（NERE-74） | `useUnreadBadges`（App 内） | localStorage `pi-unread:<scope>:shares\|automations`；分享比 `lastOpenedAt`、定时比 `lastRunAt`，严格大于水位才算未读；首次加载用当前最大值做种子；打开面板即推进水位；`storage` 事件同步多标签页 |
| 技能 Hub 列表（NERE-54） | `useSkillHub`（SkillHubPanel 内） | 切到 Hub 视图时取 `GET /api/skills/hub`；筛选变化带查询串重取（q 防抖），失败保留旧数据并可重试 |
| 全局设置 | `thinkingLevel`, `compaction`, `approvalSettings`, `webSearch`, `kbPrefetch`, `kbRetrieval`, `model`, `theme` | bootstrap `settings` + 局部回写 |
| 计划 / 目标 / 审批 / 提问 | `plan`, `goal`, `approvals`, `askQuestions` | bootstrap + 每轮 `done` / `tool_end` 后增量刷新 |
| 轮次内状态 | `contextTick` | 每轮 `done` / `tool_end` 后刷新 |

增量接口仍保留：`api.approvals()` / `api.questions()` 只用于轮次内刷新；`api.settings()` / `api.models()` 只用于设置弹窗与模型切换。首屏不再调用它们。

无缓存层、无全局 store：首屏资源由 bootstrap 收敛，其余仍是 useState + 手动 tick。见 `[ARCH]` 需求 R2。

### 3.2 组件内 UI 状态

| 组件 | 状态 | 性质 |
| --- | --- | --- |
| `App` | `leftOpen`/`rightOpen`/`leftWidth`/`rightWidth`/`mobileTab`/`drawerOpen`/`railView`/`overlay`/`kbFocus`/`kbFocusSeq` | 纯 UI，已用 `localStorage` 记住尺寸；`overlay`（`lib/panels.ts`）是设置与知识库 / MCP / 技能三个弹窗的唯一开关，同一时刻最多一个；`kbFocus` 是一次打开的定位请求，`kbFocusSeq` 是它的 nonce（关闭即丢弃） |
| `KnowledgePanel` | `viewMemory.query`（模块级） | 纯 UI：只保留检索词，重开弹窗时回填；结果 / 草稿 / 正在查看的文档关闭即丢 |
| `SkillPanel` | `skillViewMemory.view`（模块级） | 纯 UI：记住「已安装 / Hub」tab |
| `SkillHubPanel` | `viewMemory.filters`（模块级）；`installedHere` / `installErrors`（组件内） | 纯 UI：记住 Hub 筛选词；安装成功立即标记「已安装 · 试用」，失败原因就地显示（NERE-69），不写聊天 notice |
| `Composer` | 草稿、`/` 菜单、附件 | 纯 UI |
| `MessageList` | 滚动是否贴底 | 纯 UI |
| `ShareLinkCard`、`ShareDialog` | `copied`、`result` | 纯 UI（`host`+`path` 不落地） |
| `ShareSettings`（`SettingsDialog` 内） | `displayName`、`ttl`、`message` | **服务端状态的局部副本**，见 3.3 |

### 3.3 已知反例（评审时要挡）

- （已解决，NERE-81）`SettingsDialog` 曾自己拉 `displayName`/`shareTtlSeconds`：现在两者都由 `App` 从 bootstrap `settings` 面板读、向下传；部署自检也不再调用 `/api/settings`。
- （已解决，NERE-81）`SettingsDialog` 内 18 处 `api.*` 已收敛到 `hooks/useSettingsData.ts`（16 处），组件文件为 0。
- 同一份 TTL 选项表存在两份：`SettingsDialog.SHARE_TTL_OPTIONS` 与 `ShareDialog.TTL_OPTIONS`（文案还不一致：`长期有效` / `永久`）。

## 4. API 依赖

`src/web/lib/api.ts` 是唯一出口，按调用点统计（NERE-26 之后）：

| 调用点 | api.* 次数 | 主要接口 |
| --- | --- | --- |
| `App.tsx` | 48 | `/api/bootstrap`（经 `useBootstrap`）, `/api/stream`, `/api/files*`, `/api/memories`, `/api/skills`, `/api/prompts`, `/api/rules`, `/api/custom-tools`, `/api/mcp`, `/api/automations`, `/api/settings`, `/api/model(s)`, `/api/approvals`, `/api/questions`, `/api/goal`, `/api/sessions`, `/api/auth`, `/api/abort`, `/api/interject`, `/api/users` |
| `SettingsDialog.tsx` | 0 | 全部迁到 `hooks/useSettingsData.ts`（16）：`/api/kernel`, `/api/tools`, `/api/compact`, `/api/providers`, `/api/models`, `/api/kb/status`, `/api/kb/reindex`, `/api/version`；`/api/backup` / `/api/restore` 走 `App` 传入的回调 |
| `KnowledgePanel.tsx` | 5 | `/api/kb*` |
| `UsersPanel.tsx` | 4 | `/api/users*` |
| `ShareDialog.tsx` | 2 | `/api/shares`, `/api/share` |
| `FilesPanel.tsx` | 2 | `/api/files/all`, `/api/files` |
| `Composer.tsx` | 2 | `/api/context`, `/api/model` |
| `Workbench.tsx` | 1 | `/api/files/content` |
| `hooks/useSettingsData.ts` | 16 | 设置弹窗的全部读写（见上一行） |
| `SkillPanel.tsx` | 1 | `/api/skills/community` |
| `KbImport.tsx` | 3 | `/api/kb/ingest`、`/api/kb/docs` |

NERE-63 的面板弹窗外壳（`components/ModalShell.tsx`、`lib/focus.ts`）不调用任何 `api.*`；三个面板迁入弹窗后各自的调用点与次数不变。NERE-65 的编辑弹窗（`components/AutomationEditDialog.tsx`）同样只接收 `onSave` 回调，PATCH 由 `App.tsx` 发出。

首屏业务请求数：旧版 18 个（session、entries、sessions、files、memories、settings、plan、goal、questions、approvals、prompts、rules、custom-tools、skills、automations、mcp、models、context），NERE-26 之后为 1 个 `/api/bootstrap`。`/api/auth` 是登录闸门（改造前后各 1 次，不计入面板读取）；Composer 的 `/api/context` 改为切换会话、轮次结束或点击刷新时再取，不再出现在首屏。

### 4.1 跨层事实来源：工具结果文本

聊天里的卡片（文件卡、分享卡）不是接口返回的结构化数据，而是**从工具结果文本里解析出来的**：

```
worker 工具结果（中文展示串）
  → pi.tool-result 条目 / stream 的 tool_end.summary
  → lib/entries.ts: artifactsOf() / shareOf()（优先 details.share）
  → ChatMessage.files / ChatMessage.shares
  → MessageList → ArtifactCard / ShareLinkCard
```

流式（`App.tsx` 事件归约）与历史回放（`parseEntries`）都调同一个 `shareOf`（v0.55.0 起优先读 `details.share`，文本仅兜底），两条路径收敛在 `MessageList` 一处渲染——这一点是对的，改动时不要打破。风险在格式：展示串即协议，见 `[ARCH]` 需求 R1。

## 5. 渲染与性能观察点

- `messages` 是唯一高频变化的数组；`MessageList` 每次 `messages`/`pending`/`elapsed` 变化都会重算整棵气泡树，没有 memo 边界，长会话（数百条 + 每秒 `elapsed`）是主要重渲染来源。
- `App` 60+ `useState`：任一处变化都重跑整个 `App` 渲染函数，`sidebar` 片段、`SettingsDialog` 的 props 每次都重建。
- 图标统一走 `components/Icon.tsx` 的语义表（`lucide-react` 按名引用，tree-shaking 生效），不要直接 `import { X } from "lucide-react"`。
- 无 Markdown 依赖，正文由 `lib/rich.tsx` 自渲染；bundle 主要是 React + 图标 + 应用代码。
- 弹窗分包（NERE-81）：`SettingsDialog` / `KnowledgePanel` + `McpPanel` / `SkillPanel` 走动态 import，`dist-web/assets/` 产出 3 个懒加载 chunk；首包 gzip 预算 150 KB（`vite.config.mts` 注释），当前 entry gzip ≈ 112 KB。

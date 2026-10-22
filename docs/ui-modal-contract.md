# 知识库 / MCP / 技能弹窗化契约（NERE-62）

维护人：前端架构-qian。状态：**待实现**（本文合并后由实现方按 §8 步骤落地）。
上游需求：NERE-62；实现工单：NERE-63。相关文档：[`frontend-map.md`](./frontend-map.md)、[`adr/0002-frontend-layering.md`](./adr/0002-frontend-layering.md)。

## 0. 一句话

左侧栏只保留**会话列表 + 一级入口图标**；知识库、MCP、技能三个管理面板从「左栏内容」改为**互斥的模态弹窗**，用一个新增的 `ModalShell`（基础 UI 层）统一承载标题、尺寸、焦点、Esc、滚动与响应式，**不动任何数据请求与 API**。

## 1. 信息架构

### 1.1 改造前 → 改造后

| 入口 | 改造前 | 改造后 | 理由 |
| --- | --- | --- | --- |
| 会话 | 左栏内容（`Sidebar`） | 不变 | 高频浏览，常驻才有价值 |
| 全部文件 | 左栏内容（`FilesPanel`） | 不变 | 浏览型，与右栏 Workbench 联动 |
| **知识库** | 左栏内容（`KnowledgePanel`，最宽 300px） | **弹窗 `lg`（880px）** | 低频管理 + 需要横向空间（标题/来源/大小/时间同排） |
| **MCP** | 左栏内容（`McpPanel`） | **弹窗 `md`（720px）** | 极低频配置 |
| **技能** | 左栏内容（`SkillPanel`，含 Hub / 审计） | **弹窗 `xl`（960px）** | 低频管理 + Hub 卡片需要列宽 |
| 分享 | 左栏内容（`SharesPanel`） | 本期不变（见 §1.3） | 范围控制 |
| 定时任务 | 左栏内容（`AutomationPanel`） | 本期不变 | 半浏览型，保留左栏 |
| 用户管理 | 左栏内容（`UsersPanel`，仅 owner） | 本期不变 | 极少用但有权限门禁，改造收益低 |

改造后左栏的三种状态，互斥：

1. 会话列表（默认，`leftOpen`）；
2. 文件 / 分享 / 定时 / 用户（`railView`，仍是左栏内容）；
3. 关闭左栏内容（`leftOpen=false`，弹窗仍可从 Rail 打开）。

### 1.2 Rail 语义变化（关键）

三个入口从「切换左栏内容」变成「打开弹窗」，所以按钮语义从 `aria-pressed` 改为 `aria-haspopup="dialog"` + `aria-expanded`。

```ts
// src/web/components/Rail.tsx
export type RailView = "sessions" | "files" | "shares" | "automations" | "users";
/** 走弹窗的三个入口（NERE-62）。与 RailView 不是同一维度，不要合并。 */
export type RailPanel = "kb" | "mcp" | "skills";

interface RailProps {
	view: RailView;
	/** 当前打开的弹窗；同一时刻最多一个。 */
	panel: RailPanel | null;
	onSelectView: (view: RailView) => void;
	/** 再点一次同一入口 = 关闭（幂等）。 */
	onTogglePanel: (panel: RailPanel) => void;
	// onNewSession / onOpenSettings / isOwner / sharesAvailable 不变
}
```

- 三个弹窗按钮必须带 `data-modal-trigger={panel}`：关闭时回焦要用（§4.4）。
- 按钮 active 态样式沿用 `aria-expanded:` 变体，不要新增 CSS 类。

### 1.3 分享面板（只给建议，本期不强制）

建议下一期把 `SharesPanel` 也迁到 `ModalShell`（`md`），它是「一次性管理 + 需要看打开次数/时间列」的同型场景，迁完左栏只剩会话 / 文件 / 定时 / 用户。**迁移** Files / Users 不推荐：前者与右栏 Workbench 是浏览动线的一部分，后者有权限门禁且低频到不值得占一个弹窗层。

### 1.4 与设置弹窗的关系

`SettingsDialog` 已是模态（`z-40`）且独占一个层级。规则：**面板弹窗与设置弹窗互斥**——打开任一方前关掉另一方（`setSettingsOpen(false)` / `setActivePanel(null)`），不要出现两层模态互相争焦点。

## 2. 分层与文件落点

| 文件 | 层 | 改动 | 行数预算 |
| --- | --- | --- | --- |
| `src/web/components/ModalShell.tsx` | 基础 UI（新增） | 弹窗外壳：遮罩、尺寸、header/close、焦点圈、Esc、滚动锁、portal | ≤ 220 |
| `src/web/lib/focus.ts` | 逻辑（新增） | `FOCUSABLE_SELECTOR`、`nextFocusIndex(dir, index, count)`（纯函数，可单测） | ≤ 40 |
| `src/web/components/Rail.tsx` | 特性组件 | `RailView` 收窄 + `RailPanel` + 两个回调 | +15 |
| `src/web/App.tsx` | 页面层 | `activePanel` 一个 state；三个弹窗挂载点；`kbFocus` 联动 | ±25 |
| `src/web/components/KnowledgePanel.tsx` | 特性组件 | 去掉外层 `h-full`/`bg-slate-900/60` 与 `PanelHeader`，改收 `onClose` | −15 |
| `src/web/components/LeftPanels.tsx` | 特性组件 | `McpPanel` / `SkillPanel` 同上；`AutomationPanel` 与 `PanelHeader` 不动 | −20 |
| `src/web/styles/index.css` | 样式 | sheet 进出场动画 + reduced-motion 兜底 | +25 |
| `tests/unit/modal.test.tsx` | 测试（新增） | SSR 标记断言 + 纯函数 | 新增 |
| `docs/frontend-map.md` | 文档 | 组件树、状态表、API 依赖表同步 | 见 §9 |

硬约束：

- `ModalShell` / `focus.ts` **不得**出现 `api.`、`fetch(`、`"/api/`。弹窗只承载 UI，取数仍在各面板 / hooks 内，本轮**不新增任何请求**。
- 不得引入新依赖（`react-dom` 的 `createPortal` 已在依赖内）。
- 三个面板改造**只减外壳，不改内部逻辑**：搜索、导入、增删改、审计、Hub 取数的现有行为与请求次数必须与改造前一致（验证方法见 §9 第 8 条）。

## 3. Modal Shell 契约

### 3.1 组件 API

```tsx
// src/web/components/ModalShell.tsx
export type ModalSize = "md" | "lg" | "xl";

export interface ModalShellProps {
	open: boolean;
	/** header 标题，同时作为 aria-labelledby 的文本来源（内部生成 id）。 */
	title: string;
	/** md = 720px（MCP）/ lg = 880px（知识库）/ xl = 960px（技能）。 */
	size?: ModalSize;
	/** Esc、遮罩、关闭按钮、手势都收敛到这一个回调。 */
	onClose: () => void;
	children: ReactNode;
	/** 可选底栏（如「关闭」/「导入」）。不传则不渲染。 */
	footer?: ReactNode;
	/** 覆盖默认焦点落点（默认落到 header 之后的第一个可聚焦元素）。 */
	initialFocusRef?: RefObject<HTMLElement | null>;
	/** 默认 true；导入进行中等场景可关掉防误触。 */
	closeOnScrim?: boolean;
	/** 供测试/端到端定位。 */
	testId?: string;
}
```

`open=false` 直接 `return null`（不渲染遮罩、不占 DOM）。**不做「关闭动画期间保持挂载」**：这需要额外的 `closing` state 与延迟卸载，收益是 160ms 的视觉连续，成本是每次开关多一次 App 重渲染和一处易错状态机。本期不做，关闭即卸载。

### 3.2 尺寸

| size | 使用方 | 桌面尺寸 | 高度 |
| --- | --- | --- | --- |
| `md` | MCP | `w-[min(92vw,45rem)]`（720px） | `max-h-[90vh]` |
| `lg` | 知识库 | `w-[min(92vw,55rem)]`（880px） | `max-h-[90vh]` |
| `xl` | 技能 | `w-[min(92vw,60rem)]`（960px） | `max-h-[90vh]` |

≤720px 时不看 size，一律全屏 sheet（§5）。尺寸表以 `const MODAL_SIZE: Record<ModalSize, string>` 单点定义，禁止在三个调用点各写一遍宽度。

### 3.3 DOM 骨架（照此实现，顺序即焦点顺序）

```tsx
createPortal(
  <div className="fixed inset-0 z-40 flex items-center justify-center p-4" data-testid={testId}>
    {/* 遮罩是按钮而不是 div：键盘用户也能点到，且不需要额外 tabIndex */}
    <button type="button" aria-label="关闭弹窗" onClick={onClose} className="dialog-scrim absolute inset-0" />
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      // + MODAL_SIZE[size]
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 px-5 py-3">
        <h2 id={titleId} className="text-sm font-semibold text-slate-100">{title}</h2>
        <button type="button" onClick={onClose} aria-label="关闭" className="…（沿用 ShareDialog 的 7×7 关闭按钮样式）">
          <Icon name="close" className="h-4 w-4" />
        </button>
      </header>

      {/* 内容区：不滚动，由面板自己决定哪一段滚 */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>

      {footer && <footer className="shrink-0 border-t border-slate-800/70 px-5 py-3">{footer}</footer>}
    </div>
  </div>,
  document.body,
);
```

要点：

- **必须用 portal 挂到 `document.body`**：App 根节点是 `relative`，弹窗留在里面会被「移动端抽屉 `z-30`」和后续新增的 stacking context 牵连；portal 也让 §4.6 的背景 `inert` 变得简单。
- **内容区不滚动**：现有三个面板各自已经有「固定工具条 + 列表滚动」的结构（KB 的检索表单 `shrink-0`、MCP 的新增表单 `shrink-0`、技能的 tablist `shrink-0`）。Shell 若也套一层 `overflow-y-auto`，就会出现双滚动条与「输入框被滚走」。规矩是：**Shell 给 `min-h-0 flex-1`，滚动条归面板**，每个面板保证**恰好一个**纵向滚动容器，并加 `overscroll-contain`。
- 面板内部滚动容器统一加 `overflow-y-auto overscroll-contain`，不改原有 `max-h-[62vh]` 之类的局部限制（KB 导入区那个 `max-h-[62vh]` 在 90vh 弹窗里仍成立）。
- SSR 兜底：`typeof document === "undefined"` 时直接渲染上述结构不走 portal（`tests/unit/*` 用 `renderToStaticMarkup`，portal 在服务端不可用）。

## 4. 交互与可达性

### 4.1 关闭方式（四条路径，一个出口）

| 路径 | 行为 |
| --- | --- |
| Esc | 关闭；只在 `open` 时监听 |
| 点击遮罩 | 关闭（`closeOnScrim=false` 时忽略） |
| header 关闭按钮 | 关闭 |
| Rail 同一入口再点一次 | 关闭（`onTogglePanel` 幂等） |

**Esc 的层叠规则**：现有 `SettingsDialog` / `ShareDialog` 各自监听 `window` 的 `keydown`。`ModalShell` 必须监听 `document` 的 `keydown`（capture 阶段），命中后 `event.preventDefault()` + `event.stopPropagation()`；并要求既有两处监听改为先判断 `event.defaultPrevented`（各 +1 行）。否则知识库里打开分享弹窗后按 Esc 会同时关掉两层。

### 4.2 焦点进入与回焦

1. **打开**：渲染后（`useLayoutEffect`）焦点落到 `initialFocusRef?.current`，否则落到内容区第一个可聚焦元素，否则落到关闭按钮。**绝不**落到 `body`（否则 Tab 会从页面顶部开始走）。
2. **关闭**：把焦点还给「触发元素」。实现方式：打开时记录 `document.activeElement`；关闭时若该元素仍 `isConnected` 则 `.focus()`，否则查 `[data-modal-trigger="<panel>"]` 回退，最后回退到 `body`。这样 `KbRefsBar` 里的引用链接、移动端抽屉里的 Rail 按钮都能正确回焦。
3. 回焦用 `preventScroll` 不需要——弹窗关闭后页面位置不变，浏览器默认即可。

### 4.3 焦点圈（Tab 不逃逸）

- 可聚焦元素选择器放 `lib/focus.ts` 并导出：`a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])`。
- 过滤不可见元素：`el.getClientRects().length > 0`（`display:none` / 被 `hidden` 的 tabpanel 都要排除）。
- Tab 在最后一个元素上 → 回到第一个；Shift+Tab 在第一个上 → 去最后一个。索引推进用 `nextFocusIndex(dir, index, count)`（纯函数，见 §3 行数预算表），单测覆盖 0 / 1 / n 三种边界。
- 只有一个可聚焦元素时，Tab / Shift+Tab 都停在该元素上，不抛错。

### 4.4 ARIA 与语义

- `role="dialog"` + `aria-modal="true"` + `aria-labelledby={titleId}`（id 由 `useId()` 生成，禁止硬编码）。
- 标题用 `<h2>`，`id` 与 `aria-labelledby` 同源。若弹窗内有分节标题，用 `<h3>` 起，不要跳级。
- 触发按钮：`aria-haspopup="dialog"` + `aria-expanded={panel === "kb"}`；关闭后 `aria-expanded=false`。
- 焦点可见：弹窗内所有可聚焦元素默认沿用现有 `focus-visible` 样式；新增列表项按钮若原本 `opacity-0`（如 KB 的删除按钮 `group-hover:opacity-100`），必须同时带 `focus-visible:opacity-100`（现有代码已有，别在改造中删掉）。
- 加载/错误态用现有的文本空态，不要新造 `aria-live` 播报（避免与聊天的流式播报抢注意力）。

### 4.5 滚动锁定

- `document.body.style.overflow = "hidden"`，在 `useLayoutEffect` 中设置、清理时还原原值。本应用根节点是 `h-dvh` + 内部滚动，页面本身通常无滚动条，因此**不做** padding-right 补偿（做了反而在桌面端留白）。
- 加模块级计数 `let lockCount = 0`：`0 → 1` 时加锁，`1 → 0` 时解锁。为将来「弹窗里再开一层弹窗」留出正确性，别写成无条件 `overflow = ""`。
- 面板内滚动容器加 `overscroll-contain`，避免滚到底后带动背景（尤其 iOS）。

### 4.6 背景可达性

打开时对 `#root` 设 `aria-hidden="true"` 与 `inert`（React 19 支持 `inert` 布尔属性；不支持时降级为只设 `aria-hidden`），关闭时移除。**不要**给三个面板在关闭后留 `hidden` 挂载：本期关闭即卸载（§3.1），不做常驻隐藏，因此不存在「隐藏的焦点陷阱」。

### 4.7 动效

- 桌面：遮罩 120ms 淡入，面板 160ms `scale(0.98) → 1` + 淡入。
- `@media (prefers-reduced-motion: reduce)` 下全部改为 `animation: none`（§6.3）。
- 不做关闭动画（§3.1）。

## 5. 响应式（≤720px）

断点 `720px` 与 `useMediaQuery` 现有用法一致（`DESKTOP_QUERY` 是 1024，别改它——那是三栏布局的断点，弹窗形态用独立断点）。

| 项 | 桌面（>720px） | 手机（≤720px） |
| --- | --- | --- |
| 形态 | 居中卡片，`max-h-90vh` | 全屏 sheet：`inset-0 h-[100dvh] w-screen` |
| 圆角 | `rounded-2xl` | 无圆角（全屏），仅顶部 `rounded-t-2xl` 可选 |
| 进场 | 缩放淡入 | 从底部 `translateY(100%) → 0`，240ms |
| 关闭 | 关闭按钮 / Esc / 遮罩 | 关闭按钮（`44×44` 触控目标）+ 遮罩 + 系统返回手势（Esc 兜底） |
| 安全区 | — | 底部 `pb-[env(safe-area-inset-bottom)]` |
| 方向 | 不变 | 不跟随横竖屏重排，`100dvh` 已处理地址栏抖动 |

- 关闭按钮在手机上尺寸放大到 `h-9 w-9`（36px）+ `p-1.5`，保证 ≥44px 热区。
- **不做**下拉关闭手势：需要 pointer 追踪 + 阈值 + 与内部滚动竞争，收益低、bug 面大。记为后续可选。
- 移动端在抽屉里点 Rail 入口：先 `setDrawerOpen(false)` 再打开 sheet，避免两层遮罩叠加（顺序写死，`onTogglePanel` 里统一处理）。

## 6. 状态与数据

### 6.1 App 只加一个 state

```ts
// src/web/App.tsx
const [activePanel, setActivePanel] = useState<RailPanel | null>(null);

const togglePanel = useCallback((panel: RailPanel) => {
	setActivePanel((prev) => (prev === panel ? null : panel));
	if (!isDesktop) setDrawerOpen(false);
}, [isDesktop]);
```

- 类型用 `RailPanel | null`，不要写成 `"kb" | "mcp" | "skills" | null` 的第二份字面量。
- **不新增** `panelClosing` / `panelDirty` / `panelKey` 之类状态；不做 `key` 强制重挂载。
- 互斥由「单个 `activePanel`」这一事实保证，不写互斥逻辑代码。

### 6.2 `activeRailView` 收窄

改造后 `railView` 只剩 5 个值，`activeRailView` 的两条守卫（`users` 非 owner、`shares` 未上线）保留原样。`leftContent` 三个分支（kb / mcp / skills）删除，改为页面底部的三个弹窗：

```tsx
<ModalShell open={activePanel === "kb"} title="知识库" size="lg" onClose={() => setActivePanel(null)} testId="kb-modal">
	<KnowledgePanel onClose={closePanel} focus={kbFocus} />
</ModalShell>
<ModalShell open={activePanel === "mcp"} title="连接 · MCP" size="md" onClose={() => setActivePanel(null)} testId="mcp-modal">
	<McpPanel servers={mcpServers} loading={mcpLoading} error={mcpError} onAdd={handleAddMcp} onDelete={handleDeleteMcp} onClose={closePanel} />
</ModalShell>
<ModalShell open={activePanel === "skills"} title="技能" size="xl" onClose={() => setActivePanel(null)} testId="skills-modal">
	<SkillPanel … onClose={closePanel} />
</ModalShell>
```

面板 props 变化：`onCollapse?: () => void` → `onClose: () => void`（必填）。面板内部删除 `<PanelHeader …/>` 与最外层 `flex h-full w-full flex-col bg-slate-900/60`，改成 `flex min-h-0 flex-1 flex-col`（背景由 Shell 提供）。

### 6.3 关闭后的状态保留（白名单，不做隐式保留）

关闭即卸载，所以默认**全部丢失**。只保留两项，写在各面板文件顶部的模块级记忆对象里，不进 `App`、不进 `localStorage`：

| 面板 | 保留 | 不保留 | 理由 |
| --- | --- | --- | --- |
| 知识库 | 检索词 `viewMemory.query` | 检索结果、导入表单草稿、正在查看的文档 | 重开时 `load()` 会重取文档列表（与改造前每次切回知识库栏的行为一致，无回归）；检索结果重算一次很便宜 |
| MCP | 无 | 名称 / URL / header 草稿 | 草稿保留会让人隔天看到一个半填的表单 |
| 技能 | 当前 tab（已安装 / Hub）、Hub 筛选词 | 表单草稿、审计展开态 | Hub 筛选重取一次会打一次 `/api/skills/hub`，保留筛选词避免「重开又回到默认」的错位感 |

```ts
// 每个面板文件顶部，仅模块级 UI 记忆（不是业务状态）
const viewMemory = { query: "" }; // KnowledgePanel
const viewMemory = { view: "installed" as "installed" | "hub" }; // SkillPanel
```

- 单测依赖模块级可变状态时要显式重置（`viewMemory.query = ""`），或直接不测这块——这块只是 UX 细节。
- **不做滚动位置恢复**：`display:none` 卸载后 `scrollTop` 在各浏览器行为不一，为它引入「打开后手动 scrollIntoView 到上次位置」会在列表变化时跳到错处。列表量级（<200 行）下，回到顶部是可接受的。
- **不做**跨刷新持久化（`localStorage`）：这些是临时视图状态，持久化后会出现「打开就带三小时前的搜索词」的困惑。

### 6.4 `kbFocus`（从消息里的参考资料跳转）

现有 `handleOpenKbRef` 做三件事：`setRailView("kb")` / `setLeftOpen(true)` / 非桌面开抽屉 / 写 `kbFocus`（带 nonce）。改造后：

```ts
const handleOpenKbRef = useCallback((ref: KbRef) => {
	kbFocusSeq.current += 1;
	setActivePanel("kb");
	if (!isDesktop) setDrawerOpen(false);
	setKbFocus({ docId: ref.docId, chunkSeq: ref.chunkSeq, nonce: kbFocusSeq.current });
}, [isDesktop]);
```

- nonce 语义不变（同一篇重复点也能再次触发）。
- 打开策略不变（面板内直接打开该文档正文，不额外弹第五层）。
- 焦点顺序：先 Shell 的「进入弹窗」焦点，再由 KB 面板内部 `focus` effect 把滚动/高亮落到目标文档——两者不冲突，KB 不需要抢焦点，只滚动定位即可（现有实现即如此）。

### 6.5 不改的东西（写清楚，避免实现时顺手重构）

- 不新增 / 不修改任何 `api.*` 调用；`KnowledgePanel` 仍是 5 处、`LeftPanels` 仍是 1 处（`automations`）。
- 不动 bootstrap 的 17 个面板与首屏 1 次请求（`tests/unit/bootstrap-web.test.ts` 断言）。
- 不动 `SettingsDialog` 内部的 18 处 `api.*`（那是 `[ARCH]` R2 的事）。
- 不动 `SkillHubPanel` 的取数逻辑（`hooks/useSkillHub`），只把它放进更宽的容器。
- 不动 `sharesAvailable` / `isOwner` 门禁。

## 7. 样式与主题

- 复用 `.dialog-scrim`（`styles/index.css` 已有深/浅主题两套值），**不要**新写 `bg-black/60`：浅色主题下 60% 黑太重，这是已经踩过的坑。
- 面板容器沿用现有配色 token：`bg-slate-900`、`border-slate-700`、`shadow-2xl`、`text-slate-100/400/500`。四个主题（dark / light / sepia / midnight）都靠 CSS 变量覆盖，因此**不要**写死十六进制色值。
- 新增 CSS 仅两段：`.modal-sheet-enter`（手机上滑）与 `@media (prefers-reduced-motion: reduce)` 兜底。桌面缩放入场用 Tailwind 的 `animate-in`? 不可用（无插件）——用一段 `@keyframes modal-pop` 即可。

```css
@keyframes modal-pop { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
@keyframes sheet-up  { from { transform: translateY(100%); } to { transform: translateY(0); } }

@media (min-width: 721px) { .modal-card { animation: modal-pop 160ms ease-out; } }
@media (max-width: 720px) { .modal-card { animation: sheet-up 240ms cubic-bezier(0.2, 0.8, 0.25, 1); } }

@media (prefers-reduced-motion: reduce) {
  .modal-card { animation: none !important; }
}
```

- z-index 分层表（改造后必须仍然成立，出现新层级先改这张表）：

| 层 | 用途 |
| --- | --- |
| `z-10` | 聊天内 sticky 元素 |
| `z-20` | TopBar、移动端底部导航 |
| `z-30` | 移动端会话抽屉 |
| `z-40` | **面板弹窗**、`SettingsDialog`（互斥，同层安全） |
| `z-50` | 嵌套小弹窗：`ShareDialog`、`GoalDialog` |

- 面板弹窗与设置同层是**有意**的：二者互斥且都由 portal 到 body，DOM 顺序决定叠放；不要为了「更靠前」把弹窗抬到 `z-50`，那会让分享弹窗永远压在面板下面。

## 8. 迁移步骤（建议一个 PR，按序提交）

1. 新建 `lib/focus.ts` + `tests/unit/modal.test.tsx` 的纯函数用例（红）。
2. 新建 `components/ModalShell.tsx`（含 portal、焦点圈、Esc、滚动锁、`aria-hidden` 背景）。此时还没有调用方。
3. `Rail.tsx`：收窄 `RailView`、加 `RailPanel` / `panel` / `onTogglePanel`、`data-modal-trigger`；`App.tsx` 加 `activePanel` 并接上 Rail。此步编译会红（`leftContent` 三个分支引用旧 view），一并删掉。
4. 三个面板去外壳（`PanelHeader`、`h-full`、`bg-*`）→ 改收 `onClose`；在 `App` 底部挂三个 `ModalShell`。
5. `kbFocus` 跳转改造 + 移动端抽屉顺序；`styles/index.css` 加动画与 reduced-motion。
6. 手动走查 §9 前 6 条 + `npm test` + `npm run build:web` 对比 gzip。
7. 同步 `docs/frontend-map.md`（§9 末行）。

可回滚性：三个面板组件本身不感知「自己是弹窗还是左栏」（外壳由 Shell 提供），若需回滚，把 `ModalShell` 挂载点换回 `leftContent` 分支即可，面板改回带 `PanelHeader` 的版本——因此第 4 步不要顺手重命名或搬文件。

## 9. 验收清单（实现方逐条勾）

1. [ ] `grep -rn 'role="dialog"' src/web` 只新增 `ModalShell.tsx` 一处；三个面板文件里没有自己的 `role="dialog"` / `aria-modal`。
2. [ ] 知识库 / MCP / 技能三个入口：点开弹窗，再点同一入口 → 关闭；点另一个入口 → 前一个关闭、新的打开（同一时刻屏幕上只有一个遮罩）。
3. [ ] 弹窗内：Esc 关闭、点遮罩关闭、关闭按钮关闭，三条路径都让焦点回到**原来那个 Rail 按钮**（DevTools 里 `document.activeElement` 可验）。
4. [ ] Tab 从弹窗最后一个可聚焦元素继续按 → 回到弹窗第一个；Shift+Tab 反向同理；背后页面元素全程不可聚焦（`#root` 有 `inert`）。
5. [ ] 知识库里滚到列表底部 → 弹窗内滚动，页面与聊天不滚（`overscroll-contain` 生效）；顶部检索表单在滚动时保持可见。
6. [ ] 手机（375×667）：三个入口打开都是全屏 sheet 且从底部滑入；关闭按钮热区 ≥44px；底部不压 iPhone home 条。
7. [ ] 长按/拖动浏览器窗口穿过 720px 断点：形态在卡片与 sheet 之间切换，不出现「半屏卡片 + 全屏遮罩」的中间态。
8. [ ] 功能零回归：KB 导入 / 检索 / 删除、MCP 增删 + 连接状态、技能已安装 / Hub / 审计各自走一遍；DevTools Network 里**打开弹窗不产生新请求**（KB 打开时的 `/api/kb/docs` 除外，与旧行为一致）。
9. [ ] 四个主题（dark / light / sepia / midnight）下遮罩、边框、关闭按钮图标都可见；浅色主题下不是一块死黑。
10. [ ] `npm test` 全绿；`npm run build:web` 后 JS gzip 增量 ≤ 4 KiB（基线约 119 KiB）。
11. [ ] `docs/frontend-map.md` 已同步：组件树去掉左栏三面板、加三个弹窗节点、状态表加 `activePanel`、组件内 UI 状态表加 `viewMemory`。

## 10. PR 评审清单（qian 逐条看）

**分层**

- [ ] `ModalShell` / `focus.ts` 无 `api.` / `fetch(` / `"/api/`；三个面板的请求次数与路径未变。
- [ ] 面板不知道自己是弹窗：宽度、遮罩、标题都由 Shell 给；面板没有 `max-w-*` 覆盖（除内部列表的局部限制）。
- [ ] `activePanel` 只存在于 `App`；面板内部状态没有上提，也没有新增第四个全局视图状态。
- [ ] 新增文件 ≤ 300 行（`ModalShell` ≤ 220），没有把「取数 + 交互 + 复杂渲染」塞进一个文件。

**可达性**

- [ ] `aria-labelledby` 指向真实存在的标题 id（`useId`，非硬编码）；`aria-modal="true"`。
- [ ] 焦点进入 / 回焦 / 圈定三条都实测过（不是只写了 effect）。
- [ ] Esc 不会同时关两层（`defaultPrevented` 协作）；`ShareDialog` / `SettingsDialog` 的监听已适配。
- [ ] 触发按钮 `aria-haspopup="dialog"` + `aria-expanded`；打开的 panel 按钮处于 active 态。
- [ ] 手机端关闭按钮 ≥44px；所有新增图标按钮有 `aria-label`。

**重渲染与性能**

- [ ] 关闭弹窗后 `React DevTools` 里没有残留的 KB/Skill 子树（关闭即卸载）。
- [ ] 在 KB 检索框输入字符，只有弹窗子树重渲染，`MessageList` 不重渲染（有效利用「弹窗在自己的子树里」这一边界；若失败，说明面板状态又被提到了 `App`）。
- [ ] 没有为弹窗新增 `App` 级 `useCallback` 依赖导致的级联重建（`sessionId` 等高频值不要进 `togglePanel` 的依赖数组）。

**产物与样式**

- [ ] JS gzip 增量 ≤ 4 KiB；无新依赖（`package.json` 无 diff）。
- [ ] 无新增硬编码色值；遮罩复用 `.dialog-scrim`；四主题走查过。
- [ ] z-index 只用了表里的层级；`ShareDialog` 仍压在面板弹窗之上。
- [ ] `prefers-reduced-motion` 下无动画。

**测试**

- [ ] 纯函数（`nextFocusIndex`、`MODAL_SIZE` 映射）有单测；`ModalShell` 的 SSR 标记（`role`/`aria-modal`/`aria-labelledby`）有 `renderToStaticMarkup` 断言。
- [ ] 没有为「DOM 焦点行为」写脆弱的 jsdom 模拟——那部分靠 §9 的手动走查，测试写纯逻辑。

## 11. 非目标（本期不做）

- 分享 / 文件 / 用户 / 定时面板的弹窗化（§1.3：分享建议下一期）。
- 弹窗栈（弹窗里再开弹窗）的通用能力：只保留滚动锁计数的正确性，不做通用层栈。
- 关闭动画、下拉关闭手势、滚动位置恢复、跨刷新持久化。
- `App.tsx` 拆分 / hooks 化（`[ARCH]` R2），即使它已经 1675 行——本轮只删三个分支，不借机重构。
- 深链接 / URL 路由同步（无路由库，`activePanel` 不进 URL）。
- 键盘快捷键（如 `Cmd+K` 打开知识库）。

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 面板去外壳时误删内部滚动容器 | 弹窗内容溢出、双滚动条 | §9 第 5 条手动走查 + Shell 内容区明确 `min-h-0 flex-1` 不滚动 |
| Esc 双关 | 关了弹窗又关了分享弹窗 | §4.1 `defaultPrevented` 协作，评审项已列 |
| 移动端抽屉 + sheet 双层遮罩 | 视觉发黑、点击穿透 | `togglePanel` 里先关抽屉；§9 第 6 条 |
| 面板状态被顺手提到 `App` | 重渲染回到改造前水平 | §6.3 白名单 + 评审项「KB 输入不触发 MessageList 重渲染」 |
| 关闭即卸载导致每次打开重新请求 | KB 打开一次一次 `/api/kb/docs` | 与改造前切回知识库栏的行为一致，无回归；若后续列表变大再评估缓存 |

## 13. 变更记录

| 日期 | 变更 | 发起 |
| --- | --- | --- |
| 2026-10-22 | 首版：信息架构、ModalShell 契约、可达性、响应式、状态保留白名单、验收与评审清单 | qian（NERE-62） |

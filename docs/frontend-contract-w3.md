# W3 前端契约与分层约束（NERE-44）

维护人：前端架构-qian。适用范围：NERE-41（参考资料条）、NERE-43（分享面板）。
上位规则：[`docs/adr/0002-frontend-layering.md`](./adr/0002-frontend-layering.md)（R-FE-1 至 R-FE-9）。
现状地图：[`docs/frontend-map.md`](./frontend-map.md)。

本文件只定契约与落点，不写业务代码。任何一条与本文件冲突的实现，按 `[blocker]` 处理；实现发现契约不可行时，先改本文件（走 PR）再改代码。

## 0. 一句话

- 参考资料条的数据来自 **assistant entry 的 `kbRefs`**，组件只渲染不取数；
- 分享面板的数据来自 **`GET /api/shares/all`**，唯一读者是新增 hook `useShares`，撤销走乐观更新；
- 两个新特性都**不许**在 `components/**` 里出现 `fetch(`、`api.*`、`"/api/…"` 字面量。

## 1. 数据契约 A：assistant entry 的 `kbRefs`（NERE-40 提供）

### 1.1 位置（必须唯一）

`kbRefs` 是 **entry 对象的顶层字段**，与 `id` / `kind` / `model` 同级：

```jsonc
// GET /api/entries?sessionId=…
{
  "entries": [
    {
      "id": 42,
      "kind": "pi.assistant",
      "model": { "role": "assistant", "content": [{ "type": "text", "text": "久期衡量…" }] },
      "kbRefs": [
        { "docId": 7, "chunkId": 128, "chunkSeq": 2, "title": "久期的含义", "source": "A.md" },
        { "docId": 7, "chunkId": 131, "chunkSeq": 5, "title": "久期的含义", "source": "A.md" },
        { "docId": 9, "chunkId": 12, "chunkSeq": 0, "title": "装修预算清单" }
      ]
    },
    { "id": 41, "kind": "pi.assistant", "model": { "role": "assistant", "content": [{ "type": "text", "text": "今天天气…" }] } }
  ]
}
```

硬规则：

- `/api/entries` 与 `/api/bootstrap` 的 `entries` 面板**序列化结果必须一致**（同一函数出）。前端只有 `parseEntries` 一个解析入口，两处不得分叉。
- 未命中不写字段（不写 `[]`、不写 `null`）。
- 顶层字段名只允许 `kbRefs`。若后端最终用旁路表 + 序列化合并，合并结果仍必须是顶层 `kbRefs`；**不接受** `entry.details.kbRefs`、`entry.metadata.kbRefs` 等第二种位置。

### 1.2 类型

DTO 不需要进 `lib/api.ts`：entries 在传输层是 `unknown`，宽容解析在 `lib/entries.ts`。领域类型只进 `types.ts`（R-FE-2）：

```ts
// src/web/types.ts
/** 一条知识库命中（NERE-40）：随 assistant entry 落库，用于消息下方「参考资料」。 */
export interface KbRef {
	docId: number;
	chunkId: number;
	/** 命中的分块序号（从 0 开始），仅用于标注「第 N 段」，不做正文定位。 */
	chunkSeq: number;
	title: string;
	/** 来源（文件名 / 链接），可缺省。 */
	source?: string;
}
```

`ChatMessage` 的 assistant 分支新增一个可选字段：

```ts
| {
      id: string;
      role: "assistant";
      // …
      /** 本轮知识库命中（NERE-40）；缺省或空数组时不渲染任何 UI。 */
      kbRefs?: KbRef[];
  }
```

### 1.3 解析落点

`lib/entries.ts` 新增导出，供 `parseEntries` 与流式归约共用（同一份解析，两条路径收敛）：

```ts
/** 宽容解析 entry.kbRefs：缺省/非数组 → []；丢弃 docId 非法的项；按 docId:chunkId 去重并保持原序。 */
export function parseKbRefs(value: unknown): KbRef[];
```

`parseEntries` 在 assistant 分支里写 `...(refs.length ? { kbRefs: refs } : {})`，与 `files` / `shares` 的写法一致（空数组不落字段）。

### 1.4 流式补齐（本轮唯一新增的跨端字段）

现状：消息由 SSE 事件就地拼装（`App.tsx` 的 `done` 分支），而 `kbRefs` 只存在于 entries。若不补，刚发出的那条回复要刷新页面才出现「参考资料」，NERE-41 验收第 1 条不成立。

契约：

- SSE `done` 事件新增**可选**字段 `kbRefs: Array<{docId, chunkId, chunkSeq, title, source?}>`，语义与 entry 完全一致（同一份数据，同一序列化）。
- 前端在 `done` 分支用同一个 `parseKbRefs(event.kbRefs ?? [])` 写进气泡；缺省时**不渲染、不追请求**（兼容未升级的后端）。
- 禁止为此在 `done` 后追加 `GET /api/entries`；也禁止用回复正文去匹配 entry（正文可变、会串会话）。

> 这一条已同步给 NERE-40 的负责人（见 NERE-40 评论）：属于后端一行的透传，不需要额外查询——命中的 chunk 在写 entry 时已在内存里。

## 2. 数据契约 B：分享清单与撤销（NERE-42 提供）

### 2.1 接口

| 方法 | 路径 | 成功响应 | 失败 |
| --- | --- | --- | --- |
| GET | `/api/shares/all?status=active\|expired\|all` | `{ shares: ShareRecordDto[] }` | 401 / 5xx |
| DELETE | `/api/shares/:token` | `{ ok: true }` | 404 链接不存在；403 不属于当前用户；5xx |

`status` 缺省按 `active`（服务端与前端默认值必须一致，只在前端写一次常量 `SHARES_DEFAULT_STATUS = "active"`，见 R-FE-3）。

示例响应（三条：2 文件 + 1 会话，其中一条被打开过 3 次）：

```json
{
  "shares": [
    {
      "token": "f7kqm3x9ab2c",
      "kind": "file",
      "name": "周报-2026-W42.md",
      "expiresAt": 1761782400000,
      "theme": "dark",
      "createdAt": "2026-10-22T03:11:09.402Z",
      "openCount": 3,
      "lastOpenedAt": 1761196800000,
      "sessionId": "c-9f3a1e",
      "url": "/s/f7kqm3x9ab2c"
    },
    {
      "token": "s2mz8qp1de4f",
      "kind": "conversation",
      "name": "久期是什么",
      "expiresAt": 0,
      "theme": "dark",
      "createdAt": "2026-10-21T22:04:51.118Z",
      "openCount": 0,
      "lastOpenedAt": 0,
      "sessionId": "c-9f3a1e",
      "url": "/s/s2mz8qp1de4f"
    }
  ]
}
```

字段口径（前端按此假设，后端偏离即 `[blocker]`）：

- `expiresAt`、`lastOpenedAt`：**epoch 毫秒 number**；`0` 分别表示「永久有效」「从未打开」。
- `createdAt`：ISO 8601 字符串（与现有 `ShareLinkInfo.createdAt` 一致）。
- `url`：**相对路径** `/s/<token>`（服务端在反代后拿不到正确 origin，见 `lib/format.ts` 的 `shareUrlFor`）。
- `kind`：只允许 `"file" | "conversation"`。

### 2.2 传输 DTO（`lib/api.ts`，命名不得与 `types.ts` 重名）

```ts
export interface ShareRecordDto {
	token: string;
	kind: "file" | "conversation";
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
	sessionId: string;
	url: string;
}

export interface SharesAllResponse {
	shares?: ShareRecordDto[];
}
```

`api` 新增两个方法（只在这里出现路径与 `fetch`）：

```ts
/** 全部有效分享链接（NERE-42）：默认只取 active，避免把过期记录画进面板。 */
sharesAll: (status: "active" | "expired" | "all" = "active") =>
	requestJson<SharesAllResponse>(withQuery("/api/shares/all", { status })),

/** 撤销一条分享（NERE-42）：立即失效。 */
revokeShare: (token: string) =>
	requestJson<{ ok?: boolean }>(`/api/shares/${encodeURIComponent(token)}`, { method: "DELETE" }),
```

保留既有 `api.shares(sessionId, kind, name?)`（`/api/shares`，分享弹窗复用已有链接用），两个接口不合并、不互相替代。

### 2.3 领域模型（`types.ts`）与解析（`lib/collections.ts`）

```ts
// src/web/types.ts
/** 一条分享记录（NERE-42 的 /api/shares/all）。与工具结果里的 ShareLink 不是同一件事。 */
export interface ShareRecord {
	token: string;
	kind: "file" | "conversation";
	name: string;
	expiresAt: number;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
	sessionId: string;
	/** 相对路径；渲染前经 lib/format.shareUrlFor 归一化。 */
	url: string;
}
```

`lib/collections.ts` 新增 `parseShareRecords(data: SharesAllResponse | unknown): ShareRecord[]`，规则与既有 parser 一致：非数组 → `[]`；丢弃 `token` 非字符串、`kind` 不在枚举内的项；数字字段缺失按 `0`，`name` 缺失按 `"（未命名）"`。

`ShareRecord` 与 `ShareLink`（聊天里的分享卡）字段相似但语义不同：**不许合并成同一个类型**，也不许在 `ShareRecord` 上复用 `ShareLink.reused` 之类只有工具结果才有的字段。

## 3. 前端落点清单

| 文件 | 层 | 动作 | 归属 |
| --- | --- | --- | --- |
| `src/web/types.ts` | 类型 | 加 `KbRef`、`ShareRecord`、`KbFocus`；`ChatMessage.assistant` 加 `kbRefs?` | 41 / 43 分别改，不冲突 |
| `src/web/lib/entries.ts` | L4 | 加 `parseKbRefs`，`parseEntries` 挂 `kbRefs` | NERE-41 |
| `src/web/lib/api.ts` | L4 | 加 `ShareRecordDto` / `SharesAllResponse` / `sharesAll` / `revokeShare` | NERE-43 |
| `src/web/lib/collections.ts` | L4 | 加 `parseShareRecords` | NERE-43 |
| `src/web/lib/format.ts` | L4 | 加 `formatExpiry(expiresAt, now?)`、`formatOpenedAt(ms)` | NERE-43 |
| `src/web/components/KbRefsBar.tsx` | L3 | 新建，纯展示 | NERE-41 |
| `src/web/components/SharesPanel.tsx` | L2 | 新建，容器（只依赖 hook） | NERE-43 |
| `src/web/components/ShareRow.tsx` | L3 | 新建，行（纯展示 + 回调） | NERE-43 |
| `src/web/hooks/useShares.ts` | hooks | 新建，唯一取数者 | NERE-43 |
| `src/web/components/MessageList.tsx` | L2 | 透传 `onOpenKbRef`，assistant 气泡末尾挂 `<KbRefsBar>` | NERE-41 |
| `src/web/components/KnowledgePanel.tsx` | L2 | 接 `focus?: KbFocus \| null`，按 nonce 打开文档 | NERE-41 |
| `src/web/components/Rail.tsx` | L3 | `RailView` 加 `"shares"`，加一项导航 | NERE-43 |
| `src/web/App.tsx` | L1 | 加 `kbFocus` 状态 + `shares` 左栏分支；**只允许这两个改动点** | 41 / 43 |

`App.tsx` 本轮**只增加 2 处状态**（`kbFocus`、`railView` 新枚值）。不许顺手把 `useShares` 的数据提到 `App`，也不许把 `shares` 接进 bootstrap 的 17 个面板（面板是按需打开的，进首屏等于让所有用户为没用到的面板付费）。

## 4. 组件边界 A：参考资料条（NERE-41）

### 4.1 `KbRefsBar`（纯展示，L3）

```tsx
export const KbRefsBar = memo(function KbRefsBar({
	refs,
	onOpen,
}: {
	refs: KbRef[];
	/** 点击某一篇：由页面层切到知识库并打开原文。缺省时只展示不可点。 */
	onOpen?: (ref: KbRef) => void;
});
```

职责与硬约束：

- **不请求**：不 import `lib/api`、不 import `hooks/*`、不认识 `/api/kb/doc`。数据只从 props 来。
- **空态不渲染**：`if (!refs || refs.length === 0) return null;`（验收第 2、3 条）。
- **按文档聚合**：同一 `docId` 的多个 chunk 只出现一次，标题后缀 `· N 段`；`refs` 里保留原始 chunk 顺序，聚合在展示层做（聚合函数放本文件内的纯函数 `groupByDoc`，可单测）。
- **默认收起**：默认只显示一行 `参考资料：N 篇`（N = 去重后的文档数），点击展开列表；展开态用 `aria-expanded` + `aria-controls`，列表用 `<ul>/<li>`。
- **可点**：`onOpen` 存在时每项是 `<button type="button">`（不是 `<a href>`，因为没有对应路由）；不存在时渲染 `<span>`，不要伪造链接。
- **`source` 只作次要信息**：有值时显示为 `第二行 / truncate`，`title` 属性给全文。
- 位置：assistant 气泡内、正文气泡**下方**（顺序：thinking → tools → files → shares → 正文 → kbRefs）。理由：参考资料是回复的脚注，不是产出物。
- 行数预算 ≤ 80 行；超出说明把聚合/样式塞进去了。

### 4.2 跳转到知识库原文（跨面板导航）

`KnowledgePanel` 目前把「查看某文档」的 `viewing` 状态和 `api.kbDoc()` 都关在自己内部（`frontend-map.md` 3.2 已记录）。本轮**不动它的取数位置**，用 props 注入跳转目标：

```ts
// src/web/types.ts
/** 从消息里的参考资料跳到知识库（NERE-41）。nonce 让「重复点同一段」也能再次触发。 */
export interface KbFocus {
	docId: number;
	chunkSeq?: number;
	nonce: number;
}
```

- `KnowledgePanel({ onCollapse, focus })`：新增 `useEffect`，依赖 `focus?.nonce`，调用既有的文档打开逻辑（`api.kbDoc(docId)` → `setViewing`）。
- 页面层（`App`）的 `onOpenKbRef` 做三件事：`setRailView("kb")`、`setLeftOpen(true)`、`setKbFocus({ docId, chunkSeq, nonce: ++focusSeq })`。`focusSeq` 用 `useRef`，不进 state。
- 定位粒度：`api.kbDoc` 只返回整篇 `content`，没有分段边界。本轮跳转 = 打开该文档；`chunkSeq` 只用于标题下方标注 `命中第 N 段`，**不做正文滚动定位**。后端将来返回分段时再补，写进 `[ARCH]` 待办。
- 手机端：跳转要保证左栏可见（抽屉展开），不能点了没反应。

## 5. 组件边界 B：分享面板（NERE-43）

### 5.1 分层

```
SharesPanel（L2 容器，取数只经 hook）
├─ PanelHeader（复用 components/PanelHeader.tsx，不复制；NERE-81 从 LeftPanels 拆出）
├─ 状态区：loading / error / empty
└─ <ul> ShareRow（L3，纯展示 + onCopy / onRevoke 回调）
```

### 5.2 `useShares`（hooks 层，唯一取数者）

```ts
export interface SharesState {
	items: ShareRecord[];
	status: "idle" | "loading" | "ready" | "error";
	/** 整体加载失败文案（面板级）。 */
	error: string | null;
	/** 行级动作反馈：撤销失败时给具体原因。 */
	actionError: string | null;
	/** 正在撤销的 token，用于禁用按钮 + aria-busy。 */
	revoking: ReadonlySet<string>;
	reload: () => void;
	revoke: (token: string) => Promise<void>;
}

export function useShares(): SharesState;
```

行为契约：

1. **一次请求**：挂载时发一次 `api.sharesAll()`；`reload()` 才再发。切换会话、`panelTick` 变化都**不**触发重取（验收第 3 条「打开面板只发 1 个请求」）。若 NERE-43 需要「切到面板才取」，允许把 `enabled` 作为参数，但同一挂载周期内仍只发一次。
2. **乐观更新 + 失败回滚**（验收第 2 条）：
   - 点撤销 → 立即从 `items` 移除该 token，加入 `revoking`；
   - 成功 → 什么都不用做（已是终态），`revoking` 清理；
   - 失败 → 按原索引插回（保留原顺序，不是 push 到末尾），`actionError` 写原因：
     - 403 → `没有权限撤销这条链接（可能不属于当前账号）`；
     - 404 → 视为成功（链接本来就没了），顺手移除、不报错；
     - 网络 / 5xx → `撤销失败：<ApiError.message>`，并保留该行以便重试。
3. **不做轮询**：打开次数是快照，不自动刷新；在面板头部给一个手动刷新按钮（`aria-label="刷新分享清单"`）。
4. 状态全在 hook 里，`SharesPanel` 不持有 `items` 副本。

### 5.3 `SharesPanel` 三态

| 态 | 触发 | 渲染 |
| --- | --- | --- |
| loading | 首次请求未回 | 3 行骨架，容器 `aria-busy="true"`，不显示「空」 |
| error | 整体请求失败 | `清单加载失败：<detail>` + 「重试」（调 `reload`） |
| empty | `status === "ready" && items.length === 0` | `还没有分享链接。在会话或文件上点分享后，链接会出现在这里。` |
| ready | 有数据 | 清单 + 计数（PanelHeader 的 `count`） |

行级 `actionError` 显示在清单顶部一行红色小字，可点 × 关闭；不要用 `alert()`。

### 5.4 `ShareRow`（L3）

一行展示：类型徽标（`文件` / `会话`）、`name`（truncate + `title`）、剩余有效期、`打开 N 次`、最近打开时间、复制、撤销。

- 有效期文案只经 `lib/format.formatExpiry(expiresAt, now?)`：`0 → 永久`；已过期 → `已过期`；其余 → `剩余 N 天` / `剩余 N 小时`。**不许**在组件里再写一份 `toLocaleString` 的到期拼接（现状 `ShareLinkCard` 有一份，属 `[ARCH]` R1 历史债，本轮不扩散）。
- 最近打开：`lastOpenedAt === 0 ? "从未打开" : formatTime(new Date(lastOpenedAt).toISOString())`（`formatTime` 已有，不新增）。
- 复制：`url` 先经 `shareUrlFor(record.url, window.location.origin, readTheme())` 归一化再写剪贴板。剪贴板实现只留一份：NERE-43 新建 `src/web/lib/clipboard.ts`（`copyText(text): Promise<boolean>`，含非安全上下文的 `execCommand` 兜底）并在本组件使用；**本轮不改** `ShareLinkCard` / `ShareDialog` / `Composer` 里的既有 4 份，全量收口归 `[ARCH]` R1。
- 撤销二次确认：行内两步（第一次点变「确认撤销」，2.5 秒无操作复原），不用 `window.confirm`。撤销中按钮 `disabled` + `aria-busy`。
- a11y：图标按钮必须有 `aria-label`（`复制分享链接 <name>` / `撤销分享 <name>`）；复制成功给文本反馈「已复制」（3 秒后复原），不能只变色。

## 6. 分层约束（W3 专项，可机器检查）

在 R-FE-1 至 R-FE-9 之上，本轮追加可 grep 的判定：

| 编号 | 约束 | 检查命令 | 违反 |
| --- | --- | --- | --- |
| D1 | 传输唯一 | `rg -n "fetch\(|XMLHttpRequest" src/web --glob '!**/lib/api.ts'` 无本次新增命中 | `[blocker]` |
| D2 | 组件层不碰传输层 | `rg -n 'from "\.\./lib/api"' src/web/components/KbRefsBar.tsx src/web/components/SharesPanel.tsx src/web/components/ShareRow.tsx` 无命中（`SharesPanel` 只用 `hooks/useShares`） | `[blocker]` |
| D3 | 接口路径不出传输层 | `rg -n '"/api/' src/web/components src/web/hooks` 无本次新增命中 | `[blocker]` |
| D4 | 领域类型唯一 | `types.ts` 与 `lib/api.ts` 无同名类型；DTO 以 `Dto` / `Response` 结尾 | `[blocker]` |
| D5 | 默认值唯一 | `status` 默认值、有效期文案、TTL 选项表各只有一处 | `[blocker]`（静默漂移） |
| D6 | 职责单一 | 本轮新增文件任一 > 300 行，或同一文件同时「取数 + 交互 + 复杂渲染」 | `[blocker]` |

补充：

- **禁止**把 `shares` 面板塞进 bootstrap 面板列表（首屏请求数是一条被测试断言过的契约，`tests/unit/bootstrap-web.test.ts`）。
- **禁止**在 `lib/entries.ts` 为 `kbRefs` 新增任何正则解析：它本来就是结构化字段（R-FE-4）。
- **禁止**把 `KbRef` 与 `KbHit` 合并：`KbHit` 带 `text` / `score`（检索态），`KbRef` 只有引用指针（持久化态）。`KbHit → KbRef` 的映射如需复用，放 `lib/collections.ts` 的纯函数。
- 新组件必须提供 memo 边界：`KbRefsBar`、`ShareRow` 都 `memo()`（`MessageList` 每次 `elapsed` tick 都重渲染整棵树，R-FE-8）。

### 6.1 产物预算

当前构建：`index-*.js` 435 KB / gzip ≈ 124 KiB，`index-*.css` 65 KB。本轮两个特性的预算：**gzip 增量 ≤ 6 KiB**（构建后 JS gzip ≤ 130 KiB）。超了在 PR 里说明原因，否则 `[建议]`。

## 7. 验收核对表（PR 评审逐条打勾）

### NERE-41

1. [ ] 知识库只有 A、B 两篇时问「久期是什么」→ 回复下方出现 `参考资料：1 篇`，展开是 A 的标题，点击打开知识库并展示 A 正文；
2. [ ] 紧接着问「今天天气怎么样」→ 该回复下**没有**该行；
3. [ ] 老会话（entry 无 `kbRefs`）/ `kbRefs: []` / `kbRefs` 非数组 → 不报错、不渲染（有单测覆盖 `parseKbRefs` 的三种输入）；
4. [ ] `KbRefsBar.tsx` 无 `api.`、无 `fetch(`、无 `"/api/`；
5. [ ] `rg -n "kbRefs" src/web` 的命中只出现在 `types.ts`、`lib/entries.ts`、`components/KbRefsBar.tsx`、`MessageList.tsx`、`App.tsx`；
6. [ ] 展开/收起有 `aria-expanded`；无 `onOpen` 时不渲染 `<a>`；
7. [ ] `npm test` 全绿。

### NERE-43

1. [ ] 3 条链接（2 文件 + 1 会话）→ 面板 3 行，`打开 N 次` / 最近打开时间与 `/api/shares/all` 一致；
2. [ ] 撤销一行 → 该行立即消失；原链接 404；其余两行不变；断网撤销 → 行回到**原位置**并有错误文案；
3. [ ] 打开面板到渲染完成只有 **1** 个 `/api/shares/all` 请求（DevTools Network 计数）；
4. [ ] 空态与错误态都有中文文案；错误态有重试；
5. [ ] `SharesPanel.tsx` 无 `api.` / `fetch(` / `"/api/`；取数只在 `hooks/useShares.ts`；
6. [ ] 复制得到的是**当前 origin 的绝对链接**（不是 `workers.dev`）；
7. [ ] 撤销按钮有 `aria-label`，撤销中有 `aria-busy`/`disabled`，复制成功有文本反馈；
8. [ ] `npm test` 全绿；构建产物 gzip 增量 ≤ 6 KiB。

## 8. 本轮不做（避免范围蔓延）

- `App.tsx` 拆分 / hooks 化（`[ARCH]` R2）；
- 剪贴板 4 份实现全量收口（`[ARCH]` R1，本轮只新建 `lib/clipboard.ts` 供新组件用）；
- 删掉 `entries.ts` 里从中文展示串解析分享链接的兜底（`[ARCH]` R1）；
- `ShareLinkCard` 迁移到 `formatExpiry`（记为后续 nit，不做）；
- 分享清单分页 / 搜索 / 过期记录列表（`status=expired|all` 接口留着，UI 本轮只做 `active`）。

## 9. 变更记录

| 日期 | 变更 | 发起 |
| --- | --- | --- |
| 2026-10-22 | 初版：NERE-40 / NERE-42 的前端契约、两个特性的组件边界与分层约束 | 前端架构-qian（NERE-44） |

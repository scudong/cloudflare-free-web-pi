# Skill Hub 契约（NERE-53）

- 状态：Accepted（2026-10-22）
- 维护人：后端架构-hou
- 消费者：NERE-54（前端市场/筛选/详情）、NERE-55（后端实现）
- 关联：[`docs/architecture-map.md`](./architecture-map.md)、[`docs/adr/0001-layering.md`](./adr/0001-layering.md)、[`docs/adr/0003-skill-hub-runtime.md`](./adr/0003-skill-hub-runtime.md)
- 契约版本：`1`（审计规则版本 `1`）

本文件只定契约，不含实现。**字段名、枚举值、状态码、审计判定以本文件为准**；与 NERE-54 的前端补充冲突时，以本文件为准（见 §7.4 的两处对齐说明）。

## 0. 一句话

Skill Hub 只上架三类技能：`prompt`（纯说明书）、`javascript`、`typescript`。其余运行时在**导入时**判定 `blocked`，不入库；列表里的审计状态只是快照，**安装时的本地重审计才是权威**。

## 1. 术语与运行模型

| 术语 | 定义 |
|---|---|
| 技能包 | 一份 `skill.json` manifest + 一份内容文件（`SKILL.md` 或可执行入口 `index.js`） |
| `prompt` 技能 | 只有说明书，由 `load_skill` 注入提示词；不执行任何代码 |
| `javascript` / `typescript` 技能 | 入口脚本是 **codemode 方言**（async 函数体，`tools.<name>()`、`return`、`load("args")`），在 QuickJS 沙箱执行 |
| 目录（catalog） | 只读 JSON 索引，条目只有元数据 + 内容地址 + 哈希 + 审计快照 |
| 安装 | 把技能内容写入当前用户 DO 的 `skills` 表；`blocked` 永不写入 |
| 审计 | 对 manifest + 内容做确定性规则判定，产出 §4.4 的报告 |

运行模型（v1，不新增 binding、不新增 Worker）：

```text
GET /api/skills/hub
  → Worker 鉴权 → 用户 SpikeAgent DO
  → 读内置 catalog（构建期打入 Worker 模块，零 subrequest）
  → 合并已安装技能 + audit 缓存
  → 纯 CPU 过滤/排序/分页 → JSON

POST /api/skills/import
  → 取内容（URL 抓取 或 请求体）
  → 本地审计（纯 CPU）
  → blocked：422，不写库
  → pass/warn：写 skills 表（幂等），写 skill_audits 缓存
```

两条硬边界：

1. **沙箱里没有 `fetch`、`process`、`require`、`import`、`WebAssembly`、定时器**，只有注入的 `tools`、`store/load`、`text/image/exit`（pi-codemode README，2026-10 版）。网络只能经 `http_fetch` / `web_fetch_page` 工具出站。
2. **`nodejs_compat` 只影响 Worker 主运行时，不影响 QuickJS 沙箱**。技能代码拿不到 Node 内置模块。

## 2. Manifest：`skill.json`

### 2.1 包形态

v1 只支持**单文件技能**（沙箱没有模块加载，多文件代码无法 `import`）：

```text
<name>/
  skill.json        # manifest（必需）
  SKILL.md          # runtime=prompt 的内容文件
  index.js          # runtime=javascript 的入口
  index.js + index.ts  # runtime=typescript：index.js 是编译产物，index.ts 是源码
```

- `runtime=typescript` 的技能**必须**同时提供编译后的 `index.js`；`entry` 指向 `.js`，`entrySource` 指向 `.ts`。Worker 不做运行时转译。
- 数据文件、多文件模块、WASM 在 v1 一律不支持（见 §4 L2/L4）。
- 目录/压缩包不是 v1 的导入格式；导入只接受单文件 URL 或单文件请求体。

### 2.2 字段

| 字段 | 必填 | 类型/约束 | 说明 |
|---|---|---|---|
| `schemaVersion` | 是 | 常量 `1` | manifest 结构版本 |
| `name` | 是 | `^[a-z][a-z0-9-]{1,39}$` | 唯一键；与现有 `skills.name` 主键一致（≤40 字符） |
| `version` | 是 | SemVer 2.0，≤32 字符 | `1.2.3` / `1.2.3-beta.1` |
| `description` | 是 | 1–200 字符 | 与现有导入的 200 字符截断一致 |
| `author` | 是 | 1–80 字符 | 展示名或 `Name <email>` |
| `source` | 是 | 绝对 `https://` URL，≤512 字符；存量/手工技能为 `local` | 发布来源；用于筛选与溯源 |
| `license` | 是 | SPDX 表达式或 `UNLICENSED`，≤64 字符 | 只做展示与合规提示 |
| `runtime` | 是 | `prompt` \| `javascript` \| `typescript` \| `python` \| `shell` \| `binary` \| `other` | 后四类恒 `blocked`；未知字面量按 `other` 处理（fail closed） |
| `tags` | 是 | 0–8 个，`^[a-z0-9][a-z0-9-]{0,23}$`，去重 | 前端 tag/category 筛选 |
| `requires.tools` | 是 | 0–16 个内置工具名，见 §2.3 | 只能声明白名单内工具 |
| `requires.bindings` | 是 | 必须为 `[]` | v1 不允许技能申请任何 binding |
| `requires.network` | 是 | 0–16 个域名/通配，见 §2.4 | 仅声明，不是运行时强制 |
| `contentHash` | 条件 | `^sha256:[0-9a-f]{64}$` | 目录/发布 manifest 必填；`manifest+content` 直接导入可省略，服务端重算。见 §2.5 |
| `signature` | 否 | `{alg:"ed25519",keyId,sig}` | v1 只记录、不验证（见 §4.6） |
| `entry` | 条件 | 相对路径，无 `..`，≤64 字符 | `javascript/typescript` 必填且为 `.js`；`prompt` 省略 |
| `entrySource` | 否 | 相对路径，`.ts` | 仅 `typescript`，源码路径 |
| `homepage` | 否 | 绝对 `https://` URL | 展示用 |
| `publishedAt` | 否 | ISO 8601 | 目录排序用 |

未知字段：**拒绝**（`400`），避免拼写错误静默生效。`additionalProperties: false`。

### 2.3 可用工具白名单

技能声明/调用的工具只允许以下 18 个（按审批分级）：

| 分级 | 工具 |
|---|---|
| `read` | `now` `recall` `list_skills` `load_skill` `read_file` `list_files` `kb_search` `kb_list` `web_search` `web_fetch_page` `http_fetch` `update_plan` |
| `write` | `remember` `kb_add` `kb_delete` `write_file` `share_file` `share_conversation` |

审批分级以 `src/worker.ts` 的 `TOOL_CATEGORY` 为准；本表白名单只决定「可声明」，不改变审批策略。

以下工具**禁止**出现在 `requires.tools`，出现即 `blocked`：

`install_skill`（自安装）、`codemode`（递归执行）、`dispatch_tasks`（子代理放大）、`ask_user`（交互阻塞）、`tool_search`（工具面泄露）、`set_goal` / `complete_goal` / `report_goal`（会话编排）。

MCP 工具（`mcp__*`）与用户自定义工具名**不可声明**：每个用户的 MCP/自定义工具不同，不可移植。

### 2.4 网络声明

- 形式：`api.github.com`、`*.githubusercontent.com`；不允许 scheme、端口、路径。
- 禁止：`*`、裸 TLD（`*.com`）、IP 字面量、`localhost`、`*.local`、私有网段。
- 语义：**声明是审计元数据，不是运行时 ACL**。v1 不会按技能收窄 `http_fetch` 的出站范围；执行时仍受 Worker 的 6 并发连接 / 50 subrequests（Free）限制。这一点必须在详情页写清楚，避免用户误以为是沙箱隔离。
- 通配只允许最左一级：`*.example.com` 匹配 `a.example.com`，不匹配 `a.b.example.com`。

### 2.5 `contentHash` 规范化

哈希覆盖**实际执行/注入的字节**，不覆盖 manifest 自身（否则与 hash 字段循环）：

| runtime | 哈希对象 |
|---|---|
| `prompt` | `SKILL.md` 去掉 frontmatter 后的正文（UTF-8，原样，不做换行归一化） |
| `javascript` / `typescript` | `entry` 指向的 `index.js` 文件字节 |

算法：`sha256`，小写十六进制，前缀 `sha256:`。示例：`sha256:589f21f9…`。

服务端行为：

- 导入请求里的 `contentHash` **忽略并重算**；若请求带了 `expectedHash`，与重算值不一致 → `blocked`（`I1`）。
- 目录条目必须带 `contentHash`；安装时抓到的内容哈希与之不一致 → `blocked`，不写库。
- `signature` 的签名对象就是 `contentHash` 字符串；v1 不验签，只在报告里标 `unverified`。

### 2.6 兼容现有 SKILL.md（frontmatter）

现有 `/api/skills/import` 与社区目录只有 YAML frontmatter（`name`、`description`）。兼容规则：

- 无 `skill.json`、内容以 `---` frontmatter 开头 → 合成 manifest：
  `runtime="prompt"`、`version="0.0.0"`、`license="UNLICENSED"`、`author=""`、`source=<导入 URL>`、`tags=[]`、`requires={tools:[],bindings:[],network:[]}`。
- 合成 manifest 必然触发 `I3`（version/license/author 缺失）→ `warn`，可安装。
- **存量 `skills` 行豁免 I3**：迁移时回填 `runtime='prompt'`、`audit_status='pass'`、`source='local'`、`version='0.0.0'`，视为已验收的历史内容；`content_hash` 首次读取时惰性计算并回填。只有**新导入**的 legacy 内容才产生 `I3 warn`。
- 无 manifest 时的 runtime 启发式只看 fenced code block 的 language tag、首行 shebang、入口扩展名，**不按正文裸词**判定（避免把「Python 不受支持」判成 Python 技能）。

## 3. Cloudflare Worker 能力矩阵（审计依据，写死）

### 3.1 可执行 / 不可执行

| 能力 | 结论 | 证据 |
|---|---|---|
| JavaScript（codemode 方言） | 可执行 | `createInlineCodemodeSandbox`，`src/worker.ts:1550`（memory 64 MiB） |
| TypeScript | 仅编译后 `.js` 可执行 | Worker 无运行时转译；manifest 强制 `entry` 为 `.js` |
| Python / shell / 原生二进制 / 子进程 | 不可执行 | 沙箱只有 QuickJS VM；无 `process`/`child_process`/`fs`；不能 spawn |
| 自定义 JS 工具 | 可执行（独立沙箱） | `sandbox()` 32 MiB / 15 s，`src/worker.ts:435-437` |
| 多文件模块 / `import()` / `require()` | 不可用 | pi-codemode：无模块加载 |
| WASM | 不可用 | 沙箱不暴露 `WebAssembly`；Worker 也不能在运行时编译 Wasm |
| `eval` / `Function` | 仅限同一 VM 内 | 产出的代码不能逃出 QuickJS；不构成宿主代码执行 |

### 3.2 可用端口

| 端口 | 技能如何使用 | 限制 |
|---|---|---|
| 出站网络 | 仅 `http_fetch` / `web_fetch_page` 工具（Worker `fetch`） | Free 50 subrequests/请求、6 并发连接；单次抓取结果被工具截断（6000/8000 字） |
| 工作台文件（VFS） | `read_file` / `list_files` / `write_file` | 按会话隔离（`vfs_v2`，`conversation_id`）；不是全局文件系统 |
| 知识库 | `kb_search` / `kb_add` / `kb_list` / `kb_delete` | 走既有 KB Service；无原始 SQL |
| DO SQLite | **不能直接访问** | 无 SQL 工具；只能经上述业务工具 |
| Workers AI / Vectorize | **不能直接访问** | 仅 `kb_search` 内部使用 |
| 新增 binding / 环境变量 | **不可用** | 技能不能改 `wrangler.jsonc`，沙箱不暴露 `env` |
| 子进程 / 原生二进制 / OS 文件系统 | **不可用** | 无对应运行时 |

### 3.3 资源上限（量化依据）

依据 Cloudflare 官方 Limits（2026-10-12 / 2026-06-01 版）与仓库现状：

| 项 | 值 | 对 Hub 的含义 |
|---|---|---|
| CPU / 请求 | Free **10 ms**；Paid 默认 30 s、可调至 5 min | 本项目按 Free 设计：Hub 列表/审计必须纯 CPU、轻量；实质脚本执行在 Free 下会撞 `1102`（既有风险，非 Hub 引入） |
| 内存 / isolate | **128 MB** | 同 isolate 所有请求共享；沙箱 VM 之外的大对象要避免 |
| Subrequests / 请求 | Free **50**；Paid 10,000 | **Hub 列表零抓取**：目录快照构建期生成；导入最多 1 次抓取 + ≤3 次重定向 |
| 并发出站连接 | **6** | 不做目录批量审计；禁止一次请求并发抓 N 个内容地址 |
| 请求体 | Free 100 MB（平台），本项目自限 **512 KiB** | 导入内容 ≤256 KiB，manifest ≤16 KiB |
| Worker 包体 | 64 MiB 未压缩 | 内置 catalog ≤256 KiB，可安全打入模块 |
| DO SQLite 行/值 | **2 MB** | 审计报告 ≤8 KiB，目录缓存 ≤256 KiB，均远低于上限 |
| DO SQLite 语句 | 100 KB / 100 参数 | 审计报告单行 JSON 写入安全 |
| DO 存储 | Free 每对象 1 GB、账户 5 GB；Paid 每对象 10 GB | 每用户目录缓存上限 256 KiB；默认不缓存远程目录 |
| DO CPU | 文档默认 30 s/请求（计划限制另计） | 单次审计必须 <50 ms；单次导入抓取 ≤10 s 墙钟 |
| QuickJS VM | 仓库配置 64 MiB；库默认 32 MiB | 技能代码不能假定 >64 MiB 堆 |
| 沙箱中断预算 | 默认 100,000 polls ≈ Cloudflare 上 10 s 紧循环 | 单次技能执行实际可用计算 ≈10 s；应在 manifest 之外设执行超时 |
| 内联沙箱 | 同步阻塞调用方 DO | 长脚本会阻塞该用户 DO 的其它请求（pi README 实测：同 DO 内 10 s 脚本 → 其它请求延迟 10 s）；v1 接受，见 ADR-0003 |

## 4. 审计规则

### 4.1 扫描面（关键）

误报控制优先：**不按裸词匹配**。`python` 出现在「Python 不受支持」这类说明文字里不应 blocked。

| 扫描面 | 扫什么 | 不扫什么 |
|---|---|---|
| manifest | 全部字段（schema、枚举、白名单、URL、密钥模式） | — |
| `prompt` 内容（`SKILL.md`） | fenced code block 的 language tag、块内首行 shebang、明确的命令调用行（`python x.py`、`bash x.sh`、`sh -c`、`pip install`、`curl … \| sh`）；行内反引号中的工具名（供 C5 计数） | 正文里对语言的普通提及；行内反引号里的非工具单词 |
| `javascript` / `typescript` 入口 | 去掉注释与字符串字面量后的标识符/调用：`child_process`、`fs`、`process`、`require(`、`import(`、`WebAssembly`、`new Worker`、`Deno`、`Bun` | 注释、字符串里的同名词 |
| 文件分类 | 扩展名 + 首 8 字节魔数（ELF `7f 45 4c 46`、PE `4d 5a`、Mach-O `cf fa ed fe` 等） | — |

`prompt` 技能里的 ` ```js ` 块是合法示例，不阻断；` ```python `/` ```bash `/` ```sh ` 块视为「要求宿主执行」，`blocked`。

### 4.2 规则表

每条规则独立产出一条 `reason`；同一规则多次命中合并为一条（`evidence` 取首个）。

| ID | 判定 | 级别 | 条件 |
|---|---|---|---|
| **M1** | manifest schema / name / version / 未知字段不合法 | blocked | 显式 `skill.json` 的必填缺失或类型/正则不符；§2.6 合成的 legacy manifest 不适用本条（缺字段走 I3） |
| **M2** | 体积超限 | blocked | manifest >16 KiB；内容 >256 KiB；目录条目 >200 |
| **M3** | runtime 不支持 | blocked | `runtime ∈ {python,shell,binary,other}` 或未知值 |
| **M4** | 申请 binding | blocked | `requires.bindings.length > 0` |
| **M5** | 工具不可用 | blocked | `requires.tools` 含白名单外、`mcp__*`、自定义工具名或禁用工具（§2.3） |
| **M6** | 网络声明非法 | blocked | `*`、裸 TLD、IP、localhost、私有网段、带 scheme/路径 |
| **M7** | 疑似密钥泄露 | blocked | 内容/manifest 命中 `sk-[A-Za-z0-9]{20,}`、`ghp_[A-Za-z0-9]{36}`、`AKIA[0-9A-Z]{16}`、`xox[baprs]-` |
| **L1** | entry 与 runtime 不匹配 | blocked | `js/ts` 缺 `entry` 或非 `.js`；`prompt` 带 `entry` |
| **L2** | TS 未编译 | blocked | `runtime=typescript` 且无 `.js` 入口；`entrySource` 非 `.ts` |
| **L3** | 非 JS 可执行文件 | blocked | 出现 `.py/.sh/.bash/.zsh/.rb/.php/.pl/.ps1` 等入口或支撑脚本 |
| **L4** | 二进制 / WASM | blocked | 魔数命中或扩展名 `.exe/.dll/.dylib/.so/.node/.wasm/.bin/.pyc` |
| **L5** | 非 JS shebang | blocked | 入口首行 `#!` 且解释器不是 JS |
| **C1** | Node/宿主 API | blocked | 去注释/字符串后命中 `child_process`、`fs`、`process`、`require(` |
| **C2** | 动态加载 / 编译 | blocked | `import(`、`WebAssembly`、`new Worker`、`Deno`、`Bun` |
| **C3** | 使用未声明的网络 | warn | 代码中 `http_fetch`/`web_fetch_page` 的 URL 字面量主机不在 `requires.network` |
| **C4** | 声明但未使用的网络 | warn | `requires.network` 中的主机在代码/说明里没有出现 |
| **C5** | 使用未声明的工具 | warn | 代码里 `tools.<name>()` 或说明里反引号工具名不在 `requires.tools`（白名单内） |
| **C6** | 使用禁用工具 | blocked | 调用 §2.3 禁用工具 |
| **C7** | 声明但未使用的工具（仅 js/ts） | warn | 入口代码中没有 `tools.<name>(` 引用；prompt 技能不做此判定（正文用法无法可靠识别） |
| **I1** | 哈希缺失/不匹配 | blocked / warn | 目录条目缺哈希、安装时哈希不一致 → blocked；导入 manifest 缺 `contentHash` 且无 `expectedHash` → warn（服务端已计算）；存量行豁免 |
| **I2** | 签名问题 | blocked / warn | 结构非法 → blocked；结构合法但未验证 → warn（`signature.unverified`） |
| **I3** | 元数据缺失 | warn | `version=0.0.0`、`license=UNLICENSED`、`author` 为空、`source` 为空（legacy 合成 manifest 必中） |
| **S1** | prompt 含非 JS 代码块 | blocked | ` ```python `/` ```bash `/` ```sh `/` ```shell `/` ```zsh `/` ```powershell ` |
| **S2** | prompt 要求宿主命令 | blocked | 行首 `$? python`、`bash …`、`sh -c`、`pip install`、`npm i -g`、`brew install`、`apt install` |
| **S3** | 管道执行 / 远程安装 | blocked | `curl … \| sh`、`wget … \| bash`、`iex(irm …)` |
| **X1** | 导入 URL 非 HTTPS | blocked | scheme ≠ `https:` |
| **X2** | SSRF | blocked | 主机为 IP 字面量、`localhost`、`.local`、私有/环回/链路本地网段；重定向每一跳重新校验 |
| **X3** | 抓取超限 | blocked | 内容 >512 KiB、10 s 超时、>3 次重定向 |
| **X4** | 内容类型不支持 | blocked | `Content-Type` 非 `text/markdown` / `text/plain` / `application/json`（缺省按 text 处理） |

### 4.3 聚合

- 任一 `blocked` → `status = "blocked"`；
- 否则任一 `warn` → `status = "warn"`；
- 否则 `status = "pass"`。
- `reasons` 按 `blocked` → `warn` → `pass` 排列，同级别按规则 ID 字典序；`pass` 规则**不出现在 reasons 里**（空数组即全过）。
- 结果确定性：同一组 `(manifest, content)` 在同一 `rulesVersion` 下必须产出完全相同的结果（数组顺序也相同）。时间戳 `auditedAt` 与 `hash` 除外。

### 4.4 报告结构

```ts
type AuditStatus = "pass" | "warn" | "blocked";

interface AuditReason {
  rule: string;        // "M3" / "S1" / "X2" …
  level: AuditStatus;  // pass 不出现
  message: string;     // 面向用户的中文，≤200 字
  evidence?: string;   // ≤120 字；正文片段/文件名，不含完整密钥
}

interface AuditReport {
  status: AuditStatus;
  reasons: AuditReason[];
  detected: {
    runtime: "prompt" | "javascript" | "typescript" | "python" | "shell" | "binary" | "other";
    network: string[];   // 去重、升序
    tools: string[];     // 去重、升序
  };
  auditedAt: string;     // ISO 8601
  hash: string;          // 本次审计实际计算出的 contentHash
  rulesVersion: 1;       // 新增字段；规则语义变化时递增
  auditSource: "local" | "catalog"; // 本地重审计 / 目录快照
}
```

`detected` 只描述**检测结果**，不代表已授权。`reasons` 是唯一给用户看的解释来源；前端不得自行推断状态。

### 4.5 审计权威与缓存

| 场景 | 权威来源 | 说明 |
|---|---|---|
| Hub 列表中的目录条目 | `catalog.audit` 快照（`auditSource:"catalog"`） | 构建期用同一规则生成；列表请求不做抓取、不做审计 |
| Hub 列表中的已安装技能 | 本地重审计（`auditSource:"local"`） | 内容在 DO 里，纯 CPU；按 `content_hash` 缓存 |
| 安装 | **本地重审计**（`auditSource:"local"`） | 目录快照与本地结果不一致时以本地为准；哈希不一致直接 blocked |
| 远程目录条目缺 `audit` | 视为 `blocked`（`I1` + `M1`） | fail closed；不得因为缺字段就当 pass |

缓存：`skill_audits(hash PRIMARY KEY, status, report JSON, audited_at)`。缓存命中条件是 `hash + rulesVersion`；规则版本变化后自然 miss。缓存行 ≤8 KiB。

### 4.6 签名（v1）

- 结构：`{"alg":"ed25519","keyId":"<≤64>","sig":"<base64 ≤128>"}`。
- v1 没有信任根，**不验签**；`signature` 存在 → `I2 warn`，`message="签名未验证（v1 无信任根）"`。
- 结构缺失/超长 → `I2 blocked`。
- 不因为签名缺失而 warn（可选字段）。

## 5. API 契约

### 5.1 路由与鉴权

浏览器侧统一前缀 `/api`，Worker 去掉前缀后转发到用户 DO（既有行为）。所有端点要求登录态；`/s/*` 公开路由不涉及。

| 方法 | 浏览器路径 | DO 内部路径 | 说明 |
|---|---|---|---|
| GET | `/api/skills/hub` | `/skills/hub` | 市场列表 + 审计状态 |
| GET | `/api/skills/:name/audit` | `/skills/:name/audit` | 单技能审计报告 |
| POST | `/api/skills/import` | `/skills/import` | 导入（URL 或 manifest+content），先审计 |
| GET/POST/DELETE | `/api/skills` | `/skills` | 既有 CRUD，行为不变 |

匹配顺序必须是 `hub` → `:name/audit` → 既有精确 `/skills`，避免 `hub` 被当成技能名。

错误封套（新端点）：

```json
{ "error": "审计未通过：运行时 python 不受支持", "code": "audit_blocked", "details": { "audit": { } } }
```

| 状态码 | `code` | 场景 |
|---|---|---|
| 400 | `bad_request` | JSON/schema/参数非法 |
| 401 | `unauthorized` | 未登录（Worker 层既有行为） |
| 404 | `not_found` | 技能不存在 |
| 409 | `name_conflict` | 同名不同哈希且未带 `overwrite=1` |
| 413 | `too_large` | 超过 §3.3 自限 |
| 422 | `audit_blocked` | 审计 `blocked`；**不写库** |
| 502 | `upstream_failed` | 抓取失败/超时/重定向超限 |

### 5.2 `GET /api/skills/hub`

查询参数：

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `q` | string ≤100 | 空 | 对 name/description/tags 做小写子串匹配（不做 FTS，避免每请求建索引） |
| `runtime` | 逗号分隔 | 全部 | 只接受 `prompt,javascript,typescript`（别名 `js`/`ts`）；其它值 → 400 `bad_request` |
| `tag` | 逗号分隔 | 全部 | 任一命中（OR） |
| `audit` | `pass,warn,blocked` 逗号分隔 | 全部 | 精确匹配审计状态 |
| `source` | string ≤128 | 全部 | 对 `source` 的 host 做子串匹配 |
| `origin` | `bundled` \| `remote` | 全部 | 目录来源 |
| `installed` | `0` \| `1` | 全部 | 是否已安装 |
| `sort` | `audit` \| `name` \| `updated` | `audit` | `audit` = pass→warn→blocked，同级按 name 升序 |
| `limit` | int | 50 | 1–200 |
| `offset` | int | 0 | ≥0 |

响应：

```ts
interface HubResponse {
  skills: HubSkill[];
  total: number;
  nextOffset: number | null;
  catalog: {
    source: "bundled" | "remote";
    fetchedAt: string | null; // bundled 为构建时间
    stale: boolean;           // 远程刷新失败时为 true
    count: number;
  };
  filters: {                  // 供前端渲染筛选项，取自当前目录全集
    runtimes: string[];
    tags: string[];
    sources: string[];        // host
  };
}

interface HubSkill {
  name: string;
  version: string;
  description: string;
  author: string;
  source: string;             // URL 字符串，前端直接展示
  license: string;
  runtime: "prompt" | "javascript" | "typescript" | "python" | "shell" | "binary" | "other";
  tags: string[];
  requires: { tools: string[]; bindings: string[]; network: string[] };
  contentHash: string;
  installed: boolean;
  installedHash?: string;     // 同名已安装但内容不同 → 前端提示「可更新」
  audit: AuditReport;         // 含 status/reasons/detected/auditedAt/hash
}
```

硬规则：

- `runtime` 筛选只返回该 runtime 的条目，且只允许 `prompt/javascript/typescript`；`python/shell/binary/other` 条目**不能**用 runtime 筛选，只能通过 `audit=blocked`（或不带 `runtime`/`audit`）出现，且 `installed` 恒为 `false`。
- 列表请求**不得产生 subrequest**（内置目录）或最多 1 次（远程目录刷新）；不得为了审计抓取内容。
- 目录加载失败时返回 200 + `catalog.stale=true` + 已安装技能列表；不得 5xx（降级路径）。
- 响应头：`Cache-Control: private, max-age=30`；含 `installed` 状态，禁止 CDN 缓存。

### 5.3 `GET /api/skills/:name/audit`

- `name` 必须匹配 manifest 的 name 正则；否则 400。
- 已安装：本地重审计（命中缓存则直接返回）。
- 仅目录存在：返回目录快照（`auditSource:"catalog"`）。
- 都不存在：404。
- 响应：`{ name, version, contentHash, source, audit: AuditReport }`。
- 响应头：`Cache-Control: no-store`。

### 5.4 `POST /api/skills/import`

请求体两种互斥形态：

```jsonc
// A. URL 导入
{ "url": "https://example.com/skills/demo/SKILL.md", "expectedHash": "sha256:…", "overwrite": false }

// B. manifest + content 导入
{
  "manifest": { /* §2.2 */ },
  "content": "const x = await tools.now({});\nreturn x;\n",
  "expectedHash": "sha256:…",
  "overwrite": false
}
```

- A 形态：`url` 必须 HTTPS；抓取限制见 X1–X4。
  - `url` 指向 `skill.json`：按该 manifest 的 `entry` 解析相对地址并抓取内容（最多 2 次内容抓取，重定向计入）。
  - `url` 指向 `SKILL.md` 或任意文本：按 §2.6 合成 legacy `prompt` manifest；若目录里已有同名条目且带 `contentHash`，用 `expectedHash` 校验。
  - `expectedHash` 始终与 §2.5 的规范化结果比较（prompt 为去 frontmatter 后的正文，不是原始文件字节）。
- B 形态：`content` 是 entry 或 SKILL.md 正文；manifest 的 `contentHash` 由服务端重算并覆盖，不接受客户端自证；manifest 缺 `contentHash` 且无 `expectedHash` → `I1 warn`（可安装）。
- 内容上限：256 KiB（UTF-8 字节）；manifest 16 KiB；超过 → 413。
- 幂等：同一 `(name, contentHash)` 重复导入 → 200 `{installed:true, changed:false}`，不重复写。
- 同名不同哈希：默认 409 `name_conflict`；`overwrite:true` 才覆盖（覆盖前仍审计）。
- `blocked`：422，**不写 `skills`**；可写 `skill_audits`（只含哈希与报告，不含正文），便于重复扫描命中缓存。`warn/pass` 才写 `skills`。
- 成功响应：

```json
{
  "ok": true,
  "installed": true,
  "changed": true,
  "name": "github-issues",
  "version": "1.0.0",
  "description": "…",
  "source": "https://…",
  "contentHash": "sha256:…",
  "audit": { "status": "pass", "reasons": [], "detected": { }, "auditedAt": "…", "hash": "sha256:…" }
}
```

`ok/name/description/source` 与现有前端 `importSkill` 的读取字段保持兼容；`blocked` 时返回 `{ok:false, installed:false, error, code:"audit_blocked", details:{audit}}`。

- 并发：DO 天然串行；不需要额外锁。抓取期间不得持有 `open()` 的 Harness 资源（只做纯 HTTP + 审计）。

### 5.5 既有 `/skills` 兼容

| 端点 | 契约 |
|---|---|
| `GET /skills` | 保持 `{skills:[{name,description,created_at}]}`；可追加字段，不得改名/删除 |
| `POST /skills` | 保持 `{name,description,content}` → `{ok:true}`；不审计（用户手工输入，信任边界内），写入时 `runtime="prompt"`、合成 manifest、`content_hash` 惰性计算 |
| `DELETE /skills?name=` | 保持 `{ok:true}`；同时删除对应 `skill_audits` 中不再被引用的行（可选清理） |

新功能只走新路径；旧端点不因 Hub 上线改变状态码或字段语义。

**准入**：`buildInstructions` 的技能索引与显式 `load_skill` 只接受 `audit_status != 'blocked'` 的技能；blocked 行即使因历史原因存在也不可见、不可加载。旧 `/skills` GET 不过滤（保持兼容），但 Hub 与模型侧工具走过滤后的视图。

### 5.6 数据模型（NERE-55 实现，本文不建表）

迁移 `v3`（在 `src/worker/db/migrations.ts` 递增，`ensureColumn` 幂等）：

```sql
ALTER TABLE skills ADD COLUMN version TEXT NOT NULL DEFAULT '0.0.0';
ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE skills ADD COLUMN author TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN license TEXT NOT NULL DEFAULT 'UNLICENSED';
ALTER TABLE skills ADD COLUMN runtime TEXT NOT NULL DEFAULT 'prompt';
ALTER TABLE skills ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';           -- JSON string[]
ALTER TABLE skills ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN audit_status TEXT NOT NULL DEFAULT 'pass'; -- pass|warn|blocked
ALTER TABLE skills ADD COLUMN audit_report TEXT NOT NULL DEFAULT '{}';   -- AuditReport JSON
ALTER TABLE skills ADD COLUMN manifest TEXT;                             -- 原始 skill.json，≤16 KiB
ALTER TABLE skills ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE skills SET updated_at = created_at WHERE updated_at = '';

CREATE TABLE IF NOT EXISTS skill_audits (          -- 可选缓存，NERE-55 可省
  hash TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  report TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  PRIMARY KEY (hash, rules_version)
);
```

- NERE-55 列出的 9 个字段（`version/source/author/runtime/tags/content_hash/audit_status/audit_report/updated_at`）全部包含；`license` 与 `manifest` 是契约追加的两列，用于详情页与重审计，同一迁移加、无额外表。
- 存量行：默认值即完成回填（`prompt` / `pass` / `local` / `0.0.0`），只需补 `updated_at`；**不重写 `content`、不改 `audit_status`**，保证升级后仍可调用。
- `audit_status` 是准入的唯一判据（构建 instructions 的技能索引、显式 `load_skill` 都只看它）；`audit_report` 是详情页与 `/audit` 的数据源。
- `skill_audits` 只做重复审计缓存；查询按 `(hash, rules_version)` 主键，不建额外索引。表行数 ≈ 内容哈希数 × 用户，远低于 DO 限额。
- 目录缓存（仅远程启用时）：`app_settings` 键 `skill_catalog_url`、`skill_catalog_cache`（`{etag, fetchedAt, catalog}`，序列化 ≤256 KiB）。默认空 = 只用内置目录，零存储、零 subrequest。

分层（ADR-0001）：`routes/skills.ts`（HTTP）→ `services/skill-service.ts`（编排：目录装载、合并、分页、导入）→ `repo/skills-repo.ts`（SQL）；`lib/skill-audit.ts` 是纯函数（输入 manifest+content，输出报告）。路由层零 SQL；审计不依赖 DO 上下文，必须能单测。

## 6. 目录源

### 6.1 `skills/catalog.json`

构建期生成，作为 JSON 模块打入 Worker（`import catalog from "../../skills/catalog.json"`；需 `resolveJsonModule` 或由脚本生成 `.ts` 常量）。运行时**不读文件系统**（Worker 没有）。

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T00:00:00Z",
  "entries": [
    {
      "schemaVersion": 1,
      "name": "pure-js",
      "version": "1.0.0",
      "description": "读取当前时间",
      "author": "hou",
      "source": "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/pure-js",
      "license": "MIT",
      "runtime": "javascript",
      "tags": ["utility"],
      "requires": { "tools": ["now"], "bindings": [], "network": [] },
      "entry": "index.js",
      "contentUrl": "https://raw.githubusercontent.com/scudong/cloudflare-free-web-pi/main/skills/pure-js/index.js",
      "contentHash": "sha256:589f21f9e11c4ab10c7a103197086d920b81d611d00c16ea7df5c07592ccebe5",
      "audit": {
        "status": "pass",
        "reasons": [],
        "detected": { "runtime": "javascript", "network": [], "tools": ["now"] },
        "auditedAt": "2026-10-22T00:00:00Z",
        "hash": "sha256:589f21f9e11c4ab10c7a103197086d920b81d611d00c16ea7df5c07592ccebe5",
        "rulesVersion": 1,
        "auditSource": "catalog"
      }
    }
  ]
}
```

规则：

- 条目只存**元数据 + 内容地址 + 哈希 + 审计快照**，不内联内容。
- `contentUrl`：必须是绝对 `https://` URL（内置与远程目录一致）。`runtime=typescript` 时指向编译后的 `.js`（不是 `.ts`）。列表不抓取；安装时抓取并重算哈希（1 次 subrequest）。
- 内置目录：≤200 条、≤256 KiB、**不允许 blocked 条目**（CI 失败）；`audit.hash` 必须等于 `contentHash`。
- 远程目录：≤200 条、≤512 KiB；条目缺 `audit` 或 `audit.hash != contentHash` → 该条目 `blocked`（`I1`），仍展示但不可安装。
- 重名：保留第一条，后续条目跳过并在服务端日志记一条 warning；不因重名让整个目录失效。
- `source` 与 `origin`：`bundled` 是内置文件；`remote` 由 `skill_catalog_url` 配置。默认不配置 = 只读内置。

### 6.2 远程目录刷新

- `fetch` 带 `If-None-Match`；304 → 续用缓存并更新 `fetchedAt`。
- TTL 10 分钟（进程内 LRU，按 isolate）；`app_settings.skill_catalog_cache` 作为跨 isolate 的兜底。
- 抓取失败 → 用最近缓存（≤7 天）；无缓存 → 只用内置目录，`catalog.stale=true`，不报 5xx。
- 远程目录是**内容地址清单**，不是代码执行入口；安装仍走本地审计。

## 7. 筛选维度（前端按此实现）

### 7.1 维度

| 维度 | 参数 | 取值来源 | 行为 |
|---|---|---|---|
| 运行时 | `runtime` | `filters.runtimes`（只含 prompt/javascript/typescript） | 正向筛选；python/shell 不出现在筛选选项里，只在 `audit=blocked` 视图中出现 |
| 分类/标签 | `tag` | `filters.tags` | OR；多选逗号分隔 |
| 审计状态 | `audit` | 固定三值 | 精确匹配；`blocked` 条目安装按钮禁用 |
| 来源 | `source` / `origin` | `filters.sources` | host 子串 / bundled-remote |
| 关键词 | `q` | 用户输入 | name/description/tags 子串，≤100 字符 |
| 已安装 | `installed` | — | 0/1 |
| 排序 | `sort` | 固定 | 默认 `audit`：pass → warn → blocked，同级 name 升序 |

### 7.2 默认排序的理由

市场首屏应优先展示可安装项；`blocked` 排在最后但仍可见（教育目的：告诉用户为什么被挡）。「audit 优先」在本文的精确定义是**按可通过性升序**（pass 最前），不是按字母或时间。

### 7.3 空态与错误

- 目录为空：`skills: []`、`total: 0`，前端显示空态。
- 远程目录失败：200 + `catalog.stale=true`；前端显示「目录可能过期」条，不阻塞已安装列表。
- 后端未上线：`/api/skills/hub` 404/5xx → 前端显示错误重试，不无限 loading（NERE-54 验收 3）。

### 7.4 与 NERE-54 的两处对齐

1. **新增 `runtime=prompt`**。NERE-53 正文只列了 JS/TS；但现有 `skills` 表 100% 是提示词内容，若 `prompt` 也被 blocked，等于全部存量技能不可安装。NERE-54 的补充（2026-10-22）已明确 `prompt` 是可筛选/可安装维度。本文采纳 `prompt` 为第三种可安装运行时，`python/shell/binary/other` 仍恒 blocked。
2. **`POST /api/skills/import` 的失败语义**：blocked 从「200 + ok:false」改为 **422 + code=audit_blocked**。前端 `importSkill` 需处理 422 并展示 `details.audit.reasons`；`/skills` CRUD 不受影响。

## 8. 五个示例与期望审计结果

以下内容即 v1 的验收样例；`contentHash` 已按 §2.5 计算（JS 为文件原样字节；prompt 为**去掉 frontmatter 后的正文**，均含结尾换行），可直接作为 NERE-54 测试数据与 NERE-55 单测 fixture。

### 8.1 可安装 1：纯 JS，无网络

`skill.json`：

```json
{
  "schemaVersion": 1,
  "name": "pure-js",
  "version": "1.0.0",
  "description": "读取当前时间",
  "author": "hou",
  "source": "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/pure-js",
  "license": "MIT",
  "runtime": "javascript",
  "tags": ["utility"],
  "requires": { "tools": ["now"], "bindings": [], "network": [] },
  "entry": "index.js",
  "contentHash": "sha256:589f21f9e11c4ab10c7a103197086d920b81d611d00c16ea7df5c07592ccebe5"
}
```

`index.js`：

```js
const now = await tools.now({});
return { now };
```

期望：`pass`。`detected = {runtime:"javascript", network:[], tools:["now"]}`；`reasons = []`。

### 8.2 可安装 2：TypeScript + fetch 声明

`skill.json`（节选）：

```json
{
  "schemaVersion": 1,
  "name": "github-issues",
  "version": "1.2.0",
  "description": "列出仓库的最新 issue",
  "author": "hou",
  "source": "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/github-issues",
  "license": "MIT",
  "runtime": "typescript",
  "tags": ["github", "api"],
  "requires": { "tools": ["http_fetch"], "bindings": [], "network": ["api.github.com"] },
  "entry": "index.js",
  "entrySource": "index.ts",
  "contentHash": "sha256:27c91b161e9d6155f5c8740f45e006a24151f33f7d010dc03e6fb2c14843ae8f"
}
```

`index.js`（编译产物；`index.ts` 同逻辑带类型）：

```js
const { repo } = load("args");
const page = await tools.http_fetch({ url: `https://api.github.com/repos/${repo}` });
return page;
```

期望：`pass`。`detected = {runtime:"typescript", network:["api.github.com"], tools:["http_fetch"]}`；`reasons = []`。

### 8.3 可安装 3：纯提示词，无网络

`skill.json`（节选）：

```json
{
  "schemaVersion": 1,
  "name": "offline-notes",
  "version": "1.0.0",
  "description": "用工作台文件做离线笔记",
  "author": "hou",
  "source": "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/offline-notes",
  "license": "MIT",
  "runtime": "prompt",
  "tags": ["notes", "offline"],
  "requires": { "tools": ["read_file", "list_files", "write_file"], "bindings": [], "network": [] },
  "contentHash": "sha256:dbdb7947e6a4451a2ee2b334b5a13e2e0252b58c3ac3942703a4913d9848a80d"
}
```

`SKILL.md`：

```markdown
---
name: offline-notes
description: 用工作台文件做离线笔记
---
# 离线笔记
1. 用 `list_files` 查看已有笔记。
2. 用 `read_file` 读取，用 `write_file` 写回。
只使用工作台文件，不访问网络。
```

期望：`pass`。`detected = {runtime:"prompt", network:[], tools:["list_files","read_file","write_file"]}`；`reasons = []`。

### 8.4 blocked 1：Python 脚本

`skill.json`（节选）：

```json
{
  "schemaVersion": 1,
  "name": "csv-report",
  "version": "1.0.0",
  "description": "用 Python 生成 CSV 报告",
  "author": "hou",
  "source": "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/csv-report",
  "license": "MIT",
  "runtime": "python",
  "tags": ["csv"],
  "requires": { "tools": [], "bindings": [], "network": [] },
  "entry": "main.py",
  "contentHash": "sha256:8f9153bfdab71afd056f19a2a44a442746e4d193b5e6ec378d2f7a6a886a6d10"
}
```

`main.py`：

```python
#!/usr/bin/env python3
import csv
import sys

def main() -> None:
    with open(sys.argv[1], newline="") as f:
        for row in csv.DictReader(f):
            print(row)

if __name__ == "__main__":
    main()
```

期望：`blocked`，至少三条：

```json
{
  "status": "blocked",
  "reasons": [
    { "rule": "M3", "level": "blocked", "message": "运行时 python 不受支持：Worker 只能执行 JS/TS" },
    { "rule": "L3", "level": "blocked", "message": "包含非 JS 可执行文件 main.py" },
    { "rule": "L5", "level": "blocked", "message": "入口 shebang 不是 JavaScript 解释器", "evidence": "#!/usr/bin/env python3" }
  ],
  "detected": { "runtime": "python", "network": [], "tools": [] },
  "hash": "sha256:8f9153bfdab71afd056f19a2a44a442746e4d193b5e6ec378d2f7a6a886a6d10"
}
```

### 8.5 blocked 2：Shell 脚本

`skill.json`（节选）：

```json
{
  "schemaVersion": 1,
  "name": "db-backup",
  "version": "1.0.0",
  "description": "用 shell 打包笔记备份",
  "author": "hou",
  "source": "https://github.com/scudong/cloudflare-free-web-pi/tree/main/skills/db-backup",
  "license": "MIT",
  "runtime": "shell",
  "tags": ["backup"],
  "requires": { "tools": [], "bindings": [], "network": [] },
  "entry": "backup.sh",
  "contentHash": "sha256:b2e22f3cde88b5d471546cff6af7799e5e709f85bae3597501561fdbaff2e44e"
}
```

`backup.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
tar -czf backup.tgz "$HOME/notes"
echo "backup written"
```

期望：`blocked`，`M3` + `L3` + `L5`，`detected = {runtime:"shell", network:[], tools:[]}`，`hash` 同上。

### 8.6 附加：warn（可安装）

同为 `runtime=prompt` 的 `weather-brief`：声明 `network=["api.open-meteo.com","api.example.com"]`，说明里只用了第一家；且 `license` 缺失（合成 manifest）。期望 `warn`，可安装：

```json
{
  "status": "warn",
  "reasons": [
    { "rule": "C4", "level": "warn", "message": "声明了未使用的网络域名 api.example.com" },
    { "rule": "I3", "level": "warn", "message": "缺少 license；legacy manifest 已按 UNLICENSED 处理" }
  ]
}
```

## 9. 边界、非目标与风险

### 9.1 非目标

- 不做技能运行时隔离的新 Worker/新 binding；JS 技能复用现有 codemode。
- 不做运行时网络 ACL（声明不强制）。
- 不做签名信任根、密钥轮换、发布者账号体系。
- 不做多文件包、依赖安装、技能间依赖解析。
- 不做服务端全文检索；`q` 只做目录内子串匹配。
- 不改 `POST /skills` 的信任模型（登录用户手写内容仍直接入库）。

### 9.2 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Free 计划 10 ms CPU | Hub 列表/审计可能 `1102` | 列表零抓取、纯 CPU；审计单内容 ≤256 KiB；目录快照构建期生成；limit 默认 50 |
| 内联沙箱阻塞 DO | 长技能脚本阻塞该用户所有请求 | v1 接受（ADR-0003）；执行超时 20 s；后续可切 `RemoteCodemodeSandbox` |
| 目录快照与内容漂移 | 列表显示 pass，安装时 blocked | 安装强制重审计 + 哈希校验；响应 `auditSource` 标注来源 |
| 远程目录被投毒 | 展示恶意/夸大审计 | 远程条目缺审计即 blocked；安装本地重审；哈希不匹配 blocked |
| SSRF | 导入内网地址 | X1/X2：HTTPS、IP/私网/localhost 拒绝、逐跳重定向校验 |
| 密钥泄露 | 技能内容带 token | M7 直接 blocked，证据截断不落全文 |
| 审计正则误报 | 正常 JS 被 blocked | 去注释/字符串后匹配；prompt 只扫 fence language/shebang/命令行；规则版本化 |
| 存量技能被误伤 | 升级后列表全 blocked | 存量合成 manifest 固定 `runtime=prompt`，最坏 `warn`（I3） |
| 目录重名/同名覆盖 | 安装错内容 | 目录重名保留首条；导入同名不同哈希需 `overwrite:true` |

### 9.3 回滚

- 契约回滚：本文件与 ADR-0003 独立于代码，回滚只需 revert 文档 PR。
- 实现回滚（NERE-55）：新端点删除即回退；`skills` 增量列可保留（旧代码忽略）；`skill_audits` 可整表删除。旧 `/skills` 路径未改语义，回滚不需数据迁移。

## 10. 验收对照

| 验收项 | 落点 |
|---|---|
| manifest 最小字段 + runtime 枚举 | §2.1–2.5 |
| Worker 能力矩阵（可执行/可用/不可用/资源） | §3.1–3.3 |
| 审计规则（每条 pass/warn/blocked） | §4.2 |
| 审计结果结构 | §4.4 |
| API 契约 + 旧接口兼容 | §5 |
| 目录源（`skills/catalog.json` + 可选远程） | §6 |
| 筛选维度 | §7 |
| 5 个示例与期望结果 | §8.1–8.5 |
| 可实现结论 | §11 |

## 11. 对 NERE-54 / NERE-55 的结论

**可实现。** 两条前置约束必须在实现前接受：

1. **前端**（NERE-54）：`runtime` 增加 `prompt`；`POST /api/skills/import` 的 blocked 走 422 + `details.audit`；Hub 列表字段以 §5.2 为准（`source` 是 URL 字符串，`audit` 是完整报告）。
2. **后端**（NERE-55）：审计必须是纯函数（`lib/skill-audit.ts`），目录快照构建期生成；列表零抓取；安装强制重审 + 哈希校验；只做 §5.6 的增量列与 `skill_audits` 表，不新增 binding、不新增 DO。

与 NERE-54 的分歧只剩 §7.4 两点，已按「契约优先」定稿；NERE-55 若发现某条规则在 Workers Free 的 10 ms CPU 内不可实现，先开 PR 改本文件（附实测数据），再改代码。

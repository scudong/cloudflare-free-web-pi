# ADR-0003：Skill Hub 的运行时边界与审计权威

- 状态：已接受（Accepted，2026-10-22）
- 日期：2026-10-22
- 决策人：后端架构-hou（NERE-53）
- 影响范围：`src/worker.ts` 的 `/skills*` 路由、NERE-55 新增的 `routes/skills.ts`、`services/skill-service.ts`、`lib/skill-audit.ts`、`skills/catalog.json`
- 关联：[`docs/skill-hub-contract.md`](../skill-hub-contract.md)、[`docs/adr/0001-layering.md`](./0001-layering.md)

## 背景

Skill Hub 要在 Cloudflare Worker 上提供筛选与审计。约束是硬的：

- 运行时只有 QuickJS 沙箱里的 JS/TS；没有 Python、shell、原生二进制、子进程、文件系统、模块加载。
- Workers Free 单请求 CPU 10 ms、50 subrequests；DO 单对象存储 1 GB（Free）、行为 2 MB。
- 现有 `skills` 表只存提示词正文，100% 是 `prompt` 语义；如果只允许 JS/TS，线上全部存量技能会被判 blocked。
- 当前 `POST /skills/import` 抓取任意 URL 后直接写库，没有运行时/内容审计，也没有 SSRF 防护。

契约文档给出完整字段、能力矩阵、审计规则与 API；本 ADR 只记录四个需要裁决、且会影响失败半径的选择。

## 决策

### 1. `prompt` 是第三种可安装运行时

`runtime` 枚举收敛为 `prompt | javascript | typescript` 可安装，`python | shell | binary | other` 恒 blocked。

理由：提示词技能不执行代码，Worker 能完整支持；把它判 blocked 会让存量数据与现有社区目录（badlogic/pi-skills 全部是 SKILL.md）整体不可用。NERE-54 的补充已要求 `prompt` 进入筛选维度。

后果：前端筛选项必须包含 `prompt`；「只有 JS/TS」的对外表述改为「可执行的只有 JS/TS，提示词技能不执行代码」。

### 2. TypeScript 在发布期编译，运行时只执行 `.js`

Worker 没有运行时转译。`runtime=typescript` 的包必须同时带编译后的 `index.js`（`entry`）与 `index.ts`（`entrySource`）；缺 `.js` 即 blocked。

理由：在请求路径引入 esbuild/TS 编译器会显著抬高 CPU/包体，且 Free 10 ms 下不可行。发布期编译把成本放到 CI。

后果：作者的构建步骤成为上架门槛；契约用 manifest 校验把错误挡在导入时，而不是执行时。

### 3. 列表审计用目录快照，安装审计必须本地重做

- `GET /skills/hub` 不抓取内容、不做审计：目录条目携带构建期生成的 `audit` 快照。
- `POST /skills/import` 必须本地重审计抓到的内容，并校验 `contentHash`；本地结果覆盖目录快照。
- 目录快照与本地结果不一致时以本地为准；哈希不匹配直接 blocked。

理由：Hub 列表若有 N 条就抓 N 次，Free 50 subrequests 与 10 ms CPU 都会被打穿；而列表状态只是展示，安装才是安全边界。把权威放在唯一会写库的路径上，失败半径最小。

后果：远程目录的审计快照不可信但可用（fail closed：缺审计即 blocked）；安装路径多一次抓取与纯 CPU 审计，成本可控（内容 ≤256 KiB）。

### 4. v1 不新增 binding、不新增 DO，JS 技能复用内联 codemode

技能代码是 codemode 方言，在现有 `InlineCodemodeSandbox`（64 MiB）里执行；不注册为新的工具、不新增 Worker、不新增 binding。网络只能经 `http_fetch`/`web_fetch_page`，存储只能经 VFS/KB 工具。

已知代价：内联沙箱同步阻塞调用方 DO，长脚本会延迟该用户的所有请求（pi-codemode README 实测同 DO 内 10 s 脚本 → 其它请求延迟 10 s）。v1 的目标是 20 s 执行超时；NERE-55 落地时需确认现有 `codemode` 的默认 `timeoutMs`，并在技能执行入口显式传入。若技能执行成为高频路径，再评估 `RemoteCodemodeSandbox`（独立 Worker + binding），那是一次独立决策。

## 备选方案

1. **只允许 JS/TS**：安全表述最简单，但存量技能与现有社区目录全部不可用；否决。
2. **列表实时抓取并审计**：状态最新，但 N 次 subrequest + CPU，Free 计划不可行；否决。
3. **信任远程目录的审计结果，安装不再审**：省一次 CPU，但把安全边界交给目录发布者；否决。
4. **为技能代码新建独立 sandbox Worker**：隔离最好，但新增部署单元、binding、跨 Worker RPC 与配额，超出本阶段；推迟。
5. **运行时网络 ACL（按 `requires.network` 强制）**：需要在每个工具调用外层做 per-skill 包装，v1 无执行上下文标识；推迟，契约明确声明「声明不强制」。

## 后果

正面：

- Hub 列表是纯 CPU 常量成本，不消耗 subrequest。
- 审计规则可单测：`lib/skill-audit.ts` 输入 manifest+content，输出报告，与 DO 无关。
- 导入是唯一安全闸门，SSRF、非 JS 运行时、密钥泄露都在写库前拦截。
- 旧 `/skills` CRUD 语义不变，回滚只需删新端点。

负面：

- 目录快照可能滞后，列表 pass 而安装 blocked（已用 `auditSource` + 安装重审暴露）。
- 发布期编译与目录生成引入构建步骤（NERE-55/CI）。
- 内联沙箱阻塞 DO 的问题被继承，不在本 ADR 解决。
- 网络声明不强制，用户可能高估隔离强度（详情页必须写明）。

## 回滚

- 文档回滚：revert 本 ADR 与契约 PR。
- 实现回滚：删除 `/skills/hub`、`/skills/:name/audit` 与导入审计分支；`skills` 新增列可保留（旧代码忽略），`skill_audits` 可整表删除；`POST /skills/import` 恢复直接写库（会重新暴露 SSRF，不建议长期保留）。

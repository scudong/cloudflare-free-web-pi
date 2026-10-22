# 内置技能

Skill Hub 的内置技能目录。每条技能一个目录，目录名与 `SKILL.md` 的 `name`、`catalog.json` 的 `name` 一致。

全部技能均为 `runtime=prompt`：只有说明书，由模型按内容调用内置工具，不执行任何代码。工具声明只使用契约 §2.3 的 18 个白名单工具。

## 索引

### 原生技能（NERE-60，6 条）

| 名称 | 标签 | 解决什么 |
|---|---|---|
| `meeting-notes` | meeting | 把录音转写、聊天记录或零散笔记整理成决议、待办、负责人和截止时间 |
| `weekly-report` | writing | 把一周工作记录整理成周报或日报，突出结果、数据、风险和下周计划 |
| `code-review-checklist` | engineering | 按风险优先级审查代码变更，覆盖正确性、边界、并发、安全、兼容性和测试 |
| `research-brief` | research | 把研报、公告、访谈或网页资料压缩成结论先行、证据可追溯的摘要 |
| `reply-polish` | business | 润色客服、商务和跨部门回复，保留原意与承诺边界 |
| `requirement-breakdown` | product | 把一句话需求拆成用户故事、边界场景和可验证的验收标准 |

### 外部改编技能（NERE-61，6 条）

| 名称 | 标签 | 解决什么 | 原作者 | 许可证 |
|---|---|---|---|---|
| `bp-diagnose-root` | diagnosis, debugging | 用复现、隔离、假设、验证四阶段定位缺陷根因 | Daniel（bigpowers） | MIT |
| `bp-grill-me` | planning, review | 用连续追问压力测试计划，区分事实与决策 | Daniel（bigpowers） | MIT |
| `bp-terse-mode` | communication, writing | 极简表达，删掉客套与冗余，保留技术事实 | Daniel（bigpowers） | MIT |
| `bp-simple-english` | writing, documentation | 用简化技术英语规则改写文档，句子短、术语唯一 | Daniel（bigpowers） | MIT |
| `ponytail` | engineering, simplicity | 懒惰资深开发模式，用最少的新代码完整解决问题 | Dietrich Gebert（ponytail） | MIT |
| `ponytail-review` | engineering, code-review | 按正确、安全、负载、测试、速度、精简的顺序评审改动 | Dietrich Gebert（ponytail） | MIT |

## 来源与改编说明

外部技能都保留了原作者、原始项目地址和许可证，具体字段见各目录的 `skill.json` 与 `catalog.json` 条目。两条上游项目均为 MIT 许可证，允许再分发和改编。

改编原则：

- 去掉对本地 shell、脚本、npm 包、工作区文件路径和插件 hook 的依赖。
- 原技能里的本地文件读写改为通过 `read_file` / `list_files` 访问当前工作台。
- 原技能里的网页抓取改为通过 `web_fetch_page` 访问，并在 `requires.tools` 中声明。
- 保留原技能的方法、检查项和硬门槛，不改变其判断标准。
- 每个 `SKILL.md` 末尾的「来源与改编」写明原始技能、作者和改动范围。

## 目录约定

```text
skills/
  catalog.json          # Hub 索引：元数据、contentUrl、contentHash、审计快照
  README.md             # 本文件
  <skill-name>/
    SKILL.md            # runtime=prompt 的内容文件
    skill.json          # manifest：来源、许可证、工具声明、contentHash
```

规则：

- `contentHash` 按契约 §2.5 计算：`SKILL.md` 去掉 frontmatter 后的正文，UTF-8 原样字节，SHA-256。
- `contentUrl` 指向仓库 `main` 分支的原始文件，安装时抓取并重算哈希。
- `audit.hash` 必须等于 `contentHash`；内置目录不允许 `blocked` 条目。
- 新增条目同时更新 `catalog.json` 和本索引。
- 修改 `SKILL.md` 正文后必须重算 `contentHash`，同步 `skill.json` 与 `catalog.json`。
- 不覆盖已有技能；同名条目由服务端按 `name_conflict` 处理。

## 审计

`catalog.json` 的 `audit` 是目录快照，安装时的本地重审计才是权威。当前 12 条全部为 `pass`，`reasons` 为空。

## 许可证

原生 6 条为 MIT。外部改编技能遵循各自上游的 MIT 许可证，版权归原作者；改编说明见各技能末尾。

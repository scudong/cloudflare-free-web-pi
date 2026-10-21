# 仓库改名

> 结论先放前面：**推荐 `pi-station`，对外叫「π 空间站 / PiStation」**。
> 如果更看重「几乎没有同名项目」，选 `pi-harbor`（π 港湾）。

## 为什么需要改

现在叫 `pi-harness`：这是对内核技术栈的描述，不是产品名。

- 和上游 `earendil-works/pi` 的 harness 概念、以及 GitHub 上其它同名 fork 混在一起，搜索时说不清是谁。
- 「harness」对非开发者没有画面感；在小红书上无法一句解释。
- 公开推广需要一个能被记住、能画 logo、能当话题标签的名字。

## 候选（2026-10-21 检索）

GitHub 的 `in:name` 计数会把子串命中算进去（例如 `pi-station` 会命中 `pi-weather-station`），所以「仓库数」只作参考，重点看是否有**同领域的直接同名项目**。

| 名称 | 仓库名 | 中文 | GitHub 同名情况 | npm | 判断 |
|---|---|---|---|---|---|
| **PiStation** | `pi-station` | π 空间站 / π 小站 | `pistation` 47 个；最靠前是树莓派相关项目，非 AI | 可用 | **推荐** |
| **PiHarbor** | `pi-harbor` | π 港湾 | 仅 1 个（dkorn3/PiHarbor） | 可用 | 最独特，备选 |
| Piper | `piper` | — | 已被 TTS / 其它项目大量占用 | 占用 | 不建议 |
| PiWorkshop | `pi-workshop` | π 工坊 | 计数高但多为子串噪音 | 可用 | 偏内容创作，可作备选 |
| PiLoom | `pi-loom` | π 织机 | 1 个 | 可用 | 独特但抽象 |
| PiHaven | `pi-haven` | π 避风港 | 3 个 | 可用 | 语气偏「避难」，不太贴合 |
| `pi-harness-cloud` | 同左 | — | 保留现有认知 | — | 保守方案，不推荐做品牌 |

## 推荐：PiStation

**为什么是它**

- **有画面**：空间站 = 常驻云端、可停靠、可扩展；正好对应「durable、always-on、每人一个空间」。
- **中英文都能说**：英文 PiStation，中文「π 空间站」；小红书可以叫「π 小站」，更亲切。
- **短、好拼、好搜**：`pi-station` 带连字符，和树莓派的 `pistation` 在搜索上能区分。
- **能画 logo**：π 字 + 轨道 / 对接环，一套视觉很好延展。
- **和功能对得上**：多用户 = 多个舱段；知识库 = 资料舱；分享 = 对外接口。

**风险**：GitHub 上已有树莓派方向的 PiStation 项目，但领域不同；发布时 GitHub Description 写清「AI agent workspace on Cloudflare」，避免误解。

**中文口号备选**

- π 空间站：把你的 AI 助手停靠在云端。
- π 小站：一个人的 AI 工作台，也能分给同事。
- 一个 Worker，一间自己的 AI 空间站。

## 改名清单

GitHub 改名后旧 URL 会自动 301 跳转，但下面这些地方要一起改，否则品牌会分裂：

- [ ] GitHub 仓库名 → `pi-station`
- [ ] 本地 `git remote set-url origin git@github.com:scudong/pi-station.git`
- [ ] `README.md` 标题、图片 alt、Release / 文档里的链接
- [ ] `package.json` 的 `name`
- [ ] `src/web/index.html` 的 `<title>` 与 `meta description`
- [ ] 顶栏品牌字（`TopBar.tsx` 里的「Harness」，以及右侧显示的 Worker 名）
- [ ] GitHub Description：`Cloudflare 上的多用户 AI agent 工作台：durable、文件分享、独立知识库`
- [ ] Topics：`ai-agent` `cloudflare-workers` `durable-objects` `rag` `mcp` `self-hosted` `chinese`
- [ ] X / 小红书头像、简介、置顶链接
- [ ] 社交预览图（1200×630），用新名字 + 四个支柱

**不要动**：`wrangler.jsonc` 里的 `name: "pi-harness-spike"`。改 Worker 名会创建一个新的 Worker，现有域名、DO、数据都要迁移；品牌改名不等于基础设施改名。

## 备选：PiHarbor（π 港湾）

如果发布后发现 `pi-station` 的搜索混淆太严重，换 `pi-harbor`：

- 几乎唯一的同名项目，npm 也可用。
- 「港湾」= 让 Agent 停靠、让资料靠岸；适合自托管 / 长期使用的叙事。
- 缺点：比「空间站」安静，攻击性弱一点；logo 不如 π + 轨道好画。

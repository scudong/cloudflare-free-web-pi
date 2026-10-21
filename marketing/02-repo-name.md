# 仓库改名

> 结论：**仓库名用 `cloudflare-free-pi-agent`**。
> 它把「Cloudflare + free + pi agent」四个词完整写进名字里，搜索友好，且当前 GitHub / npm 都没有同名项目。
> 短名备选：`cf-free-pi-agent`；品牌化备选：`freeflare-pi`。

## 为什么用组合名

公开推广的第一诉求是**被搜到、被一眼看懂**。组合名同时回答了三个问题：

- 跑在哪：**Cloudflare**
- 花多少钱：**Free**（Cloudflare 免费额度内）
- 是什么：**pi agent**

比 `pi-harness` 这种技术代号更适合做仓库名，也比纯品牌名（PiStation / PiHarbor）更容易被搜索命中。

## 候选（2026-10-21 检索）

| 名称 | 仓库名 | 读法 | GitHub 同名 | npm | 判断 |
|---|---|---|---|---|---|
| **Cloudflare Free Pi Agent** | `cloudflare-free-pi-agent` | 完整组合 | 0 | 可用 | **推荐** |
| CF Free Pi Agent | `cf-free-pi-agent` | 短一截，CF = Cloudflare | 0 | 可用 | 短名备选 |
| FreeFlare Pi | `freeflare-pi` | free + flare + pi | 0 | 可用 | 品牌化备选 |
| Cloudflare Pi Agent | `cloudflare-pi-agent` | 少了 free | 0 | 可用 | 不完整 |

> GitHub 搜索用 `in:name`，计数为 0 表示没有仓库名包含这串词；发布前可再查一次。

## 对外怎么叫

| 场景 | 写法 |
|---|---|
| 仓库 / URL | `cloudflare-free-pi-agent` |
| GitHub 标题 | Cloudflare Free Pi Agent |
| X 简介 / 帖子 | **Cloudflare Free Pi Agent** — a durable, multi-user AI workspace on Workers + Durable Objects. |
| 小红书 | **Cloudflare 免费 π 助手**（副标题：一个人的 AI 工作台） |
| 中文短称 | 免费 π 助手 / CF π 助手 |

缩写可以偶尔用 **CFPA**，但首次出现要写全称。

## 风险与处理

- **名字长**：`cloudflare-free-pi-agent` 26 个字符，URL 不算短；换来的是搜索与自解释。日常口头用「Free Pi Agent」。
- **Cloudflare 商标**：仓库名包含 Cloudflare 属于社区常见用法，但必须在 README 顶部写明：
  > Not affiliated with Cloudflare, Inc. Cloudflare and Workers are trademarks of Cloudflare, Inc.
- **「Free」的边界**：README 与文案统一写「Cloudflare 免费额度内；模型按量计费」，不要写成完全免费。

## 改名清单

- [ ] GitHub 仓库名 → `cloudflare-free-pi-agent`
- [ ] 本地 `git remote set-url origin git@github.com:scudong/cloudflare-free-pi-agent.git`
- [ ] `README.md` 标题与首段：突出 Cloudflare + Free + Pi Agent
- [ ] `README.md` 顶部加「Not affiliated with Cloudflare」声明
- [ ] `package.json` 的 `name` → `cloudflare-free-pi-agent`
- [ ] `src/web/index.html` 的 `<title>` 与 `meta description`
- [ ] 顶栏品牌字与右侧 Worker 名显示
- [ ] GitHub Description：`A free, durable, multi-user pi agent workspace on Cloudflare Workers + Durable Objects.`
- [ ] Topics：`cloudflare-workers` `durable-objects` `ai-agent` `pi-agent` `self-hosted` `rag` `mcp` `chinese`
- [ ] X / 小红书头像、简介、置顶链接
- [ ] 社交预览图（1200×630）：Cloudflare Free Pi Agent + 四个支柱

**不要动**：`wrangler.jsonc` 里的 `name: "pi-harness-spike"`。改 Worker 名会创建新 Worker，现有域名、DO 与数据都要迁移；仓库改名不等于基础设施改名。

## 早期候选（已放弃）

PiStation（π 空间站）、PiHarbor（π 港湾）这类品牌名画面感更好，但不含 Cloudflare / free，搜索和自解释都弱一截；留作未来做独立产品站时的品牌名。

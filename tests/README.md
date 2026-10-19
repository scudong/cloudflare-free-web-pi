# 金标用例（golden cases）

每个功能都配一组**确定性**用例。功能再加，回归也只是一条命令：

```bash
npm test           # 全部（单元 + 接口）
npm run test:unit  # 只跑纯函数，毫秒级
npm run test:api   # 只跑接口（会启动 wrangler dev）
```

CI 里 `npm test` 在 `wrangler deploy` **之前**执行——用例不过就不部署。

---

## 目录

```
tests/
  unit/          纯函数金标（不需要服务器）
    rich.test.tsx      Markdown 渲染：标题/表格/列表/代码块/XSS
    entries.test.ts    会话转录解析：顺序、思考块、工具归属、文件产出
    format.test.ts     格式化函数
    theme.test.ts      主题注册表与无 DOM 降级
  api/           接口金标（自动 spawn wrangler dev）
    api.test.ts        会话 / 设置 / 供应商 / 技能 / 记忆 / 备份 / 导出
  helpers/
    reactText.ts   React 元素树 → 纯文本，便于断言
```

---

## 写用例的约定

1. **只测确定性行为**。不调用真实模型——所有涉及 LLM 的路径要么 mock，要么测它前后可观察的存储/接口状态。
2. **一个功能至少一条**。新功能提交时必须带上对应 `describe` 块，PR 里写清楚「这条用例守的是什么」。
3. **用例要能独立跑**。`api` 用例自己起服务、自己清理（`tests/.tmp-state` 每次重建），不依赖线上数据。
4. **断言行为而不是实现**。例如断言「分隔行不出现在表格里」，而不是「parseAlign 返回 left」。
5. **失败信息要能定位**。用 `toMatchObject` / 具体值断言，避免只断言 `toBeTruthy`。

## 接口用例的启动方式

`beforeAll` 里用 `wrangler dev --persist-to tests/.tmp-state` 起一个独立的本地实例，端口 `TEST_PORT`（默认 8797）。不读取 `.dev.vars`，密码用 `--var ACCESS_PASSWORD:` 置空，因此无需任何密钥即可跑。

## 已知未覆盖

- **真实模型调用**：需要 stub provider（pi-ai 的 `providers/faux`）才能进 CI，尚未接入。
- **浏览器交互**：目前靠手工 CDP 截图验收，未做自动化。

---

## 功能 → 用例对照

| 功能 | 用例 |
|---|---|
| Markdown 渲染 | `unit/rich.test.tsx` |
| 转录解析 / 思考块 / 文件产出 | `unit/entries.test.ts` |
| 主题切换 | `unit/theme.test.ts` |
| 会话增删改查 | `api/api.test.ts` · 会话 |
| 设置（思考档位） | `api/api.test.ts` · 设置 |
| LLM 供应商 | `api/api.test.ts` · 模型供应商 |
| 技能 | `api/api.test.ts` · 技能 |
| 记忆库 / 一键清空 | `api/api.test.ts` · 记忆库 |
| 备份 / 恢复 | `api/api.test.ts` · 备份与恢复 |
| 导出 / 版本 | `api/api.test.ts` · 导出与版本 |
| **子代理编排** | `api/api.test.ts` · 工具注册（防回归）+ `unit/entries.test.ts` · 子任务标题反解 |
| **工具注册表** | `api/api.test.ts` · 工具注册（防回归） |
| **能力注册表** | `api/api.test.ts` · 能力注册表 |
| **提示模板** | `unit/template.test.ts` + `api/api.test.ts` · 提示模板 |
| **规则文件** | `api/api.test.ts` · 规则文件 |
| **上下文压缩（提示）** | `unit/entries.test.ts` · 上下文压缩 |
| **目标模式** | `api/api.test.ts` · 目标模式 + 工具注册（防回归） |

# 内置技能

六条可以直接安装使用的技能说明书。每条一个目录，目录名与 `SKILL.md` 里的 `name` 一致。

| 名称 | 类型 | 解决什么 |
|---|---|---|
| `research-digest` | prompt | 把研报、公告或长文压成一句话结论、三条依据与风险 |
| `meeting-to-weekly` | prompt | 把会议记录整理成进展、风险、下周计划三段式周报 |
| `longform-highlights` | prompt | 从长文提炼固定五条要点，每条带原文定位句 |
| `page-to-markdown` | prompt + 工具 | 抓取网页正文，清洗成 Markdown 并写入工作台文件 |
| `kb-quick-answer` | prompt + 工具 | 先检索知识库，只用命中片段回答并标注出处 |
| `share-report` | prompt + 工具 | 把结论写成 Markdown 文件并生成公开只读链接 |

## 约定

- 六条技能的 `runtime` 都是 `prompt`：技能本身不执行代码，由模型按说明书调用内置工具。
- `tools` 声明该技能会用到哪些内置工具；没有工具依赖时写空列表。
- 后三条的差异只在说明书里：`page-to-markdown` 用 `web_fetch_page` 和 `write_file`，`kb-quick-answer` 用 `kb_search`，`share-report` 用 `write_file` 和 `share_file`。
- 需要可执行入口的技能不在这里。可执行技能要单独提供入口文件和清单，不在本批说明书的范围内。
- 目录索引和审计快照由后端任务生成，这里只放技能内容。

# ADR-0004：用户吊销与数据处置（NERE-24）

- 状态：已接受（Accepted，2026-10-22）
- 决策人：后端-bei（NERE-24）
- 关联：`docs/adr/0001-layering.md`（Route → Service → Repository → DO、跨 DO 显式协议）
- 范围：邀请用户吊销、用户 DO 数据导出/清空、会话删除级联、`/s/*` 分享失效

## 背景

旧的「吊销用户」只删注册表一行：

- 用户 DO 名固定为 `user:<id>`，注册表删除不回收其中的会话、文件、知识库与分享记录；
- `/s/<userId>.<token>` 只按 token 前缀选择 DO，不查注册表，也不校验用户是否仍存在；
- 因此被移除的用户（以及任何仍持有旧链接的人）还能继续读取分享内容，数据与费用也继续存在。

产品语义此前未定：吊销究竟是「失效访问」还是「删除数据」。本 ADR 固定默认语义，并给不可逆删除一条显式路径。

## 决策

### 1. 吊销 = 立即失效访问，默认保留数据

`DELETE /api/users?id=<userId>`：

1. 删除 `UserRegistry` 中的用户行 → 该用户的旧 cookie 在 `/api/*` 立即 401（鉴权仍按每次请求查注册表）；
2. 通过显式跨 DO 协议调用 `user:<userId>` 的 `POST /internal/revoke-user`，删除该 DO 内**全部** `shares` 行；
3. `/s/<userId>.<token>` 仍按 token 前缀路由到同一个 DO，但分享行已不存在，渲染直接 404；
4. 其余数据（会话、文件、知识库、计划、审批、记忆等）保留，响应里以 `retained` 计数如实返回。

响应示例：

```json
{
  "ok": true,
  "id": "u_ab12cd34",
  "deleted": true,
  "shares": 3,
  "retained": { "sessions": 2, "files": 5, "kbDocs": 1, "shares": 0 }
}
```

- `deleted` 表示本次是否真的删了注册表行；重复调用为 `false`。
- `shares` 是本次实际删除的分享行数；重复调用为 `0`。
- 整个操作幂等：注册表删失败时返回 502，重试会继续吊销分享。

顺序选择：先删注册表再删分享。注册表删除后，新的 `/api/*` 请求（包括并发中的创建分享）都会被 401 挡住；吊销调用紧接其后清理已存在的链接。若吊销失败，返回 502 而不是假装成功，重试即可完成剩余步骤。

### 2. 清空数据是独立的、显式二次确认的动作

`DELETE /api/users/data?id=<userId>&confirm=<userId>`：

- 仅 owner 可调用；
- `confirm` 必须等于用户 id，否则 400；
- 用户必须已从注册表删除，否则 409（先吊销，再清空）；
- 调用 `POST /internal/purge-user`：先逐文档删除知识库向量（Vectorize 中的派生数据，失败不阻塞后续步骤），再关闭 Harness → `DurableObjectStorage.deleteAll()` → 删除 alarm → 重置迁移备忘、扩展缓存与 Harness 句柄；
- 返回清空前的实际行数：`sessions/files/shares/kbDocs/kbChunks/plans/approvals/approvalGrants/questions/goals/automations/memories/skills/customTools/prompts/rules/mcpServers/providers/settings/entryKbRefs/skillAudits/skillEvents/reflectState`；
- 重复调用先把空 schema 重建再计数，全部为 0，因此幂等。

`deleteAll()` 同时清掉 pi-durable 的会话条目与 `schema_migrations`；下一次任何请求（包括旧分享链接）会重新迁移出空库，旧链接仍然 404。

### 3. 清空前可导出

`GET /api/users/export?id=<userId>`（仅 owner）返回与 `/api/backup` 同形的 JSON 备份（`version/exportedAt/data`），并带 `content-disposition` 文件名。它直接读该用户 DO 的 SQL 表，不启动 Harness。

这是 purge 前唯一的留档手段，也是本 ADR 所说的「可回滚窗口」：**导出成功到 purge 成功之间**可以重新恢复；purge 一旦执行，没有任何自动回滚，恢复只能靠 owner 自己保存的导出文件（通过现有 `/api/restore` 回到一个新的用户 DO）。

### 4. 会话删除级联

`DELETE /api/sessions?id=<sessionId>` 在标记 `deleted=1` 之前清理：

- 该会话的全部分享（`shares`，先删，链接立即 404）；
- 该会话的文件（`vfs_v2`）；
- 计划（`plans`）；
- 审批与放行许可（`approvals`、`approval_grants`）；
- 问题（`questions`）；
- 知识库命中旁路（`entry_kb_refs`）。

响应 `{ ok: true, deleted: { shares, files, plans, approvals, approvalGrants, questions, kbRefs } }`，每一步都用 `RETURNING` 取实际行数；重复删除为 0。

### 5. 跨 DO 协议与鉴权边界

- 内部端点只注册在 `internalRoutes`，不在公开路由表；
- Worker 调用时带 `x-pi-internal: 1`，用户 DO 在 `fetch` 最先校验；公开转发（`/api/*`、`/agent/*`、`/s/*`、注册表转发）都会先剥离客户端同名头；
- `/s/*` 仍保持公开、零注册表往返；用户吊销的即时性来自「DO 内先删 shares」，而不是在分享热路径查注册表。

## 风险与缓解

- **并发写入**：注册表删除后旧 token 已不能通过鉴权；极端情况下，吊销前已通过鉴权的创建分享请求可能在删 shares 之后落库。缓解：所有清理幂等，owner 重复调用即可收敛；后续如需彻底封口，可在用户 DO 写 `revoked` 标记并让 `create` 拒绝。
- **不可逆删除**：默认吊销不删数据；purge 需 `confirm=<id>`、先吊销、先导出；ADR 与接口文案都明确不可逆。
- **客户端缓存**：分享响应已有 `cache-control: no-store`，无需 CDN 失效。
- **恢复**：导出 JSON 可通过现有 `/api/restore` 合并回新的用户 DO；`shares` 不随恢复还原（沿用旧 `/restore` 语义），需要重新生成链接。

## 备选方案

1. **在 `/s/` 热路径查注册表**：实现简单，但每个分享访问多一次跨 DO 往返，违背零初始化分享路径的验收；否决。
2. **吊销即异步清空 DO**：不可逆且没有导出窗口，产品语义未确认；否决为默认，保留为显式 purge。
3. **注册表保留 `revoked` 墓碑供 `/s/` 查询**：仍需热路径查询；且分享行留在库里会继续占存储；否决。

## 回滚

- 吊销与级联清理无 schema 变更，回滚代码即可恢复旧行为（不会把已删分享/文件找回来）。
- purge 无自动回滚；回滚代码不会恢复已清空的数据。留档只能靠 purge 前调用 `/api/users/export`。

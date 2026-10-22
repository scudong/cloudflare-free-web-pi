#!/usr/bin/env bash
# 分层边界检查（ADR-0001 §9.6）：目录不存在时跳过，命中禁止模式即失败。
# 阶段 6 起 DDL 只允许在 db/migrations.ts；组合根不得残留兼容层。
set -u

fail=0
chk() {
	[ -d "$1" ] && grep -rEn "$2" "$1" --include='*.ts' && fail=1
	return 0
}
chkf() {
	[ -f "$1" ] && grep -En "$2" "$1" && fail=1
	return 0
}
chk src/worker/routes   'sqlFacade|sql\.exec\('
# 阶段 7（NERE-79）：错误只经 toResponse；禁止路由内 String(err) 与手写错误响应体。
chk src/worker/routes   'String[(]err[)]'
chk src/worker/routes   'new Response[(][[:space:]]*JSON[.]stringify[(][[:space:]]*[{][[:space:]]*error'
chk src/worker/routes   'Response[.]json[(][[:space:]]*[{][[:space:]]*(ok:[[:space:]]*false,[[:space:]]*)?error'
chk src/worker/services 'new Response|Response\.(json|redirect)|^\s*import .*routes/'
chk src/worker/repo     'new Response|Response\.(json|redirect)|from "\.\./services|from "\.\./routes'
# 阶段 6：兼容层归零（含 worker/ 下除 db 外的全部新模块；db/migrations.ts 不含这些标识符）。
chk src/worker 'ensureTables|sqlFacade|\bscope\('
# DDL 只允许在 db/migrations.ts：组合根不得出现建表/改表。
chkf src/worker.ts 'CREATE TABLE|ALTER TABLE'
# 组合根不再有 legacy 委托与隐式作用域。
chkf src/worker.ts 'handleLegacyFetch|\.legacy\(|ensureTables|sqlFacade|\bscope\('
[ "$fail" = 0 ] || { echo "分层边界检查失败"; exit 1; }

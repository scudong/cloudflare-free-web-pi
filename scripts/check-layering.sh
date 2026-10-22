#!/usr/bin/env bash
# 分层边界检查（ADR-0001 §9.6）：目录不存在时跳过，命中禁止模式即失败。
set -u

fail=0
chk() {
	[ -d "$1" ] && grep -rEn "$2" "$1" --include='*.ts' && fail=1
	return 0
}
chk src/worker/routes   'sqlFacade|sql\.exec\('
chk src/worker/services 'new Response|Response\.(json|redirect)|^\s*import .*routes/'
chk src/worker/repo     'new Response|Response\.(json|redirect)|from "\.\./services|from "\.\./routes'
[ "$fail" = 0 ] || { echo "分层边界检查失败"; exit 1; }

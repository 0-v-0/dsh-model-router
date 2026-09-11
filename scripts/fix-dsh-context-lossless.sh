#!/usr/bin/env bash
# fix-dsh-context-lossless.sh — 给 dsh-context 0.31.1 打「无损 JSON」兼容补丁（一键重打）
#
# 背景：dsh-context 0.31.1 的 contextTimeline 投影视图（buildTimelineView）无条件写入
#   model / provider / contextWindow 三个字段；新会话无请求时这些值为 undefined。
#   DSH 0.1.5 网关对转发事件（api-session/added）做无损 JSON 校验，zod strict parse 会保留
#   值为 undefined 的键 → isJsonValue 判 false → 创建会话 RPC 报
#   `gateway/internal: forwarded host event "api-session/added" argument 0 is not lossless JSON data`
#   （会话实际已创建，但前端收到错误）。
#
# 补丁内容：三个字段改为「有值才写入」（条件展开），语义不变。
# 原文件备份为 lib/index.js.orig-lossless-fix；重装/升级 dsh-context 后需重新执行本脚本。
#
# 用法：bash fix-dsh-context-lossless.sh
set -euo pipefail

F="${HOME}/.dsh/profiles/web/node_modules/dsh-context/lib/index.js"
[ -f "$F" ] || { echo "dsh-context not found at $F"; exit 1; }

# 幂等：已打过补丁直接退出
grep -q "state.model !== void 0" "$F" && { echo "already patched"; exit 0; }

cp "$F" "$F.orig-lossless-fix"
python3 - "$F" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p, encoding='utf-8').read()
old = """	const result = {
		ok: true,
		model: state.model,
		provider: state.provider,
		contextWindow: state.contextWindow,"""
new = """	const result = {
		ok: true,
		...(state.model !== void 0 ? { model: state.model } : {}),
		...(state.provider !== void 0 ? { provider: state.provider } : {}),
		...(state.contextWindow !== void 0 ? { contextWindow: state.contextWindow } : {}),"""
count = src.count(old)
assert count == 1, f"anchor count={count} — dsh-context version changed, review manually"
open(p, 'w', encoding='utf-8').write(src.replace(old, new))
print('patched:', p)
PYEOF

node --check "$F"
echo "OK — 重启 dsh 生效"

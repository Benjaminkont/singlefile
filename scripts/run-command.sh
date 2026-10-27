#!/bin/zsh
# Finder does not inherit a terminal's Homebrew PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PROJECT_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
action="$1"
shift
cd -- "$PROJECT_ROOT" || exit 1
# Let Node handle Ctrl+C, then keep the Finder terminal available for its exit message.
trap ':' INT
if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node.js。请安装 Node.js 24 或更高版本后重试。'
  result=1
else
  case "$action" in
    preview) node scripts/preview.mjs "$@" ;;
    add) node scripts/add-page.mjs "$@" --prompt ;;
    prepare) node scripts/prepare-preview.mjs "$@" ;;
    *) print '未知操作'; exit 1 ;;
  esac
  result=$?
fi
if [[ -t 0 && -t 1 ]]; then
  read -r "?按回车关闭此窗口…"
fi
exit "$result"

#!/bin/zsh
PROJECT_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
exec /bin/zsh "$PROJECT_ROOT/scripts/run-command.sh" add "$@"

#!/usr/bin/env bash
# Ставит мета-скилл gcv вместе с шаблоном и проверялкой контракта.
#   ./install.sh            → ~/.claude/skills/gcv   (глобально)
#   ./install.sh --project  → .claude/skills/gcv     (в текущий проект)
#   ./install.sh --dir PATH → произвольная папка
set -euo pipefail

SKILL="gcv"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/skills/$SKILL"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) DEST=".claude/skills/$SKILL"; shift ;;
    --dir)     DEST="${2:?--dir требует путь}/$SKILL"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

# Шаблон и проверялка обязаны лежать рядом со скиллом: SKILL.md зовёт их
# относительными путями (templates/scaffold.mjs, templates/verify-contract.mjs).
mkdir -p "$DEST"
cp "$HERE/SKILL.md" "$DEST/SKILL.md"
for d in templates reference; do
  rm -rf "${DEST:?}/$d"
  cp -r "$HERE/$d" "$DEST/$d"
done
echo "✓ скилл установлен: $DEST"

if command -v node > /dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 20 ]; then
    echo "✓ Node $(node -v)"
  else
    echo "! Node $(node -v) — нужен 20 или новее, иначе scaffold и verify-contract не запустятся"
  fi
else
  echo "! Node не найден. Нужен 20+: https://nodejs.org"
fi

echo
echo "Проверка, что каркас рабочий (ничего не публикует, ничего не тратит):"
echo "    node $DEST/templates/scaffold.mjs --service demo --name Demo --out /tmp/gcv-demo"
echo "    node $DEST/templates/verify-contract.mjs /tmp/gcv-demo"
echo
echo "Дальше в чате:  /gcv add <ссылка на документацию сервиса>"

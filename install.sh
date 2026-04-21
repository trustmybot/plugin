#!/usr/bin/env bash
# TMB Plugin installer. Drops .claude/ and bro/ template into a target project.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$PWD}"
MODE="${2:-copy}"  # copy | symlink

if [ ! -d "$TARGET" ]; then
  echo "Error: target directory $TARGET does not exist"
  exit 1
fi

echo "🤙  Installing TMB Plugin into $TARGET"
echo "    Mode: $MODE"
echo ""

install_dir() {
  local src="$1"
  local dst="$2"

  if [ -e "$dst" ]; then
    echo "  ⚠️  $dst already exists — skipping. Remove it first to reinstall."
    return
  fi

  if [ "$MODE" = "symlink" ]; then
    ln -s "$src" "$dst"
    echo "  ✓ Linked $dst → $src"
  else
    cp -R "$src" "$dst"
    echo "  ✓ Copied $dst"
  fi
}

# .claude (agents, skills, settings)
install_dir "$PLUGIN_DIR/.claude" "$TARGET/.claude"

# scripts/hooks
mkdir -p "$TARGET/scripts"
install_dir "$PLUGIN_DIR/scripts/hooks" "$TARGET/scripts/hooks"

# bro/ template — only if not already present
if [ ! -d "$TARGET/bro" ]; then
  cp -R "$PLUGIN_DIR/bro-template" "$TARGET/bro"
  mv "$TARGET/bro/GOALS.md" "$TARGET/bro/GOALS.md.example"
  touch "$TARGET/bro/GOALS.md"
  echo "  ✓ Created $TARGET/bro/ (see GOALS.md.example)"
else
  echo "  ⚠️  $TARGET/bro/ already exists — skipping template"
fi

# Make hooks executable
if [ -d "$TARGET/scripts/hooks" ]; then
  chmod +x "$TARGET/scripts/hooks"/*.sh 2>/dev/null || true
fi

echo ""
echo "  ✅ Done. Next:"
echo "     1. Write your goal in bro/GOALS.md"
echo "     2. Run: claude"
echo "     3. The Architect takes it from there"
echo ""

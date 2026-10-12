#!/usr/bin/env bash
# no_cmd_path <dir> <command> — prints the current PATH with <command> gone:
# each PATH directory holding it is replaced by <dir>/<n>, linking everything
# in it but <command>, so a hook runs as on a host without it.
no_cmd_path() {
  local out="" d n=0 shadow
  local IFS=:
  for d in $PATH; do
    [ -n "$d" ] || continue
    if [ -e "$d/$2" ]; then
      n=$((n + 1))
      shadow="$1/$n"
      mkdir -p "$shadow"
      find "$d" -mindepth 1 -maxdepth 1 ! -name "$2" -exec ln -s {} "$shadow/" \; 2>/dev/null
      d="$shadow"
    fi
    out="${out:+$out:}$d"
  done
  printf '%s\n' "$out"
}

# no_jq_path <dir> — the current PATH without jq.
no_jq_path() { no_cmd_path "$1" jq; }

#!/usr/bin/env bash
_tmb_from_node_valid() {
  case "${1:-}" in
    system) return 0 ;;
    hook:*) return 0 ;;
  esac
  return 1
}

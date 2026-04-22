#!/usr/bin/env bash
echo "install.sh is deprecated. Use the native plugin install flow:" >&2
echo "  /plugin marketplace add trustmybot/plugin" >&2
echo "  /plugin install tmb@trustmybot" >&2
echo "(Or for local dev: /plugin marketplace add --local ./plugin ; /plugin install tmb@local)" >&2
exit 1

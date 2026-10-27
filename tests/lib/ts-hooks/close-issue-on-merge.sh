#!/usr/bin/env bash
# Under TMB_HOOK_TEST_IMPL=ts an l3 suite points HOOK here. Run with bash it
# runs the TypeScript gate this file is named after; sourced it defines
# normalize_footer on that gate's normalizeFooter, as the .sh does.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  _TMB_TS_FOOTER_JS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/mcp/trajectory-server/dist/hooks/attribution-footer.js"
  normalize_footer() {
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const { normalizeFooter } = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write(normalizeFooter(readFileSync(0, "utf8"), process.env));
    ' "$_TMB_TS_FOOTER_JS"
  }
  return 0
fi
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec node "$PLUGIN_ROOT/mcp/trajectory-server/dist/hooks.js" "$(basename "${BASH_SOURCE[0]}" .sh)"

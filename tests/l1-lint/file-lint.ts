// Per-file L1 lint runner (GH 2570): runs every file-scopable L1 lint whose own scope covers each
// path given, through the same exported rule the lint's whole-tree test calls. The swe-edit-lint gate
// runs it on each edited file through .config/tmb/edit-lint.json.
//
// Usage, from the repo root:
//   node --experimental-strip-types tests/l1-lint/file-lint.ts <relpath>...
//
// Prints `<lint>: <rel>:<line>: <message>` per finding and exits 1 on any finding, else 0. Missing,
// deleted, non-regular and binary paths and paths outside the root are skipped. no-negative-directives
// is warn-only, as in its whole-tree test: its findings print with a `warn-only` prefix and never fail.

import { lintFile } from './lib/file-lints.mjs';

const root = process.cwd();
let failed = false;
for (const path of process.argv.slice(2)) {
  const { errors, warnings } = lintFile(root, path);
  for (const w of warnings) console.log(`warn-only ${w}`);
  for (const e of errors) console.log(e);
  if (errors.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);

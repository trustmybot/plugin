### Fixed
- **The no-grep-q-in-pipelines lint passes again** (GH 1894): the cheatcode-vet and heal-mcp-cache hook tests piped output into `grep -q`. Under `pipefail`, `grep -q` can exit at the first match and SIGPIPE the writer, so the pipeline could fail even when the pattern matched. Both tests now use `grep … >/dev/null` and still pass or fail on the same checks.

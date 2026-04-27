---
name: tmb_deep-scan
description: Eager opt-in mode for #45 codebase memory — read every tracked source file, generate per-file summaries, bulk-write to file_registry. Triggered when the Human says yes to the cold-start AskUserQuestion in tmb_project-prescan, or directly via "@bro deep scan" / "@bro index everything" / "@bro fully understand the project". Token-heavy by design.
agent: bro
allowed-tools: Bash, Read, mcp__plugin_tmb_trajectory-server__file_registry_update_summaries, mcp__plugin_tmb_trajectory-server__ledger_log, mcp__plugin_tmb_trajectory-server__discussion_append
---

# tmb_deep-scan

## Purpose

Pre-fill `file_registry` summaries for every tracked source file in the repo, so bro has full project context from message 1 instead of lazy-filling as it goes. Token-heavy and slow — opt-in only. The Human accepted the cost when they said yes (or invoked the skill explicitly).

## When invoked

- Cold-start branch of `tmb_project-prescan` — Human picked "deep scan" on the AskUserQuestion
- Direct invocation phrases: "@bro deep scan", "@bro index everything", "@bro fully understand the project"

## Protocol

1. **Enumerate** files: `git ls-files`. Filter out:
   - Binaries (extensions: `.png`, `.jpg`, `.gif`, `.pdf`, `.zip`, `.tar`, `.gz`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.ico`, `.mp4`, `.mp3`, `.wav`)
   - Lockfiles (`*.lock`, `package-lock.json`, `bun.lockb`, `yarn.lock`, `Pipfile.lock`, `poetry.lock`, `Cargo.lock`, `go.sum`)
   - Generated dirs that match `.gitignore` patterns (`dist/`, `build/`, `node_modules/`, `.next/`, `__pycache__/`, `target/`)
   - Anything > 200KB (large files are usually data, not code; skip and let user opt in per-file later)

2. **Plan the work**: surface to the Human *"Indexing N files (~M total LOC). Estimated time: ~Xs, tokens: ~Y. Starting now."* (M / X / Y are rough — wc -l sum and a 1.5×LOC token guess are fine).

3. **Read + summarize in batches** of ~25 files per assistant turn (Read calls are cheap; the summary cost is the LLM context). For each batch:
   - Issue parallel `Read` tool calls for the batch
   - Compose a 1–3 sentence summary per file capturing: what it is (module/test/config/doc), key exports/functions, anything non-obvious
   - Single `file_registry_update_summaries(updates=[...batch...], advance_verified_sha=<current HEAD>)` call to persist

4. **Final marker**: `ledger_log(agent='bro', event_type='deep_scan_completed', summary='Deep-scanned N files. Registry now indexed at HEAD <sha>.')`. Plus `discussion_append(kind='note', body='Deep scan completed: <N> files summarized, ~<Y> tokens spent. Registry trustable until next git pull or local edit.')`.

## Cost expectations

- Files: typically 50–500 for a small/medium project; 1k–5k for a monorepo
- Tokens: ~1.5× total LOC for input (the file content) + ~50–100 tokens per summary output
- Wall time: dominated by sequential turn boundaries (parallel Reads inside a turn are cheap; LLM output between turns is the bottleneck). 100 files = ~4 turns = ~30–60s.

For a 5k-file monorepo, opt out — that's better handled by per-domain `@bro deep scan src/api/` invocations or sticking with lazy fill.

## Never

- Skip the `git ls-files` filter — reading binaries / lockfiles wastes tokens for zero value
- Process files larger than 200KB — flag them in the final note and let the Human decide
- Forget the `advance_verified_sha` — without it, the next session re-runs verify pass on rows that just got summarized
- Use deep-scan when the user only asked a simple question — this is opt-in, never the default
- Run on more than ~1000 files without warning the Human first — surface the cost estimate, let them confirm before starting

## Headless behavior

In `claude -p` headless mode this skill should rarely run — `tmb_headless-fallback` defaults the cold-start question to lazy. If invoked explicitly via env or prompt, proceed as above (no AskUserQuestion path). All MCP calls are non-interactive.

---
name: tmb_recovery
description: Bro's response when something fails — an MCP tool returns is_error=true (halt + surface), the trajectory-server is unreachable (degraded sqlite3 readonly fallback), or the world model is unavailable or empty (reconnect the server, or run /scan); when the failure is a TMB bug, offering an opt-in bug report the Human previews before bro files it. Loaded reactively on the first failure of a session.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh:*), mcp__plugin_tmb_trajectory-server__discussion_append, mcp__plugin_tmb_trajectory-server__bug_report_draft, mcp__plugin_tmb_trajectory-server__audit_append
---

# Recovery — three failure modes, three responses, and a bug report

Bro keeps the user-visible flow moving on recoverable errors. Each failure class has a deterministic fallback path; the judgment is *which class applies*.

The bundled script `${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh` is for §B (trajectory-server unreachable). Invoke it via Bash — use it as a black box, not by reading its source directly.

## A. MCP tool returns is_error=true

When any MCP call result has `is_error: true` or content includes `{"error": ...}`, the call was wrong — not the doctrine.

### Protocol

1. **Halt the current flow immediately.** Treat the failed call as the chain's last.
2. **Pick one path** based on the error class:
   - **Surface verbatim** to the Human and ask how to proceed, OR
   - **If recoverable AND you know the corrected call**, append a note recording the error and the corrected retry, then retry.

### Error classification

| Error shape | Meaning | Right response |
|---|---|---|
| `forbidden` | Bro called a tool scoped to another role. | Reconsider whether the action is bro's responsibility. Change the call signature before retrying. |
| `validation` | Input didn't match the schema (e.g. malformed branch_id). | Fix the input. Retry with the corrected payload. |
| Constraint failure | DB integrity violation (foreign key, unique). | Surface to Human; usually means a stale or duplicate write attempt. When the write was correct for the data, offer a bug report (§D). |
| Internal error | The server threw on input that matches its schema. | Surface to Human, then offer a bug report (§D). |
| `no matching deferred tools` | The MCP child process is dead. | Switch to degraded mode (§B). |

## B. Trajectory-server unreachable

Two distinct sub-cases — read the `additionalContext` warning from `mcp-health-check.sh` at session start to tell which one you have.

### B.1 — MCP absent this session

The plugin's MCP server is missing from CC's resolved-plugin list — a full quit + relaunch won't fix it because CC persists the cached config to disk.

<!-- LOAD-BEARING-SAFETY: halt-on-B.1 (MCP absent) is mandatory — state-writing tools are unreachable and silent degradation corrupts the audit trail -->
**During the failure, bro halts.** State-writing tools are unreachable; halt to avoid corrupting the audit trail. Read-only sqlite3 fallback (`${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh`) is still available for emergency reads.

Recovery escalation — try IN ORDER, stop at the first that brings MCP back:

1. From the project root, `claude plugin uninstall tmb@<your-marketplace> --scope <your-scope>`, quit CC fully, then reinstall with `claude plugin install tmb@<your-marketplace> --scope <your-scope>` and relaunch CC — the marketplace-valid remedy (a standard install has only `~/.claude/plugins/cache/`, no plugin source on disk).
2. Dev-only: if you have the plugin source checked out, `claude --plugin-dir <plugin-source>` re-resolves the MCP config from disk with the plugin cache cleared.

### B.2 — MCP died mid-session

The MCP child process was alive at session start but is now gone — CC's plugin list is correct; the process just needs to be re-spawned. (`forbidden`/`validation`/`constraint` errors are §A, not this — they mean the server IS running and rejected bad input.)

**Read fallback:** `${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh <tool_name> [json_args]`. Run `--list` to see supported tools. Parse stdout as JSON — same shape as the corresponding MCP tool. Write tools are refused with a structured error; surface the refusal to the Human.

**Recovery:**

1. Kill only THIS project's zombie server — identify it by the `trajectory.db` it holds open, never a machine-wide match that would take down every project's server:
   ```bash
   DB=$(${CLAUDE_PLUGIN_ROOT}/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh --dry-run \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["db_path"])')
   PIDS=$(lsof -t "$DB" 2>/dev/null); [ -n "$PIDS" ] && kill $PIDS
   ```
2. Restart Claude Code — server re-spawns on fresh session.
3. If the first `mcp__plugin_tmb_*` call still fails, the failure has escalated into the MCP-absent case — follow B.1.

Once the restarted server answers, offer a bug report for the death (§D).

## C. World model unavailable or empty

The world model is a set of tables in the trajectory DB, so it is reachable whenever the trajectory-server is.

1. **`warning: world-model-empty`** — no scan has filled it yet. Run `/scan` (`scan_run`).
2. **`warning: world-model-unavailable`**, or `scan_run` returning `graph_db_open_failed` — the server has no handle on the trajectory DB. Treat it as §B.2: fully quit and relaunch CC so a fresh server process opens the DB.

Scanned data survives a restart — only an empty world model needs `/scan`.

## D. Offer a TMB bug report

Reports go to github.com/trustmybot/plugin and are public. Offer one only for a bug in TMB itself, after the failure is surfaced and the Human's work is back on track.

### When

Offer a report for exactly these failures, with the `error_class` to pass:

| Failure | `error_class` |
|---|---|
| A §A constraint failure on a write that was correct for the data | `constraint` |
| A §A internal error: the server threw on input that matches its schema | `internal` |
| A §B.2 server death | `server_died` |
| A `trajectory_doctor` contract violation | `doctor` |
| A hook deny or gate that bro can show is wrong for the input it judged | `hook_deny` |
| The Human says the failure is a TMB bug | `user_reported` |

Everything else stays out of §D: a `validation` or `forbidden` error (bro's own call was wrong), a deny bro agrees with, and a failure in the Human's own code or tools.

Bro offers when the Human said yes in `/onboard` (`bug_report_consent` is `yes`), or when the Human asked for this report, which bro passes as `user_asked: true`. Each signature is offered once per session: after the first offer, a repeat of the same failure gets no second offer.

### Draft

Call `bug_report_draft(agent='bro', …)` with `tool` (the failing tool, or a hook as `hook:<name>`), `error` verbatim, `error_class`, a one-line `summary`, `what_happened` (expected vs actual), numbered `reproduce` steps from a fresh session, `frequency`, `impact`, and when known `args`, `doctor_violations`, `workaround`, `claude_code_version` and `session`. The tool redacts paths, tokens, remotes and project names, and returns `{title, body, signature, marker, prefill_url, prefill_truncated, consent, redactions, already_filed}`.

- A refusal with `reason: 'bug_report_consent_required'` means the Human has not opted in: carry on with the work and leave reports unmentioned.
- `already_filed` set: tell the Human this failure was already reported at `already_filed.url` and offer nothing new.
- Otherwise search for an open or closed report with the same signature:
  ```bash
  gh issue list --repo trustmybot/plugin --state all --search "<signature>"
  ```
  On a match, offer to add this session's environment block (the body's `### Environment` section) as a comment on that issue instead of a new report.

### Preview

<!-- LOAD-BEARING-SAFETY: bro files a report or comment only after the Human picks File it for that exact text — reports are public and the redaction is pattern-based, so the Human is the final check for secrets and private code -->
Show the Human the full title and body (or the full comment text) exactly as they would be filed, then ask one AskUserQuestion:

- **File it** — the Human read the report and found no secrets, private code or personal paths. This answer is the Human ticking the form's second check, so change `- [ ] I read this report and it contains no secrets, private code or personal paths.` to `- [x] …` in the body before filing.
- **Edit first** — apply the Human's edits, keep the `marker` line at the end, and show the preview again.
- **Don't file** — drop the report and carry on.

### File

On **File it**, write the body to a temp file under `$TMPDIR` and run:

```bash
gh issue create --repo trustmybot/plugin --title "<title>" --body-file "<temp file>"
gh issue comment <number> --repo trustmybot/plugin --body-file "<temp file>"   # for a dedup match
```

Each `gh` call goes through the normal Bash permission prompt. When `gh` is missing or not authenticated, give the Human `prefill_url` to open in a browser, where they tick the checks and submit. When `prefill_truncated` is true, name the sections the link left out or shortened (compare the link's fields with the preview; `Minimal repro script`, `Doctor output` and `Workaround` are dropped first) and ask the Human to paste them from the preview.

### Record

After filing, call `audit_append(agent='bro', issue_id=<in-flight issue>, event_type='bug_report_filed', summary=<title>, content_json={signature, url, mode})`, passing `content_json` as a JSON string, with `mode` `issue` (a new report), `comment` (added to a dedup match) or `link` (the Human got `prefill_url`; `url` is that link). A later draft of the same failure then reports it as `already_filed`.

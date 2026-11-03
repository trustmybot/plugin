/**
 * PostToolUse(Bash) hook (GH 1692), the port of
 * scripts/hooks/close-issue-on-merge.sh: after a successful `gh pr merge` /
 * `glab mr merge` statement (heredoc bodies and quoted text never match), one
 * transaction closes the merged head branch's live tasks and their open
 * agent_runs, writes review_gate_bypassed for each of its tasks with no
 * passing review and no recorded skip, and closes each issue the PR names by
 * an explicit closing ref when no other task of it is live (else
 * issue_auto_close_deferred). Each closed issue's remote twin is then closed
 * while the sync gate is on; with it off, issue_auto_close_remote_skipped is
 * written instead. gh runs with the .sh's arguments, bounded to 10 s.
 *
 * Advisory: it prints nothing on stdout and always exits 0. Bypasses:
 * TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1, and TMB_DISABLE_REMOTE_SYNC for the
 * remote close. Unlike the .sh it needs neither jq nor the sqlite3 CLI, so it
 * records the merge where the .sh skipped it (decision 703).
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { GATE_SKIP_RECORDED_SQL, HAS_PASS_SQL } from '../review-sql.js';
import { stripLiterals } from './cmd-analysis/strip-literals.js';
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { auditSql, dbWrite, nowIso, type AuditRow } from './lib/audit.js';
import { dbPath, haveSqlite, sqliteRo, sqlInt, sqlQuote } from './lib/db.js';
import { gitOut } from './lib/git.js';
import { commandOnPath } from './lib/host.js';
import { jqFieldOr, jqIndex, jqLiteralNumbers, jqMap } from './lib/jq.js';
import { mergeFailed, readMergePayload } from './lib/merge.js';
import { commandSubstitution, jqRawText } from './lib/project-env.js';
import { forgeCommandDir, forgeRepoDir } from './lib/repo.js';
import { RUN_UNMEASURED_SQL } from './swe-spawn-rollback.js';

export const GATE_NAME = 'close-issue-on-merge';

const FROM = 'hook:close-issue-on-merge';
const LIVE = "'pending','running','needs_validation','completed'";
const GH_TIMEOUT_MS = 10_000;
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time']);
const VALUE_FLAGS = new Set([
  '-t',
  '--subject',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-A',
  '--author-email',
  '--match-head-commit',
  '-m',
  '--message',
  '--sha',
  '-R',
  '--repo',
]);
const CLOSING_REF = /(close[sd]?|fix(e[sd])?|resolve[sd]?)[ \t\v\f\r]+(GH[ \t\v\f\r]+)?#[0-9]+/gi;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** _cim_gh: `gh <args> 2>/dev/null` in <repoDir>, bounded to 10 s, its stdout as a `$(...)` capture holds it. */
function gh(args: readonly string[], repoDir: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync('gh', args, {
    cwd: repoDir,
    encoding: 'utf8',
    env,
    timeout: GH_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return commandSubstitution(r.stdout ?? '');
}

/**
 * _cim_merge_args: the words after `merge` of the first statement running
 * `gh pr merge` / `glab mr merge` (past VAR=value assignments and
 * sudo/env/command/nohup/time), or null when no statement does.
 */
export function mergeArgs(cmd: string): string[] | null {
  const stripped = commandSubstitution(stripLiterals(cmd));
  for (const line of stripped.split('\n')) {
    for (const stmt of line.split(/&&|\|\||[;|&()]/)) {
      const words = stmt.split(/[ \t\n]+/).filter((w) => w !== '');
      let i = 0;
      while (i < words.length && (WRAPPERS.has(words[i]) || /^[A-Za-z_].*=/s.test(words[i]))) i += 1;
      if (words.length - i < 3) continue;
      const tool = `${words[i]} ${words[i + 1]}`;
      if ((tool === 'gh pr' || tool === 'glab mr') && words[i + 2] === 'merge') return words.slice(i + 3);
    }
  }
  return null;
}

/** _cim_ref_from_args: the first merge argument that is no flag, flag value or redirection. */
export function refFromArgs(args: readonly string[]): string {
  let skip = false;
  for (const tok of args) {
    if (tok === '') continue;
    if (skip) {
      skip = false;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      skip = true;
      continue;
    }
    if (tok.startsWith('-') || /[<>]/.test(tok)) continue;
    return tok;
  }
  return '';
}

/** sort -un over decimal lines: ascending by value, the first of equal values kept. */
function sortUniqueNumeric(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = BigInt(v).toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.sort((a, b) => {
    const d = BigInt(a) - BigInt(b);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  });
}

/** _cim_closing_refs: closingIssuesReferences[].number plus each `Closes|Fixes|Resolves (GH )#<n>` of the body. */
export function closingRefs(json: string): string[] {
  if (json === '') return [];
  const refs = jqMap(
    json,
    (v) => {
      const out: string[] = [];
      const list = jqIndex(v, 'closingIssuesReferences');
      const items = Array.isArray(list) ? list : list !== null && typeof list === 'object' ? Object.values(list) : [];
      for (const item of items) {
        let n: unknown;
        try {
          n = jqIndex(item, 'number');
        } catch {
          break;
        }
        if (n !== null && n !== undefined && n !== false) out.push(jqRawText(n));
      }
      return out;
    },
    jqLiteralNumbers,
  ).flat();
  const body = commandSubstitution(jqFieldOr(json, 'body'));
  const bodyRefs: string[] = [];
  for (const line of body.split('\n')) {
    for (const m of line.matchAll(CLOSING_REF)) bodyRefs.push(/#([0-9]+)/.exec(m[0])?.[1] ?? '');
  }
  const lines = [...commandSubstitution(refs.join('\n')).split('\n'), ...bodyRefs];
  return sortUniqueNumeric(lines.filter((l) => /^[0-9]+$/.test(l)));
}

class Merge {
  private sql: string[] = [];
  private readonly closedIds: string[] = [];

  constructor(
    private readonly db: string,
    private readonly head: string,
    private readonly syncOn: boolean,
    private readonly repoDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private read(sql: string): string {
    return sqliteRo(this.db, sql, this.env);
  }

  private audit(row: Omit<AuditRow, 'fromNode'>): string | null {
    const r = auditSql({ ...row, fromNode: FROM }, '', {
      caller: GATE_NAME,
      env: this.env,
    });
    if (r.code === 0) return r.sql;
    if (r.error !== '') process.stderr.write(`${r.error}\n`);
    return null;
  }

  /** _cim_tasks_sql: a bypass row per unreviewed task of the branch, its open runs and live tasks closed. */
  private tasksSql(): string {
    const branch = sqlQuote(this.head);
    const now = sqlQuote(nowIso());
    const out: string[] = [];
    const rows = this.read(`SELECT t.id || '|' || t.issue_id || '|' || COALESCE(t.commit_sha, '') FROM tasks t
     WHERE t.branch_id = '${branch}' AND t.status IN (${LIVE}, 'closed')
       AND NOT ${HAS_PASS_SQL} AND NOT ${GATE_SKIP_RECORDED_SQL} ORDER BY t.id;`);
    for (const row of rows.split('\n')) {
      if (row === '') continue;
      const [tidRaw, rest = ''] = splitOnce(row);
      const [issueRaw, sha = ''] = splitOnce(rest);
      const tid = sqlInt(tidRaw);
      const issue = sqlInt(issueRaw);
      const shaJson = sha === '' || /[^0-9a-f]/.test(sha) ? 'null' : `"${sha}"`;
      if (tid === '' || issue === '') continue;
      const audit = this.audit({
        issueId: issue,
        branchId: this.head,
        eventType: 'review_gate_bypassed',
        summary: `Task ${tid} merged without a passing review`,
        contentJson: `{"task_id":${tid},"commit_sha":${shaJson},"closed_by":"close-issue-on-merge"}`,
      });
      if (audit !== null) out.push(audit);
    }
    out.push(`UPDATE agent_runs
       SET completed_at = '${now}',
           duration_ms = CASE WHEN duration_ms = 0
             THEN COALESCE(CAST(ROUND((julianday('${now}') - julianday(started_at)) * 86400000) AS INTEGER), duration_ms)
             ELSE duration_ms END,
           exit_reason = 'completed',
           ${RUN_UNMEASURED_SQL}
     WHERE completed_at IS NULL
       AND task_id IN (SELECT id FROM tasks WHERE branch_id = '${branch}' AND status IN (${LIVE}, 'closed'));
    UPDATE tasks
       SET status = 'closed', completed_at = COALESCE(completed_at, '${now}'), updated_at = '${now}'
     WHERE branch_id = '${branch}' AND status IN (${LIVE});`);
    return out.join('\n');
  }

  /** _cim_local_issue: the issues.id a closing ref names: by gh_iid first, else as an id. */
  private localIssue(ref: string): string {
    const n = sqlInt(ref);
    if (n === '') return '';
    const byGh = sqlInt(this.read(`SELECT id FROM issues WHERE gh_iid = ${n};`));
    if (byGh !== '') return byGh;
    return sqlInt(this.read(`SELECT id FROM issues WHERE id = ${n};`));
  }

  /** _cim_issue_sql: close an open issue, or defer it over live tasks off the merged branch. */
  private issueSql(localId: string): string {
    const id = sqlInt(localId);
    if (id === '') return '';
    const branch = sqlQuote(this.head);
    if (this.read(`SELECT status FROM issues WHERE id = ${id};`) !== 'open') return '';
    const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
    const ghJson = ghIid === '' ? 'null' : ghIid;
    const blocking = this.read(`SELECT id FROM tasks WHERE issue_id = ${id}
      AND status IN (${LIVE}) AND branch_id != '${branch}' ORDER BY id;`);
    if (blocking !== '') {
      const ids = blocking
        .split('\n')
        .filter((l) => /^[0-9]+$/.test(l))
        .join(',');
      return (
        this.audit({
          issueId: id,
          branchId: '',
          eventType: 'issue_auto_close_deferred',
          summary: `Merge left issue ${id} open: tasks ${ids} still live`,
          contentJson: `{"blocking_task_ids":[${ids}],"gh_iid":${ghJson}}`,
        }) ?? ''
      );
    }
    const now = sqlQuote(nowIso());
    const out = [
      `UPDATE issues SET status = 'closed', closed_at = COALESCE(closed_at, '${now}'), updated_at = '${now}'
     WHERE id = ${id} AND status != 'closed';`,
    ];
    const closed = this.audit({
      issueId: id,
      branchId: '',
      eventType: 'issue_auto_closed_on_merge',
      summary: 'Auto-closed on PR merge',
      contentJson: `{"gh_iid":${ghJson}}`,
    });
    if (closed === null) return out.join('\n');
    out.push(closed);
    if (ghIid !== '' && !this.syncOn) {
      const skipped = this.audit({
        issueId: id,
        branchId: '',
        eventType: 'issue_auto_close_remote_skipped',
        summary: `Remote close of gh #${ghIid} skipped: issue sync is off`,
        contentJson: `{"gh_iid":${ghIid},"reason":"sync_gate_off"}`,
      });
      if (skipped !== null) out.push(skipped);
    }
    return out.join('\n');
  }

  build(prJson: string): string {
    if (this.head !== '') this.sql.push(this.tasksSql());
    for (const ref of closingRefs(prJson)) {
      const localId = this.localIssue(ref);
      if (localId === '') continue;
      const issueSql = this.issueSql(localId);
      if (issueSql === '') continue;
      this.sql.push(issueSql);
      if (issueSql.includes('issue_auto_closed_on_merge')) this.closedIds.push(localId);
    }
    return this.sql.join('\n');
  }

  /** After the commit: each closed issue's note, then its remote close while the sync gate is on. */
  closeRemotes(): void {
    for (const raw of this.closedIds) {
      const id = sqlInt(raw);
      if (id === '') continue;
      process.stderr.write(`tmb: auto-closed issue ${id} on merge\n`);
      if (!this.syncOn) continue;
      const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
      if (ghIid === '') continue;
      if (gh(['issue', 'view', ghIid, '--json', 'state', '-q', '.state'], this.repoDir, this.env) !== 'CLOSED') {
        gh(['issue', 'close', ghIid], this.repoDir, this.env);
      }
    }
  }
}

function splitOnce(text: string): [string, string] {
  const bar = text.indexOf('|');
  return bar < 0 ? [text, text] : [text.slice(0, bar), text.slice(bar + 1)];
}

/** _cim_sync_on: TMB_DISABLE_REMOTE_SYNC unset or false, and plugin_config.issue_sync set and not off. */
export function syncOn(db: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!['', '0', 'false', 'FALSE', 'False'].includes(env.TMB_DISABLE_REMOTE_SYNC ?? '')) return false;
  const mode = sqliteRo(
    db,
    `
    SELECT json_extract(value_json, '$')
      FROM plugin_config
     WHERE key = 'issue_sync';
  `,
    env,
  );
  return mode !== '' && mode !== 'off';
}

async function close(payload: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { input, toolName, command: cmd, response } = readMergePayload(payload);
  if (toolName !== 'Bash' || cmd === '') return;
  const args = mergeArgs(cmd);
  if (args === null || mergeFailed(response)) return;
  if (!commandOnPath('gh', env)) return;

  const db = dbPath(env);
  if (db === null || !isFile(db) || !haveSqlite(env)) return;

  let ref = refFromArgs(commandSubstitution(args.join('\n')).split('\n'));
  if (ref === '') ref = await gitOut(forgeCommandDir(cmd, input, env), ['rev-parse', '--abbrev-ref', 'HEAD'], env);
  if (ref === '' || ref === 'HEAD') return;

  const repoDir = await forgeRepoDir(cmd, input, env);
  const prJson = gh(['pr', 'view', ref, '--json', 'closingIssuesReferences,body,headRefName'], repoDir, env);
  let head = commandSubstitution(jqFieldOr(prJson, 'headRefName'));
  if (head === '' && /[^0-9]/.test(ref) && !ref.includes('://')) head = ref;

  const merge = new Merge(db, head, syncOn(db, env), repoDir, env);
  const sql = merge.build(prJson);
  if (sql === '') return;
  const w = dbWrite(db, sql, { caller: GATE_NAME, env });
  if (!w.ok) {
    process.stderr.write(`${w.error}\n`);
    return;
  }
  merge.closeRemotes();
}

export const closeIssueOnMerge: Gate = async (payload, env): Promise<GateResult> => {
  if ((env.TMB_DISABLE_CLOSE_ISSUE_ON_MERGE ?? '0') === '1') return ALLOW;
  try {
    await close(payload, env);
  } catch {
    /* advisory: every path exits 0 */
  }
  return ALLOW;
};

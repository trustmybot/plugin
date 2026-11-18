/**
 * PostToolUse(Bash) hook (GH 1692): after a successful `gh pr merge` /
 * `glab mr merge` statement (heredoc bodies and quoted text never match), one
 * transaction closes the merged head branch's live tasks and their open
 * agent_runs, writes review_gate_bypassed for each of its tasks with no
 * passing review and no recorded skip (a task closed under workflow_mode
 * 'agile' is queued instead and one closed under 'exempt' owes no review, so
 * neither gets one), and closes each issue the PR names by
 * an explicit closing ref when no other task of it is live (else
 * issue_auto_close_deferred). Each closed issue's remote twin is then closed
 * while the sync gate is on; with it off, issue_auto_close_remote_skipped is
 * written instead. A named issue a task close already closed locally gets only
 * that remote close, or that skipped row (GH 3115). gh runs bounded to 10 s.
 *
 * Advisory: it prints nothing on stdout and always exits 0. Bypasses:
 * TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1, and TMB_DISABLE_REMOTE_SYNC for the
 * remote close. It needs neither jq nor the sqlite3 CLI.
 *
 * recordMerge is the one writer of those closes: close-forge-merged runs it
 * for a PR merged on the forge, outside any Bash call.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { GATE_SKIP_RECORDED_SQL, HAS_PASS_SQL } from '../review-sql.js';
import { storedReviewOwedSql } from '../stored-mode.js';
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
import { sqlText, taskStatusMoveSql } from '../task-status.js';
import { DONE, ISSUE_STATE, LIVE, sqlList, unionOf } from '../task-states.js';

export const GATE_NAME = 'close-issue-on-merge';

const FROM = 'hook:close-issue-on-merge';
const LIVE_SQL = sqlList(LIVE);
const LIVE_OR_DONE_SQL = sqlList(unionOf(LIVE, DONE));
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
  private readonly remoteOnlyIds: string[] = [];

  constructor(
    private readonly db: string,
    private readonly head: string,
    private readonly syncOn: boolean,
    private readonly repoDir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly closedBy: string,
  ) {}

  private read(sql: string): string {
    return sqliteRo(this.db, sql, this.env);
  }

  private audit(row: Omit<AuditRow, 'fromNode'>): string | null {
    const r = auditSql({ ...row, fromNode: FROM }, '', {
      caller: this.closedBy,
      env: this.env,
    });
    if (r.code === 0) return r.sql;
    if (r.error !== '') process.stderr.write(`${r.error}\n`);
    return null;
  }

  /**
   * _cim_tasks_sql: a bypass row per unreviewed task of the branch, its open runs and live tasks closed.
   * A task closed under workflow_mode 'agile' is already queued for the grouped
   * review, and one closed under 'exempt' owes none, so neither gets a bypass row.
   */
  private tasksSql(): string {
    const branch = sqlQuote(this.head);
    const stamp = nowIso();
    const now = sqlQuote(stamp);
    const out: string[] = [];
    const rows = this.read(`SELECT t.id || '|' || t.issue_id || '|' || COALESCE(t.commit_sha, '') FROM tasks t
     WHERE t.branch_id = '${branch}' AND t.status IN (${LIVE_OR_DONE_SQL})
       AND ${storedReviewOwedSql('t')}
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
        contentJson: `{"task_id":${tid},"commit_sha":${shaJson},"closed_by":"${this.closedBy}"}`,
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
       AND task_id IN (SELECT id FROM tasks WHERE branch_id = '${branch}' AND status IN (${LIVE_OR_DONE_SQL}));
    ${taskStatusMoveSql({
      status: 'closed',
      event: 'merged_outside_flow',
      cause: 'merged_outside_flow',
      role: 'hook',
      record: { kind: 'task', id: sqlText('tasks.id') },
      key: `close-issue-on-merge:${this.head}:${stamp}`,
      at: stamp,
      set: { completed_at: sqlText(`COALESCE(completed_at, '${now}')`), updated_at: stamp },
      where: `branch_id = '${branch}' AND status IN (${LIVE_SQL})`,
    })};`);
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
    if (this.read(`SELECT status FROM issues WHERE id = ${id};`) !== ISSUE_STATE.open) return '';
    const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
    const ghJson = ghIid === '' ? 'null' : ghIid;
    const blocking = this.read(`SELECT id FROM tasks WHERE issue_id = ${id}
      AND status IN (${LIVE_SQL}) AND branch_id != '${branch}' ORDER BY id;`);
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
      `UPDATE issues SET status = '${ISSUE_STATE.closed}', closed_at = COALESCE(closed_at, '${now}'), updated_at = '${now}'
     WHERE id = ${id} AND status != '${ISSUE_STATE.closed}';`,
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
      const skipped = this.remoteSkippedAudit(id, ghIid);
      if (skipped !== null) out.push(skipped);
    }
    return out.join('\n');
  }

  private remoteSkippedAudit(id: string, ghIid: string): string | null {
    return this.audit({
      issueId: id,
      branchId: '',
      eventType: 'issue_auto_close_remote_skipped',
      summary: `Remote close of gh #${ghIid} skipped: issue sync is off`,
      contentJson: `{"gh_iid":${ghIid},"reason":"sync_gate_off"}`,
    });
  }

  /**
   * An issue a task close already closed locally (GH 3115): its remote twin
   * stayed open for this merge, so it joins the remote closes while the sync
   * gate is on, else gets the skipped row. No UPDATE and no second close row.
   */
  private alreadyClosedSql(localId: string): string {
    const id = sqlInt(localId);
    if (id === '') return '';
    const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
    if (ghIid === '') return '';
    if (this.syncOn) {
      this.remoteOnlyIds.push(id);
      return '';
    }
    return this.remoteSkippedAudit(id, ghIid) ?? '';
  }

  build(prJson: string): string {
    if (this.head !== '') this.sql.push(this.tasksSql());
    for (const ref of closingRefs(prJson)) {
      const localId = this.localIssue(ref);
      if (localId === '') continue;
      if (this.read(`SELECT status FROM issues WHERE id = ${localId};`) === ISSUE_STATE.closed) {
        const remoteSql = this.alreadyClosedSql(localId);
        if (remoteSql !== '') this.sql.push(remoteSql);
        continue;
      }
      const issueSql = this.issueSql(localId);
      if (issueSql === '') continue;
      this.sql.push(issueSql);
      if (issueSql.includes('issue_auto_closed_on_merge')) this.closedIds.push(localId);
    }
    return this.sql.join('\n');
  }

  /** After the commit: each closed issue's note, then its remote close while the sync gate is on; then each already-closed issue's remote close. */
  closeRemotes(): void {
    for (const raw of this.closedIds) {
      const id = sqlInt(raw);
      if (id === '') continue;
      process.stderr.write(`tmb: auto-closed issue ${id} on merge\n`);
      if (this.syncOn) this.closeRemote(id);
    }
    for (const id of this.remoteOnlyIds) this.closeRemote(id);
  }

  private closeRemote(id: string): void {
    const ghIid = sqlInt(this.read(`SELECT gh_iid FROM issues WHERE id = ${id};`));
    if (ghIid === '') return;
    if (gh(['issue', 'view', ghIid, '--json', 'state', '-q', '.state'], this.repoDir, this.env) !== 'CLOSED') {
      gh(['issue', 'close', ghIid], this.repoDir, this.env);
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

  recordMerge({ db, head, prJson, repoDir, env, closedBy: GATE_NAME });
}

export interface MergeRecord {
  db: string;
  /** The merged head branch; "" closes only the issues <prJson> names. */
  head: string;
  /** The PR's JSON, with at least its body and closingIssuesReferences. */
  prJson: string;
  /** The checkout gh runs in for the remote issue closes. */
  repoDir: string;
  env: NodeJS.ProcessEnv;
  /** The gate recording the merge: the bypass rows' closed_by and the error label. */
  closedBy: string;
}

/**
 * One merged PR's closes, shared by every gate that sees a merge: one
 * transaction closes the head branch's live tasks with their bypass rows and
 * the issues the PR names, then the remote issue closes run. False when the
 * write failed, its error on stderr.
 */
export function recordMerge(pr: MergeRecord): boolean {
  const merge = new Merge(pr.db, pr.head, syncOn(pr.db, pr.env), pr.repoDir, pr.env, pr.closedBy);
  const sql = merge.build(pr.prJson);
  if (sql !== '') {
    const w = dbWrite(pr.db, sql, { caller: pr.closedBy, env: pr.env });
    if (!w.ok) {
      process.stderr.write(`${w.error}\n`);
      return false;
    }
  }
  merge.closeRemotes();
  return true;
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

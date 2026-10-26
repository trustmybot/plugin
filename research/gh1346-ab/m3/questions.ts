import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { query } from '../lib/snapshot.ts';

export type Match = 'exact' | 'set' | 'list' | 'contains';

export interface M3Question {
  id: string;
  kind: 'single' | 'cross' | 'code';
  text: string;
  format: string;
  match: Match;
  truth: string;
}

function one(sql: string): string {
  return query<{ v: string | number | null }>(sql).map((r) => String(r.v)).join(',');
}

function files(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(root, p, out);
    else if (p.endsWith('.ts')) out.push(relative(root, p));
  }
  return out;
}

function grepFiles(root: string, under: string, re: RegExp): string[] {
  return files(root, join(root, under))
    .filter((f) => re.test(readFileSync(join(root, f), 'utf8')))
    .sort();
}

/**
 * Bro/swe-style lookups. Truth is computed at run time from the same snapshot and source export
 * both arms read, so a rerun on a newer snapshot stays self-consistent.
 */
export function m3Questions(srcRoot: string): M3Question[] {
  const tools = 'mcp/trajectory-server/src/tools';
  const q: M3Question[] = [
    {
      id: 'task176-sha-status',
      kind: 'single',
      text: 'What are the status and the first 8 characters of the commit_sha of task 176?',
      format: 'status,sha8',
      match: 'list',
      truth: one(`select status||','||substr(commit_sha,1,8) v from tasks where id=176`),
    },
    {
      id: 'task31-fails-last',
      kind: 'single',
      text: 'How many times did task 31 fail code review (validation verdict "fail"), and what is the verdict of its latest validation attempt?',
      format: 'fail_count,latest_verdict',
      match: 'list',
      truth: one(`select (select count(*) from validation_attempts where task_id=31 and verdict='fail')||','||(select verdict from validation_attempts where task_id=31 order by attempt_n desc, id desc limit 1) v`),
    },
    {
      id: 'issue53-task-counts',
      kind: 'single',
      text: 'Issue 53 (local id): how many tasks does it have in total, and how many of them have status "failed"?',
      format: 'total,failed',
      match: 'list',
      truth: one(`select count(*)||','||sum(status='failed') v from tasks where issue_id=53`),
    },
    {
      id: 'task182-swe-cache',
      kind: 'single',
      text: 'Task 182: what is the sum of cache_read_tokens over its swe agent runs only (exclude code-reviewer runs)?',
      format: 'integer',
      match: 'exact',
      truth: one(`select sum(cache_read_tokens) v from agent_runs where task_id=182 and agent_type='swe'`),
    },
    {
      id: 'issue55-bro-decisions',
      kind: 'single',
      text: 'On issue 55 (local id), how many discussion entries of kind "decision" were authored by bro?',
      format: 'integer',
      match: 'exact',
      truth: one(`select count(*) v from discussions where issue_id=55 and kind='decision' and author='bro'`),
    },
    {
      id: 'issue136-verif-pass',
      kind: 'single',
      text: 'How many audit events of type bro_verification_pass does issue 136 (local id) have, and what is the branch_id on the most recent one?',
      format: 'count,branch_id',
      match: 'list',
      truth: one(`select (select count(*) from audit where issue_id=136 and event_type='bro_verification_pass')||','||(select branch_id from audit where issue_id=136 and event_type='bro_verification_pass' order by created_at desc, id desc limit 1) v`),
    },
    {
      id: 'issue187-gh',
      kind: 'single',
      text: 'Which GitHub issue number does local issue 187 map to, and what milestone is it in?',
      format: 'gh_number,milestone',
      match: 'list',
      truth: one(`select gh_iid||','||coalesce(milestone,'none') v from issues where id=187`),
    },
    {
      id: 'task180-pass-run',
      kind: 'single',
      text: "Task 180: for its passing validation attempt, what are the exit_code and the first 8 characters of the commit_sha of the verification run attached to it?",
      format: 'exit_code,sha8',
      match: 'list',
      truth: one(`select vr.exit_code||','||substr(vr.commit_sha,1,8) v from validation_attempts va join verification_runs vr on vr.task_id=va.task_id and vr.started_at<=va.created_at where va.task_id=180 and va.verdict='pass' order by vr.started_at desc, vr.id desc limit 1`),
    },
    {
      id: 'review-fail-3x',
      kind: 'cross',
      text: 'Which tasks failed code review three or more times (validation verdict "fail")? Give each with its issue.',
      format: 'comma-separated task_id:issue_id pairs',
      match: 'set',
      truth: one(`select va.task_id||':'||t.issue_id v from validation_attempts va join tasks t on t.id=va.task_id group by va.task_id having sum(va.verdict='fail')>=3 order by va.task_id`),
    },
    {
      id: 'open-issues-no-tasks',
      kind: 'cross',
      text: 'How many open issues have no tasks at all?',
      format: 'integer',
      match: 'exact',
      truth: one(`select count(*) v from issues i where status='open' and not exists (select 1 from tasks t where t.issue_id=i.id)`),
    },
    {
      id: 'max-cache-task',
      kind: 'cross',
      text: 'Which task has the largest total cache_read_tokens summed over all its agent runs (swe and code-reviewer)?',
      format: 'task_id',
      match: 'exact',
      truth: one(`select task_id v from agent_runs where task_id is not null group by task_id order by sum(cache_read_tokens) desc limit 1`),
    },
    {
      id: 'most-reviewed',
      kind: 'cross',
      text: 'Which task or tasks have the most code-reviewer agent runs? List all tied tasks.',
      format: 'comma-separated task ids',
      match: 'set',
      truth: one(`with c as (select task_id, count(*) n from agent_runs where agent_type='code-reviewer' and task_id is not null group by task_id) select task_id v from c where n=(select max(n) from c) order by task_id`),
    },
    {
      id: 'hook-denied-issue',
      kind: 'cross',
      text: 'Among real issues (positive local ids), which issue has the most hook_denied audit events, and how many?',
      format: 'issue_id,count',
      match: 'list',
      truth: one(`select issue_id||','||count(*) v from audit where event_type='hook_denied' and issue_id>0 group by issue_id order by count(*) desc limit 1`),
    },
    {
      id: 'latest-fail',
      kind: 'cross',
      text: 'What is the most recent failing code-review verdict in the project? Give its task id and that task\'s issue id.',
      format: 'task_id,issue_id',
      match: 'list',
      truth: one(`select va.task_id||','||t.issue_id v from validation_attempts va join tasks t on t.id=va.task_id where verdict='fail' order by va.created_at desc limit 1`),
    },
    {
      id: 'high-prio-open',
      kind: 'cross',
      text: 'How many open issues in milestone v1.2.0 carry the label "Priority: High"?',
      format: 'integer',
      match: 'exact',
      truth: one(`select count(*) v from issues where status='open' and milestone='v1.2.0' and labels like '%"Priority: High"%'`),
    },
    {
      id: 'failed-tasks',
      kind: 'cross',
      text: 'List the ids of all tasks whose status is "failed".',
      format: 'comma-separated task ids',
      match: 'set',
      truth: one(`select id v from tasks where status='failed' order by id`),
    },
    {
      id: 'swe-effort-medium',
      kind: 'cross',
      text: 'How many swe agent runs (not code-reviewer, not bro) ran at effort "medium"?',
      format: 'integer',
      match: 'exact',
      truth: one(`select count(*) v from agent_runs where agent_type='swe' and effort='medium'`),
    },
    {
      id: 'db-path-env',
      kind: 'code',
      text: 'In the trajectory-server source, which file defines resolveClaudeDbPath, and which environment variable overrides the DB path?',
      format: 'repo-relative file path,ENV_VAR',
      match: 'contains',
      truth: 'mcp/trajectory-server/src/platform.ts,TRAJECTORY_DB_PATH',
    },
    {
      id: 'write-path-guard',
      kind: 'code',
      text: 'Where does the write-path guard live (the writePaths function that works out which paths a Bash command writes), and which non-test source file calls it?',
      format: 'defining file path,calling file path',
      match: 'contains',
      truth: ['mcp/trajectory-server/src/hooks/cmd-analysis/index.ts', ...grepFiles(srcRoot, 'mcp/trajectory-server/src', /import \{[^}]*\bwritePaths\b/).filter((f) => !f.includes('cmd-analysis/'))].join(','),
    },
    {
      id: 'worktree-b-hook',
      kind: 'code',
      text: 'Which hook script blocks `git worktree add -b` (creating a branch while adding a worktree)?',
      format: 'repo-relative file path',
      match: 'contains',
      truth: 'scripts/hooks/no-worktree-branch-create.sh',
    },
    {
      id: 'require-roles',
      kind: 'code',
      text: 'Which file defines requireRoles, and how many .ts files directly under mcp/trajectory-server/src/tools (not tests) reference it?',
      format: 'file path,count',
      match: 'contains',
      truth: `mcp/trajectory-server/src/middleware/agent-scope.ts,${grepFiles(srcRoot, tools, /\brequireRoles\b/).filter((f) => !f.slice(tools.length + 1).includes('/')).length}`,
    },
    {
      id: 'v51-migration',
      kind: 'code',
      text: 'Which source file holds the v50→v51 schema migration that renames pr-reviewer to code-reviewer, and which GitHub issue does it cite?',
      format: 'file path,GH number',
      match: 'contains',
      truth: 'mcp/trajectory-server/src/db.ts,1641',
    },
  ];
  return q;
}

function norm(s: string): string {
  return s.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/^\.\//, '').trim().toLowerCase();
}

export function scoreM3(q: M3Question, answer: string): boolean {
  const parts = (x: string): string[] => x.split(/\s*,\s*/).map(norm).filter(Boolean);
  const a = norm(answer);
  switch (q.match) {
    case 'exact':
      return a.replace(/[,_\s]/g, '') === norm(q.truth).replace(/[,_\s]/g, '');
    case 'list':
      return parts(a).join(',') === parts(q.truth).join(',');
    case 'set':
      return [...new Set(parts(a))].sort().join(',') === [...new Set(parts(q.truth))].sort().join(',');
    case 'contains':
      return parts(q.truth).every((t) => (/^\d+$/.test(t) ? parts(a).includes(t) || new RegExp(`\\b${t}\\b`).test(a) : a.includes(t)));
  }
}

#!/usr/bin/env node
// The code-reviewer eval (GH 1955): first-pass rate, mean cycles to pass,
// wontfix rate, SZZ-traced escaped bugs, known-clean tasks, and the same per
// reviewer arm (model, effort). Opens the DB read-only.
//   --db <path>         the trajectory DB (default: the one the server resolves
//                       for this workspace — TRAJECTORY_DB_PATH, else the walk
//                       up from CLAUDE_PROJECT_DIR or the cwd)
//   --repo <dir>        the git checkout the fix commits are traced in
//                       (default: cwd)
//   --repo-name <name>  the repos.name the bugs and traced tasks belong to
//                       (default: the basename of the directory holding the
//                       checkout's git common dir, so a worktree resolves to
//                       its main checkout)
//   --base <ref>        the branch the fix commits are read from
//                       (default: origin/dev)
//   --json              one JSON object instead of key=value lines
// Needs the built server (mcp/trajectory-server/dist). Exits 2 on bad usage, a
// missing DB or a git failure.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import {
  defaultRepoName,
  formatReviewerEval,
  GitError,
  gitRunner,
  reviewerEval,
} from '../../mcp/trajectory-server/dist/reviewer-eval.js';
import { resolveClaudeDbPath } from '../../mcp/trajectory-server/dist/platform.js';

function fail(message: string): never {
  process.stderr.write(`reviewer-eval: ${message}\n`);
  process.exit(2);
}

let values: { db?: string; repo?: string; 'repo-name'?: string; base?: string; json?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      'repo-name': { type: 'string' },
      base: { type: 'string' },
      json: { type: 'boolean' },
    },
  }));
} catch (e) {
  fail((e as Error).message);
}

const dbPath = values.db ?? resolveClaudeDbPath();
if (!existsSync(dbPath)) fail(`no trajectory DB at ${dbPath}`);

const raw = new DatabaseSync(dbPath, { readOnly: true });
const reader = {
  get: <T>(sql: string, params: unknown[] = []): T | undefined => raw.prepare(sql).get(...(params as never[])) as T | undefined,
  all: <T>(sql: string, params: unknown[] = []): T[] => raw.prepare(sql).all(...(params as never[])) as T[],
};

try {
  const git = gitRunner(values.repo ?? process.cwd());
  const repoName = values['repo-name'] ?? defaultRepoName(git);
  const report = reviewerEval(reader, git, { base: values.base ?? 'origin/dev', repoName });
  process.stdout.write(values.json ? JSON.stringify(report) + '\n' : formatReviewerEval(report));
} catch (e) {
  if (e instanceof GitError) fail(e.message);
  throw e;
} finally {
  raw.close();
}

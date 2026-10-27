/**
 * SessionStart hook (GH 1692, #171), the port of scripts/hooks/ensure-gitignore.sh:
 * the .gitignore of the project's git repo and of every registered repos
 * row's repo lists `.claude/`, created or appended to when it does not, with
 * one stderr line per file it changed. No stdout; it never denies.
 *
 * Divergence: the .sh reads the repos table only with the sqlite3 CLI on
 * PATH; this gate reads it through node:sqlite as well.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ALLOW, type SyncGate } from './gate.js';
import { dbPath, haveSqlite, projectRoot, repoPathAbs, sqliteRo } from './lib/db.js';
import { gitRun, isDir } from './lib/git.js';

export const GATE_NAME = 'ensure-gitignore';

const RULE = '# TMB plugin runtime state — never commit\n.claude/\n';
const IGNORED = /^\.claude(\/\*?)?$/;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `grep -qE '^\.claude(/\*?)?$' <file>`. */
export function listsClaudeDir(text: string): boolean {
  return text.split('\n').some((line) => IGNORED.test(line));
}

function alreadyIgnored(gitignore: string): boolean {
  if (!isFile(gitignore)) return false;
  try {
    return listsClaudeDir(readFileSync(gitignore, 'latin1'));
  } catch {
    return false;
  }
}

function ensureIgnored(root: string): void {
  const gitignore = `${root}/.gitignore`;
  if (alreadyIgnored(gitignore)) return;
  try {
    if (isFile(gitignore)) appendFileSync(gitignore, `\n${RULE}`);
    else writeFileSync(gitignore, RULE);
  } catch {
    /* the .sh's redirection fails and it notes the file all the same */
  }
  process.stderr.write(`tmb: ensured .claude/ is in ${gitignore}\n`);
}

/** The project dir and each registered repos.path, as absolute dirs. */
export function candidateDirs(env: NodeJS.ProcessEnv): string[] {
  const project = projectRoot(env);
  if (project === '') return [];
  const dirs = [project];
  const db = dbPath(env) ?? '';
  if (db !== '' && isFile(db) && haveSqlite(env)) {
    for (const p of sqliteRo(db, "SELECT path FROM repos WHERE path IS NOT NULL AND path <> '';", env).split('\n')) {
      if (p !== '') dirs.push(repoPathAbs(db, p));
    }
  }
  return dirs;
}

export const ensureGitignore: SyncGate = (_payload, env) => {
  const seen = new Set<string>();
  for (const d of candidateDirs(env)) {
    if (!isDir(d)) continue;
    const r = gitRun(d, ['rev-parse', '--show-toplevel'], env);
    if (r.code !== 0) continue;
    const root = r.stdout.replace(/\n+$/, '');
    if (root === '' || seen.has(root)) continue;
    seen.add(root);
    ensureIgnored(root);
  }
  return ALLOW;
};

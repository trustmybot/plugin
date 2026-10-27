/**
 * SessionStart hook (GH 1692), the port of scripts/hooks/substrate-preflight.sh:
 * a TMB DEGRADED banner naming each of jq, sqlite3, git and node missing from
 * PATH, and, when jq and sqlite3 are on PATH as the .sh needs them to look,
 * the offline note for a project repo with no remote URL. It never denies.
 */
import { ALLOW, type SyncGate } from './gate.js';
import { dbPath, projectRoot } from './lib/db.js';
import { commandOnPath } from './lib/host.js';
import { jsonValues } from './lib/jq.js';
import { repoGitRoot, repoRemotes } from './lib/repo.js';

export const GATE_NAME = 'substrate-preflight';

export const PROBES: readonly (readonly [string, string])[] = [
  ['jq', 'most PreToolUse gates and the bro/swe doctrine hooks are inoperative'],
  ['sqlite3', 'task/spawn gates cannot verify state'],
  ['git', 'branch guards and commit-message lint are inoperative'],
  ['node', 'MCP trajectory-server and scan tooling cannot start'],
];

export const OFFLINE_NOTE = 'TMB: operating locally — no remote configured; remote/push ops are skipped.';

/** `jq -r '[.[]|select(.url!=null and .url!="")]|length>0'` == "false" for every value printed. */
export function noRemoteUrl(remotesJson: string): boolean {
  const out: string[] = [];
  for (const value of jsonValues(remotesJson)) {
    let items: unknown[];
    if (Array.isArray(value)) items = value;
    else if (value !== null && typeof value === 'object') items = Object.values(value);
    else continue;
    let has = false;
    let failed = false;
    for (const item of items) {
      if (item === null) continue;
      if (typeof item !== 'object' || Array.isArray(item)) {
        failed = true;
        break;
      }
      const url = (item as Record<string, unknown>).url;
      if (url !== undefined && url !== null && url !== '') has = true;
    }
    if (!failed) out.push(String(has));
  }
  return out.join('\n') === 'false';
}

function offlineNote(env: NodeJS.ProcessEnv): string {
  if (!commandOnPath('sqlite3', env) || !commandOnPath('jq', env)) return '';
  const db = dbPath(env);
  if (db === null || db === '') return '';
  const remotes = repoRemotes(db, repoGitRoot(projectRoot(env), env), env);
  return remotes !== '' && noRemoteUrl(remotes) ? OFFLINE_NOTE : '';
}

export const substratePreflight: SyncGate = (_payload, env) => {
  const missing = PROBES.filter(([bin]) => !commandOnPath(bin, env)).map(([bin, why]) => `missing ${bin} — ${why}`);
  const offline = offlineNote(env);
  if (missing.length === 0 && offline === '') return ALLOW;
  const parts = [];
  if (missing.length > 0) parts.push(`TMB DEGRADED: ${missing.join('; ')}. Install the missing tools to restore enforcement.`);
  if (offline !== '') parts.push(offline);
  const escaped = parts.join(' ').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return { stdout: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${escaped}"}}\n`, code: 0 };
};

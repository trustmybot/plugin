/**
 * SessionStart hook (GH 1692), the port of scripts/hooks/plugin-hooks-marker.sh:
 * writes <state_dir>/sessions/<session_id>.plugin-hooks, the proof that this
 * session loaded the plugin's hooks, pruning such markers over 24 h old. It
 * writes only into an existing state dir and prints nothing. Unlike the .sh,
 * which exits without jq, it reads the payload itself (decision 703).
 */
import { mkdirSync, statSync } from 'node:fs';
import { ALLOW, type GateResult } from './gate.js';
import { dbPath } from './lib/db.js';
import { jqAlternatives } from './lib/jq.js';
import { pruneStaleMarkers, touchEmpty } from './lib/persona.js';
import { commandSubstitution, pluginName, posixDirname, TMB_STATE_HOST_DIR } from './lib/project-env.js';

export const GATE_NAME = 'plugin-hooks-marker';
const SUFFIX = '.plugin-hooks';

/** The session_id of a hook payload, "" when missing or not a safe file name. */
export function safeSessionId(input: string): string {
  const sid = commandSubstitution(jqAlternatives(commandSubstitution(input), [['session_id']]));
  return sid === '' || sid.includes('/') || sid.startsWith('.') ? '' : sid;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function pluginHooksMarker(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    const sessionId = safeSessionId(payload);
    if (sessionId === '') return ALLOW;
    let stateDir: string;
    if (env.CLAUDE_PROJECT_DIR) {
      stateDir = `${env.CLAUDE_PROJECT_DIR}/${TMB_STATE_HOST_DIR}/${pluginName(env)}`;
    } else {
      const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
      if (db === null) return ALLOW;
      stateDir = posixDirname(db);
    }
    if (!isDir(stateDir)) return ALLOW;
    const sessions = `${stateDir}/sessions`;
    try {
      mkdirSync(sessions, { recursive: true });
    } catch {
      return ALLOW;
    }
    pruneStaleMarkers(sessions, (name) => name.endsWith(SUFFIX));
    touchEmpty(`${sessions}/${sessionId}${SUFFIX}`);
  } catch {
    /* a marker never fails its hook */
  }
  return ALLOW;
}

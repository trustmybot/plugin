/**
 * TypeScript port of scripts/hooks/lib/persona.sh (GH 1692), shared by
 * session-start-persona and user-prompt-persona, which deliver bro's persona:
 * Claude Code never loads a plugin's CLAUDE.md, so the hooks inject
 * $CLAUDE_PLUGIN_ROOT/CLAUDE.md as context. As the .sh does, it falls back to
 * raw text and a sed-style parse when jq is not on PATH, writes only the
 * per-session marker <project>/.claude/<plugin>/sessions/<session_id>.persona
 * and never touches the project's CLAUDE.md.
 */
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './db.js';
import { jqAlternatives, jqCompact } from './jq.js';
import { commandSubstitution, installRoot, pluginName, posixDirname, shellPwd, TMB_STATE_HOST_DIR } from './project-env.js';

const STALE_MINUTES = 1440;
const OLD_BLOCK = '<!-- tmb:persona start';
const OLD_BLOCK_NOTE =
  "[The project's CLAUDE.md still holds a <!-- tmb:persona --> block from an older /onboard. It is no longer needed, since this hook delivers the persona; tell the Human they may delete it.]";
const NO_ROOT = 'unresolved (no CLAUDE_PROJECT_DIR and no trajectory DB)';

export interface Persona {
  haveJq: boolean;
  pluginRoot: string;
  source: string;
  project: string;
  pluginName: string;
  pluginVersion: string;
}

/** `command -v <name>`: an executable regular file in a PATH dir. */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(':')) {
    const candidate = `${dir === '' ? '.' : dir}/${name}`;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      /* next dir */
    }
  }
  return false;
}

/** `cd <dir> && pwd -P`, "" when the cd fails. */
function physicalDir(dir: string): string {
  if (dir === '') return '';
  const abs = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  try {
    if (!statSync(abs).isDirectory()) return '';
    accessSync(abs, constants.X_OK);
    return realpathSync.native(abs);
  } catch {
    return '';
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sedField(text: string, key: string): string {
  const re = new RegExp(`^[\\s\\S]*"${key}"[ \\t\\v\\f\\r]*:[ \\t\\v\\f\\r]*"([^"]*)"[\\s\\S]*$`);
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return '';
}

/** persona_manifest_field <key>: a top-level string of .claude-plugin/plugin.json. */
function manifestField(root: string, key: string, haveJq: boolean): string {
  const manifest = `${root}/.claude-plugin/plugin.json`;
  if (!isFile(manifest)) return '';
  let text: string;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch {
    return '';
  }
  return commandSubstitution(haveJq ? jqAlternatives(text, [[key]]) : sedField(text, key));
}

function defaultPluginRoot(): string {
  try {
    return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? '';
  } catch {
    return '';
  }
}

/**
 * persona_init: the plugin root, persona source, project and plugin
 * name/version; null when the project root is the plugin root (Claude Code
 * loads that CLAUDE.md itself) or the plugin root does not resolve.
 */
export function personaInit(env: NodeJS.ProcessEnv = process.env, haveJq = commandOnPath('jq', env)): Persona | null {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT || defaultPluginRoot();
  if (pluginRoot === '') return null;
  let project = env.CLAUDE_PROJECT_DIR || shellPwd(env);
  const projectReal = physicalDir(project);
  const pluginReal = physicalDir(pluginRoot);
  if (pluginReal !== '' && projectReal === pluginReal) return null;
  if (projectReal !== '') project = projectReal;
  const version = manifestField(pluginRoot, 'version', haveJq);
  const name = manifestField(pluginRoot, 'name', haveJq) || (haveJq ? pluginName(env) : 'tmb');
  return { haveJq, pluginRoot, source: `${pluginRoot}/CLAUDE.md`, project, pluginName: name, pluginVersion: version };
}

/** persona_session_id <payload>: the payload's session_id, "" when missing or not a safe file name. */
export function personaSessionId(input: string, haveJq: boolean): string {
  const sid = commandSubstitution(haveJq ? jqAlternatives(input, [['session_id']]) : sedField(input, 'session_id'));
  return sid === '' || sid.includes('/') || sid.startsWith('.') ? '' : sid;
}

/** persona_marker <session_id> <suffix>. */
export function personaMarker(p: Persona, sessionId: string, suffix: string): string {
  return `${p.project}/${TMB_STATE_HOST_DIR}/${p.pluginName}/sessions/${sessionId}.${suffix}`;
}

/**
 * `find <dir> -maxdepth 1 -type f -name <glob> -mmin +1440 -delete`: removes
 * the regular files <matches> accepts that are over 24 h old.
 */
export function pruneStaleMarkers(dir: string, matches: (name: string) => boolean, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const path = `${dir}/${name}`;
    try {
      const st = lstatSync(path);
      if (st.isFile() && now - st.mtimeMs > STALE_MINUTES * 60_000) unlinkSync(path);
    } catch {
      /* as find -delete: skipped */
    }
  }
}

/** `: > <path>`: creates or truncates <path>, ignoring a failure. */
export function touchEmpty(path: string): void {
  try {
    writeFileSync(path, '');
  } catch {
    /* as the .sh: ignored */
  }
}

/** persona_mark <session_id> <suffix>: writes the marker, pruning *.persona* markers over 24 h old. */
export function personaMark(p: Persona, sessionId: string, suffix: string): void {
  if (sessionId === '') return;
  try {
    if (!statSync(p.project).isDirectory()) return;
  } catch {
    return;
  }
  const marker = personaMarker(p, sessionId, suffix);
  const dir = posixDirname(marker);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  pruneStaleMarkers(dir, (name) => name.includes('.persona'));
  touchEmpty(marker);
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function holdsOldBlock(claudeMd: string): boolean {
  if (!isFile(claudeMd)) return false;
  try {
    return readFileSync(claudeMd).includes(OLD_BLOCK);
  } catch {
    return false;
  }
}

/**
 * persona_context: the header line, the old-block note when the project's
 * CLAUDE.md still holds a tmb:persona block, the project root line and the
 * plugin's CLAUDE.md; null when that file cannot be read or is empty.
 */
export function personaContext(p: Persona, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!readable(p.source)) return null;
  let body: string;
  try {
    body = commandSubstitution(readFileSync(p.source, 'utf8'));
  } catch {
    return null;
  }
  if (body === '') return null;
  const lines = [`[Persona loaded by the TMB persona hook from the ${p.pluginName} plugin's CLAUDE.md, v${p.pluginVersion || 'unknown'}]`];
  if (holdsOldBlock(`${p.project}/CLAUDE.md`)) lines.push(OLD_BLOCK_NOTE);
  lines.push(`Project root (<project> in TMB prompts): ${projectRoot(env) || NO_ROOT}`);
  return `${lines.join('\n')}\n\n${body}`;
}

/** persona_emit <hook_event_name> <context>: hookSpecificOutput JSON, or the raw text when jq is missing. */
export function personaEmit(p: Persona, event: string, context: string): string {
  if (!p.haveJq) return `${context}\n`;
  return `${jqCompact({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`;
}

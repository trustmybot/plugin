// Headless sandbox network probe (GH 1252, GH 1549).
//
// Measures which of TMB's remote commands still work under Claude Code's Bash
// sandbox, in two settings.local.json setups:
//   A — the filesystem-only block /onboard wrote before GH 1252
//   B — the block /onboard writes today, produced by writeProjectSandbox in the
//       committed dist (allow-list, cache env, macOS trust-service access)
// Each setup runs one `claude -p --model haiku` session in a fresh temp project
// (git init'd, origin = https://github.com/trustmybot/plugin.git) that runs
// every probe command in its own Bash call. Exit codes are read from the
// session's tool results, not from the model's prose. A Bash call that set
// dangerouslyDisableSandbox is reported as `unsandboxed`, never as a pass.
// The `host` column runs the same commands outside Claude Code as a control:
// a B row counts as failed only when the same command passes on the host.
//
// Usage: node --experimental-strip-types tests/l5-l6/probes/sandbox-network-probe.ts [--keep] [--check-recorded]
//   --check-recorded  exit 1 only when a B failure is not in this platform's
//                     SANDBOX_NETWORK_PROBES entry's failed (all count when the
//                     platform has no entry)
// Needs claude, git, gh, npm, bun, node. Auth: CLAUDE_CODE_OAUTH_TOKEN or
// ANTHROPIC_API_KEY in the environment, else the plugin checkout's .env.
// The push is `--dry-run`: it updates no ref.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasCommand } from '../../../scripts/lib/await-release-gate.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SANDBOX_MODULE = join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'dist', 'tools', 'onboard-sandbox.js');
const ORIGIN_URL = 'https://github.com/trustmybot/plugin.git';
const CMD_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 600_000;
const TIMEOUT_EXIT = 124;
const TOOLS = ['claude', 'git', 'gh', 'npm', 'bun', 'node'];

export const COMMANDS: readonly string[] = [
  'gh api repos/trustmybot/plugin --jq .name',
  'git ls-remote origin HEAD',
  'git push --dry-run origin HEAD:refs/heads/tmb-probe-noop',
  'npm view is-number version',
  'bun add is-number',
];

/** Per command: its exit code as text, or `unsandboxed`, `not-run`, `no-exit`. */
export type CommandStatus = string;

export interface RecordedProbe {
  readonly failed?: readonly string[];
}

export interface ProbeArgs {
  keep: boolean;
  checkRecorded: boolean;
}

export function parseArgs(argv: readonly string[]): ProbeArgs | { unknown: string } {
  const args: ProbeArgs = { keep: false, checkRecorded: false };
  for (const arg of argv) {
    if (arg === '--keep') args.keep = true;
    else if (arg === '--check-recorded') args.checkRecorded = true;
    else return { unknown: arg };
  }
  return args;
}

export function probeMarker(index: number): string {
  return `TMB_PROBE_${index}_EXIT`;
}

export function promptFor(commands: readonly string[] = COMMANDS): string {
  const lines = [
    'You are a network probe. Run each command below with the Bash tool, one Bash call per command, in order, exactly as written (the text between the backticks, verbatim). Do not retry, do not change a command, and never set dangerouslyDisableSandbox. After the last one, print one line per command: RESULT <n> <exit code>.',
  ];
  commands.forEach((c, i) => lines.push(`${i + 1}. \`${c}; echo "${probeMarker(i + 1)}=$?"\``));
  return `${lines.join('\n')}\n`;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function contentItems(event: unknown, type: string): Json[] {
  if (!isObject(event) || event['type'] !== type || !isObject(event['message'])) return [];
  const content = event['message']['content'];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function resultText(content: unknown): string {
  if (Array.isArray(content)) return content.map((c) => (isObject(c) && typeof c['text'] === 'string' ? c['text'] : '')).join('\n');
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** Parses a stream-json transcript (one JSON event per line), skipping lines that are not JSON. */
export function parseEvents(jsonl: string): unknown[] {
  const events: unknown[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

/** Per command, from the session's Bash tool uses and tool results. */
export function commandStatuses(events: readonly unknown[], count: number = COMMANDS.length): CommandStatus[] {
  const uses = events.flatMap((e) => contentItems(e, 'assistant')).filter((c) => c['type'] === 'tool_use');
  const results = events.flatMap((e) => contentItems(e, 'user')).filter((c) => c['type'] === 'tool_result');
  const statuses: CommandStatus[] = [];
  for (let i = 1; i <= count; i++) {
    const marker = probeMarker(i);
    const use = uses
      .filter((u) => u['name'] === 'Bash' && isObject(u['input']) && typeof u['input']['command'] === 'string' && u['input']['command'].includes(marker))
      .at(-1);
    if (use === undefined) {
      statuses.push('not-run');
      continue;
    }
    const id = use['id'];
    const sameId = uses.filter((u) => u['id'] === id).at(-1) ?? use;
    if (isObject(sameId['input']) && sameId['input']['dangerouslyDisableSandbox'] === true) {
      statuses.push('unsandboxed');
      continue;
    }
    const text = results
      .filter((r) => r['tool_use_id'] === id)
      .map((r) => resultText(r['content']))
      .join('\n');
    const code = [...text.matchAll(new RegExp(`${marker}=([0-9]*)`, 'g'))].at(-1)?.[1] ?? '';
    statuses.push(code === '' ? 'no-exit' : code);
  }
  return statuses;
}

/** The setup-B commands that failed while passing on the host. */
export function bFailures(host: readonly CommandStatus[], b: readonly CommandStatus[], commands: readonly string[] = COMMANDS): string[] {
  return commands.filter((_, i) => b[i] !== '0' && host[i] === '0');
}

/** The B failures not in the recorded probe's failed (every one when there is no entry). */
export function regressions(failed: readonly string[], recorded: RecordedProbe | null | undefined): string[] {
  const known = new Set(recorded?.failed ?? []);
  return failed.filter((c) => !known.has(c));
}

export function cell(status: CommandStatus): string {
  return status === '0' ? 'pass' : `FAIL (${status})`;
}

export function reportTable(host: readonly CommandStatus[], a: readonly CommandStatus[], b: readonly CommandStatus[], commands: readonly string[] = COMMANDS): string[] {
  const lines = ['| Command | host | A: filesystem only | B: /onboard\'s block |', '|---|---|---|---|'];
  commands.forEach((c, i) => {
    let bCell = cell(b[i] ?? '');
    if (b[i] !== '0' && host[i] !== '0') bCell += ', not counted: host fails';
    lines.push(`| \`${c}\` | ${cell(host[i] ?? '')} | ${cell(a[i] ?? '')} | ${bCell} |`);
  });
  return lines;
}

function fail(message: string): never {
  throw new ProbeExit(2, `sandbox-network-probe: ${message}`);
}

class ProbeExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    const [, name, raw] = m ?? [];
    if (name === undefined || raw === undefined) continue;
    let value = raw.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out[name] = value;
  }
  return out;
}

function loadAuth(): void {
  if ((process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '') + (process.env.ANTHROPIC_API_KEY ?? '') !== '') return;
  const common = spawnSync('git', ['-C', PLUGIN_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const commonDir = common.status === 0 ? common.stdout.trim().replace(/\/\.git$/, '') : '';
  for (const envFile of [join(PLUGIN_ROOT, '.env'), `${commonDir}/.env`]) {
    if (!existsSync(envFile)) continue;
    Object.assign(process.env, parseDotEnv(readFileSync(envFile, 'utf8')));
    return;
  }
}

function git(dir: string, args: readonly string[]): void {
  spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

/** A temp project that is its own git repo: in a non-repo dir git walks up. */
function makeProject(dir: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.email', 'probe@tmb.invalid']);
  git(dir, ['config', 'user.name', 'TMB probe']);
  git(dir, ['remote', 'add', 'origin', ORIGIN_URL]);
  writeFileSync(join(dir, 'README.md'), 'probe\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-qm', 'probe']);
}

function cacheDir(): string {
  return process.env.TMB_MODEL_CACHE_DIR || process.env.HF_HOME || join(homedir(), '.cache', 'huggingface');
}

interface SandboxModule {
  writeProjectSandbox(opts: { projectRoot: string; remoteUrls: readonly string[]; previous: null }): { written: boolean; reason?: string };
  SANDBOX_NETWORK_PROBES: Readonly<Record<string, RecordedProbe | undefined>>;
}

let sandboxModule: SandboxModule | null = null;

async function loadSandboxModule(): Promise<SandboxModule> {
  sandboxModule ??= (await import(pathToFileURL(SANDBOX_MODULE).href)) as SandboxModule;
  return sandboxModule;
}

/** B is what /onboard writes on yes: writeProjectSandbox from the committed dist, logging into the temp project. */
async function writeSetup(dir: string, setup: 'A' | 'B'): Promise<void> {
  if (setup === 'A') {
    writeFileSync(join(dir, '.claude', 'settings.local.json'), `${JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: [dir, cacheDir()] } } }, null, 2)}\n`);
    return;
  }
  const saved = process.env.TRAJECTORY_DB_PATH;
  process.env.TRAJECTORY_DB_PATH = join(dir, '.claude', 'tmb', 'trajectory.db');
  try {
    const { writeProjectSandbox } = await loadSandboxModule();
    const r = writeProjectSandbox({ projectRoot: dir, remoteUrls: [ORIGIN_URL], previous: null });
    if (!r.written) fail(`could not write setup B (writeProjectSandbox: ${r.reason})`);
  } catch (err) {
    if (err instanceof ProbeExit) throw err;
    fail(`could not write setup B (${(err as Error).message})`);
  } finally {
    if (saved === undefined) delete process.env.TRAJECTORY_DB_PATH;
    else process.env.TRAJECTORY_DB_PATH = saved;
  }
}

function exitStatus(r: ReturnType<typeof spawnSync>): CommandStatus {
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return String(TIMEOUT_EXIT);
  if (r.status === null) return String(r.signal === 'SIGTERM' ? TIMEOUT_EXIT : 128);
  return String(r.status);
}

async function runSetup(work: string, setup: 'A' | 'B'): Promise<CommandStatus[]> {
  const dir = join(work, setup);
  makeProject(dir);
  await writeSetup(dir, setup);
  const transcript = join(work, `${setup}.jsonl`);
  const out = openSync(transcript, 'w');
  const err = openSync(join(work, `${setup}.stderr`), 'w');
  try {
    spawnSync(
      'claude',
      [
        '-p', '--model', 'haiku',
        '--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence',
        '--allowedTools', 'Bash', '--permission-mode', 'dontAsk',
        '--output-format', 'stream-json', '--verbose', promptFor(),
      ],
      { cwd: dir, stdio: ['ignore', out, err], timeout: SESSION_TIMEOUT_MS },
    );
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const statuses = commandStatuses(parseEvents(readFileSync(transcript, 'utf8')));
  writeFileSync(join(work, `${setup}.result`), `${statuses.join('\n')}\n`);
  return statuses;
}

function runHost(work: string): CommandStatus[] {
  const dir = join(work, 'host');
  makeProject(dir);
  const statuses = COMMANDS.map((c) => exitStatus(spawnSync('bash', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: CMD_TIMEOUT_MS })));
  writeFileSync(join(work, 'host.result'), `${statuses.join('\n')}\n`);
  return statuses;
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function probe(args: ProbeArgs, work: string): Promise<number> {
  const host = runHost(work);
  const a = await runSetup(work, 'A');
  const b = await runSetup(work, 'B');

  const platform = process.platform;
  const version = spawnSync('claude', ['--version'], { cwd: work, encoding: 'utf8' }).stdout?.trim().split(/\s+/)[0] ?? '';
  const out = [`Claude Code ${version}, ${platform}, ${localDate()}`, '', ...reportTable(host, a, b), ''];
  const failed = bFailures(host, b);
  out.push(`platform: ${platform}`, `B failed: ${JSON.stringify(failed)}`);
  out.push(failed.length === 0 ? 'B: every command that passes on the host passed' : 'B: at least one command failed');

  if (!args.checkRecorded) {
    process.stdout.write(`${out.join('\n')}\n`);
    return failed.length === 0 ? 0 : 1;
  }
  let recorded: RecordedProbe | null;
  try {
    recorded = (await loadSandboxModule()).SANDBOX_NETWORK_PROBES[platform] ?? null;
  } catch {
    process.stdout.write(`${out.join('\n')}\n`);
    fail('cannot read SANDBOX_NETWORK_PROBES');
  }
  const regressed = regressions(failed, recorded);
  out.push(`recorded (${platform}): ${JSON.stringify(recorded)}`);
  out.push(
    regressed.length === 0
      ? `B: no regression against SANDBOX_NETWORK_PROBES.${platform}`
      : `B: regressed against SANDBOX_NETWORK_PROBES.${platform}: ${JSON.stringify(regressed)}`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
  return regressed.length === 0 ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if ('unknown' in args) {
    process.stderr.write(`sandbox-network-probe: unknown argument ${args.unknown}\n`);
    return 2;
  }
  if (!existsSync(SANDBOX_MODULE)) {
    process.stderr.write(`sandbox-network-probe: ${SANDBOX_MODULE} missing (build dist)\n`);
    return 2;
  }
  for (const tool of TOOLS) {
    if (!hasCommand(tool)) {
      process.stderr.write(`sandbox-network-probe: ${tool} not on PATH\n`);
      return 2;
    }
  }
  loadAuth();

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-sandbox-net-probe.')));
  try {
    return await probe(args, work);
  } catch (err) {
    if (!(err instanceof ProbeExit)) throw err;
    process.stderr.write(`${err.message}\n`);
    return err.code;
  } finally {
    if (args.keep) process.stderr.write(`kept: ${work}\n`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

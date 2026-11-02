// cheatcode_install's engine: installs one approved cheatcode through the marketplace path (or a fixture) and reports what was wired.
import {
  alt,
  CheatcodeInputError,
  findOnPath,
  fixturePath,
  get,
  isObject,
  normalizeCandidate,
  parseJson,
  rawText,
  readFixture,
  requireProjectRoot,
  runCli,
  type CandidateInput,
  type CheatcodeRunOptions,
  type Json,
  type NormalizedCandidate,
} from './cheatcode-runtime.js';

export type CheatcodeScope = 'local' | 'global';

export interface InstallAttachment {
  target: string;
  artifact: string;
}

export interface InstallOutput {
  candidate: NormalizedCandidate;
  installed: Json;
  version: Json;
  scope: CheatcodeScope;
  method: string;
  attachments: InstallAttachment[];
  proposed_pr: Record<string, string> | null;
  error: Json;
}

interface InstallResult {
  installed: Json;
  version: Json;
  error: Json;
  attachments?: Json;
}

export const INSTALL_FIXTURE_ENV = 'TMB_CHEATCODE_INSTALL_FIXTURE';
export const INSTALL_FIXTURE_FILE = '.tmb-cheatcode-install-fixture.json';
export const INSTALLABLE_KINDS = new Set(['skill', 'mcp', 'plugin']);

// The candidate's name, kind and source_url as the shell read them, with the kind and source_url checks.
export function installableCandidate(input: CandidateInput): { candidate: NormalizedCandidate; name: string; kind: string; url: string } {
  const candidate = normalizeCandidate(input, '');
  const name = rawText(candidate.name);
  const kind = rawText(candidate.kind);
  const url = rawText(candidate.source_url);
  if (!url) throw new CheatcodeInputError({ error: 'candidate.source_url is required' });
  if (!INSTALLABLE_KINDS.has(kind)) throw new CheatcodeInputError({ error: `candidate.kind must be skill|mcp|plugin (got '${kind}')` });
  return { candidate, name, kind, url };
}

const repoSlug = (url: string): string => url.replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/\.git$/, '');

// The name of the marketplace in `claude plugin marketplace list --json` whose url or repo matches url.
async function listedMarketplace(claude: string, url: string, opts: CheatcodeRunOptions): Promise<string> {
  const { out } = await runCli(claude, ['plugin', 'marketplace', 'list', '--json'], 'stdout', opts);
  const list = parseJson(out)?.value;
  if (!Array.isArray(list)) return '';
  const slug = repoSlug(url);
  const stripGit = (s: Json): Json => {
    if (typeof s !== 'string') throw new Error(`${typeof s} cannot be matched, as it is not a string`);
    return s.replace(/\.git$/, '');
  };
  try {
    const match = list.filter((m) => {
      const mUrl = alt(get(m, 'url'), '');
      return mUrl === url || stripGit(mUrl) === stripGit(url) || alt(get(m, 'repo'), '') === slug;
    });
    return rawText(alt(get(match[0] ?? null, 'name'), ''));
  } catch {
    return '';
  }
}

// A ./ path or <name>@<marketplace> ref names its marketplace; a repo already listed resolves to its registered name.
async function registeredMarketplace(claude: string, url: string, opts: CheatcodeRunOptions): Promise<string> {
  if (url.startsWith('./')) return '';
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(url)) return url.replace(/^[^@]+@/, '');
  return listedMarketplace(claude, url, opts);
}

async function marketplaceInstall(name: string, url: string, opts: CheatcodeRunOptions): Promise<InstallResult> {
  const claude = findOnPath('claude', opts);
  if (claude === null) return { installed: false, version: null, error: 'marketplace CLI unavailable' };
  let mkt = await registeredMarketplace(claude, url, opts);
  if (!mkt) {
    const add = await runCli(claude, ['plugin', 'marketplace', 'add', url, '--scope', 'project'], 'merged', opts);
    if (add.code !== 0) return { installed: false, version: null, error: `marketplace add failed (exit ${add.code})` };
    mkt = /marketplace '([^'\n]+)'/i.exec(add.out)?.[1] ?? (await listedMarketplace(claude, url, opts));
  }
  const ref = mkt ? `${name}@${mkt}` : name;
  const install = await runCli(claude, ['plugin', 'install', ref, '--scope', 'project'], 'stdout', opts);
  if (install.code !== 0) return { installed: false, version: null, error: `marketplace install failed (exit ${install.code})` };
  return { installed: true, version: /v?[0-9]+\.[0-9]+\.[0-9]+/.exec(install.out)?.[0] ?? null, error: null };
}

function fixtureResult(path: string, name: string, opts: CheatcodeRunOptions): InstallResult {
  const parsed = parseJson(readFixture(path, opts.projectRoot));
  if (parsed === null || !isObject(parsed.value)) throw new CheatcodeInputError({ error: 'fixture is not a JSON object' });
  const keyed = name ? get(parsed.value, name) : null;
  const entry = isObject(keyed) ? keyed : parsed.value;
  const attachments = get(entry, 'attachments');
  return {
    installed: alt(get(entry, 'installed'), false),
    version: alt(get(entry, 'version'), null),
    error: alt(get(entry, 'error'), null),
    attachments: Array.isArray(attachments) ? attachments : null,
  };
}

function defaultAttachments(kind: string, name: string, url: string): InstallAttachment[] {
  if (kind === 'plugin') return [{ target: 'plugin', artifact: `marketplace-plugin:${url}` }];
  if (kind === 'mcp') return [{ target: 'mcp', artifact: `mcp-server:${url}` }];
  return [{ target: 'proposed-pr', artifact: `agent-frontmatter-skill:${name}` }];
}

export async function cheatcodeInstall(
  input: CandidateInput & { scope?: string },
  opts: CheatcodeRunOptions,
): Promise<InstallOutput> {
  requireProjectRoot(opts.projectRoot);
  const scope = input.scope ?? 'local';
  if (scope !== 'local' && scope !== 'global') {
    throw new CheatcodeInputError({ error: `--scope must be local|global (got '${scope}')` });
  }
  if (scope === 'global') {
    throw new CheatcodeInputError({
      error: 'outside_project',
      scope: 'global',
      message:
        'scope=global installs outside the project (user-wide); TMB installs nothing outside the project. Re-run with --scope local.',
    });
  }
  const { candidate, name, kind, url } = installableCandidate(input);

  const fixture = fixturePath(INSTALL_FIXTURE_ENV, INSTALL_FIXTURE_FILE, opts);
  let result: InstallResult = { installed: false, version: null, error: null };
  if (fixture !== null) result = fixtureResult(fixture, name, opts);
  else if (kind === 'plugin') result = await marketplaceInstall(name, url, opts);
  else if (kind === 'mcp') {
    result = { installed: false, version: null, error: 'mcp add needs a run-command (source_url only) — see follow-up' };
  }

  return {
    candidate,
    installed: alt(result.installed, false),
    version: alt(result.version, null),
    scope,
    method: kind === 'plugin' ? 'marketplace' : kind === 'mcp' ? 'mcp-register' : 'skill-proposed-pr',
    attachments: Array.isArray(result.attachments)
      ? (result.attachments as unknown as InstallAttachment[])
      : defaultAttachments(kind, name, url),
    proposed_pr:
      kind === 'skill'
        ? {
            kind: 'agent-frontmatter',
            summary: `Add skill ${name} to a consuming agent skills: frontmatter`,
            source_url: url,
            note: 'Prompt-surface change — open as a Human-reviewed PR, never an automatic write.',
          }
        : null,
    error: alt(result.error, null),
  };
}

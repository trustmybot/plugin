/**
 * mcp-health-check end to end (GH 1692), the SessionStart gate, with a stub
 * pgrep that reports the server from its Nth call (0 = never):
 *   1. server present on the first sample        → silent, log mcp_alive=true
 *   2. server appears on the third sample        → silent
 *   3. server never appears                      → soft note, never "HALT"
 *   4. leftover TMB hooks in ~/.claude/settings.json → no warning here; the
 *      file is left byte-identical
 *   5. settings.json without leftover hooks      → no warning
 *   6. install notices from installed_plugins.json, once per session
 *   7. duplicate enabled copies (installed_plugins.json + settings.local.json)
 *   8. unknown event                             → no JSON
 *   9. the forensic log lives in the project; nothing is written under HOME
 * Each case runs `node dist/hooks.js mcp-health-check` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { checksum, contextOf, jsonValues, makeSandbox, PLUGIN_ROOT, runGate, type HookRun, type Sandbox } from './hook-sandbox.js';

const GATE = 'mcp-health-check';
const LEGACY_SETTINGS = join(PLUGIN_ROOT, 'tests/l3-integration/hooks/fixtures/legacy-user-settings.json');
const SS = '{"hook_event_name":"SessionStart","session_id":"s-1"}';
const ss = (session: string) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: session });

const PGREP_STUB = `
const fs = require('node:fs');
const n = (Number(fs.existsSync(process.env.STUB_CALLS) ? fs.readFileSync(process.env.STUB_CALLS, 'utf8') : 0) || 0) + 1;
fs.writeFileSync(process.env.STUB_CALLS, String(n));
const at = Number(fs.existsSync(process.env.STUB_APPEAR) ? fs.readFileSync(process.env.STUB_APPEAR, 'utf8') : 0) || 0;
if (at > 0 && n >= at) {
  process.stdout.write('99999\\n');
  process.exit(0);
}
process.exit(1);
`;

describe('mcp-health-check: the SessionStart server probe and install notices', () => {
  let sb: Sandbox;
  let project: string;
  let logFile: string;
  let calls: string;
  let appear: string;
  let installed: string;
  let env: NodeJS.ProcessEnv;
  let userInstall: string;
  let projectInstall: string;

  before(() => {
    sb = makeSandbox(GATE);
    project = join(sb.dir, 'project');
    mkdirSync(join(project, '.claude/tmb'), { recursive: true });
    const d = new DatabaseSync(join(project, '.claude/tmb/trajectory.db'));
    try {
      d.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER)');
    } finally {
      d.close();
    }
    logFile = join(project, '.claude/tmb/logs/mcp-health.log');
    calls = join(sb.dir, 'pgrep.calls');
    appear = join(sb.dir, 'appear-at');
    installed = join(sb.dir, 'installed_plugins.json');
    const bin = join(sb.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(bin, 'pgrep'), `#!${process.execPath}\n${PGREP_STUB}`);
    chmodSync(join(bin, 'pgrep'), 0o755);
    env = {
      ...sb.env,
      PATH: `${bin}:${sb.env.PATH}`,
      TMB_MCP_HEALTH_INTERVAL_S: '0.05',
      TMB_INSTALLED_JSON: installed,
      CLAUDE_PROJECT_DIR: project,
      STUB_CALLS: calls,
      STUB_APPEAR: appear,
    };
    userInstall = join(sb.dir, 'cache/mp/tmb/1.0.1');
    projectInstall = join(sb.dir, 'cache/mp-dev/tmb/1.0.3');
    mkdirSync(userInstall, { recursive: true });
    mkdirSync(projectInstall, { recursive: true });
  });
  after(() => sb.remove());

  function reset(appearAt: number): void {
    rmSync(calls, { force: true });
    writeFileSync(appear, String(appearAt));
  }

  function run(input: string, extra: NodeJS.ProcessEnv = {}): HookRun {
    return runGate(GATE, { cwd: sb.dir, env: { ...env, ...extra }, input });
  }

  const callCount = () => readFileSync(calls, 'utf8').trim();
  const lastLog = () => {
    const rows = readFileSync(logFile, 'utf8').trim().split('\n');
    return JSON.parse(rows[rows.length - 1]!) as { mcp_alive: unknown };
  };
  const eventOf = (stdout: string) =>
    (jsonValues(stdout)[0] as { hookSpecificOutput?: { hookEventName?: string } } | undefined)?.hookSpecificOutput?.hookEventName;

  const userEntry = () => ({ scope: 'user', installPath: userInstall, installedAt: '2026-01-01T00:00:00.000Z', version: '1.0.1' });
  const projectEntry = () => ({ scope: 'local', projectPath: project, installPath: projectInstall, installedAt: '2026-02-01T00:00:00.000Z', version: '1.0.3' });
  const localEntry = (mp: string, version: string) => ({ scope: 'local', projectPath: project, installPath: join(sb.dir, 'cache', mp, 'tmb', version), version });
  const writeInstalls = (plugins: Record<string, unknown[]>) => writeFileSync(installed, `${JSON.stringify({ version: 2, plugins })}\n`);
  const twoLocalInstalls = () =>
    writeInstalls({ 'tmb@trustmybot-dev': [localEntry('trustmybot-dev', '1.0.3')], 'tmb@trustmybot-rc': [localEntry('trustmybot-rc', '1.0.2-rc.3')] });
  const localSettings = () => join(project, '.claude/settings.local.json');

  describe('the server probe', () => {
    it('server present on the first sample: silent, one sample, log mcp_alive=true', () => {
      reset(1);
      assert.equal(run(SS).stdout, '');
      assert.equal(callCount(), '1');
      assert.equal(lastLog().mcp_alive, true);
    });

    it('server appears on the third sample: silent after three samples', () => {
      reset(3);
      assert.equal(run(SS).stdout, '');
      assert.equal(callCount(), '3');
    });

    it('server never appears: a soft note pointing at tmb_recovery §B, no HALT, no rm -rf, log mcp_alive=false', () => {
      reset(0);
      const out = run(SS).stdout;
      assert.equal(callCount(), '3');
      assert.equal(eventOf(out), 'SessionStart');
      const ctx = contextOf(out);
      assert.ok(ctx.includes('trajectory-server not detected yet at SessionStart'), ctx);
      assert.ok(ctx.includes('tmb_recovery §B'), ctx);
      assert.ok(!out.includes('HALT'), out);
      assert.ok(!out.includes('rm -rf'), out);
      assert.equal(lastLog().mcp_alive, false);
    });
  });

  describe('~/.claude/settings.json', () => {
    after(() => rmSync(join(sb.home, '.claude'), { recursive: true, force: true }));

    it('leftover TMB hooks: no warning here, and the file stays byte-identical', () => {
      reset(1);
      mkdirSync(join(sb.home, '.claude'), { recursive: true });
      const settings = join(sb.home, '.claude/settings.json');
      writeFileSync(settings, readFileSync(LEGACY_SETTINGS));
      const out = run(SS).stdout;
      assert.equal(out, '');
      assert.equal(checksum(settings), checksum(LEGACY_SETTINGS));
    });

    it('no leftover hooks: no warning', () => {
      writeFileSync(
        join(sb.home, '.claude/settings.json'),
        '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/mine.sh"}]}]}}\n',
      );
      assert.equal(run(SS).stdout, '');
    });
  });

  describe('install notices, once per session', () => {
    after(() => rmSync(installed, { force: true }));

    it('user + project installs: the user-scope install is named as ignored, once per session', () => {
      reset(1);
      writeInstalls({ 'tmb@mp': [userEntry()], 'tmb@mp-dev': [projectEntry()] });
      assert.ok(contextOf(run(ss('inst-1')).stdout).includes('user-scope TMB v1.0.1 ignored — project install v1.0.3 in use'));
      assert.equal(run(ss('inst-1')).stdout, '', 'a second SessionStart in the same session is silent');
      assert.ok(run(ss('inst-2')).stdout.includes('ignored'), 'a new session gets the notice');
    });

    it('user-scope install only: --scope project is recommended', () => {
      reset(1);
      writeInstalls({ 'tmb@mp': [userEntry()] });
      const ctx = contextOf(run(ss('inst-3')).stdout);
      assert.ok(ctx.includes('TMB installed at user scope; `--scope project` is recommended (see docs/architecture/INSTALL.md)'), ctx);
    });

    it('user-scope install only: the notice names the plugin-root INSTALL.md', () => {
      const root = join(sb.dir, 'plugin-root');
      const ctx = contextOf(run(ss('inst-3b'), { CLAUDE_PLUGIN_ROOT: root }).stdout);
      assert.ok(ctx.includes(`(see ${root}/docs/architecture/INSTALL.md)`), ctx);
    });

    it('project install only: no notice', () => {
      reset(1);
      writeInstalls({ 'tmb@mp-dev': [projectEntry()] });
      assert.equal(run(ss('inst-4')).stdout, '');
    });
  });

  describe('duplicate enabled copies', () => {
    after(() => {
      rmSync(installed, { force: true });
      rmSync(localSettings(), { force: true });
    });

    it('one enabled copy is silent', () => {
      reset(1);
      writeInstalls({ 'tmb@trustmybot-dev': [localEntry('trustmybot-dev', '1.0.3')] });
      writeFileSync(localSettings(), '{"enabledPlugins":{"tmb@trustmybot-dev":true}}\n');
      assert.equal(run(ss('dup-1')).stdout, '');
    });

    it('two enabled for this project warn, naming both, the failure mode and a scoped disable per copy', () => {
      reset(1);
      twoLocalInstalls();
      writeFileSync(localSettings(), '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}\n');
      const ctx = contextOf(run(ss('dup-2')).stdout);
      assert.ok(ctx.includes('2 copies of the tmb plugin are enabled for this project (trustmybot-dev@1.0.3, trustmybot-rc@1.0.2-rc.3)'), ctx);
      assert.ok(ctx.includes('registers the hooks of only one of them'), ctx);
      assert.ok(
        ctx.includes(
          'Remedy: keep one copy and disable the others from the project root, one of: claude plugin disable tmb@trustmybot-dev --scope local; claude plugin disable tmb@trustmybot-rc --scope local; then fully quit and relaunch Claude Code.',
        ),
        ctx,
      );
      const slash = ctx.split('\n').filter((l) => /(^|[ `"'(])\/(plugin|reload-plugins|mcp)([ `"'),.;:]|$)/.test(l));
      assert.deepEqual(slash, [], 'names no /plugin, /reload-plugins or /mcp');
    });

    it('two installed, one disabled is silent', () => {
      reset(1);
      twoLocalInstalls();
      writeFileSync(localSettings(), '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":false}}\n');
      assert.equal(run(ss('dup-3')).stdout, '');
    });

    it('a user and a project entry of one marketplace are one copy', () => {
      reset(1);
      writeInstalls({ 'tmb@mp-dev': [userEntry(), projectEntry()] });
      writeFileSync(localSettings(), '{"enabledPlugins":{"tmb@mp-dev":true}}\n');
      assert.ok(!run(ss('dup-4')).stdout.includes('copies of the tmb plugin'));
    });

    it('an invalid settings.local.json or an unreadable installed_plugins.json is silent, with no stderr', () => {
      reset(1);
      twoLocalInstalls();
      writeFileSync(localSettings(), '{"enabledPlugins":\n');
      assert.equal(run(ss('dup-5')).stderr, '', 'invalid settings.local.json: no stderr');
      assert.equal(run(ss('dup-6')).stdout, '', 'invalid settings.local.json: silent');
      writeFileSync(localSettings(), '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}\n');
      chmodSync(installed, 0o000);
      try {
        assert.equal(run(ss('dup-7')).stderr, '', 'unreadable installed_plugins.json: no stderr');
        assert.equal(run(ss('dup-8')).stdout, '', 'unreadable installed_plugins.json: silent');
      } finally {
        chmodSync(installed, 0o600);
      }
    });
  });

  it('an unknown event prints no JSON', () => {
    reset(0);
    assert.equal(run('{"session_id":"s-2"}').stdout, '');
  });

  it('nothing is written under HOME; the log is project-local', () => {
    assert.deepEqual(readdirSync(sb.home), []);
    assert.ok(existsSync(logFile) && statSync(logFile).size > 0);
  });
});

// cheatcodeInstall assembles the install payload from a fixture or a claude CLI shim (GH 659, GH 1533, GH 1885), and the approval gate fails closed.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cheatcodeInstallApproval } from '../hooks/cheatcode-install-approval.js';
import { CheatcodeInputError, type CandidateInput } from '../tools/cheatcode-runtime.js';
import { cheatcodeInstall, INSTALL_FIXTURE_FILE, type InstallOutput } from '../tools/cheatcode-install.js';
import { claudeShim, cleanEnv, tempWorkspace, type ClaudeShim } from './cheatcode-stubs.js';

const ws = tempWorkspace('tmb-cheatcode-install');
const project = join(ws.dir, 'project');
const probeDir = join(ws.dir, 'probe');
const nofixDir = join(ws.dir, 'nofix');
const flatFixture = join(ws.dir, 'install.json');
const attFixture = join(ws.dir, 'install-att.json');
const keyedFixture = join(ws.dir, 'install-keyed.json');
const winsFixture = join(ws.dir, 'wins.json');
let shim: ClaudeShim;

before(() => {
  for (const d of [project, probeDir, nofixDir]) mkdirSync(d, { recursive: true });
  writeFileSync(flatFixture, '{ "installed": true, "version": "1.2.3", "error": null }');
  writeFileSync(
    attFixture,
    JSON.stringify({ installed: true, version: '1.0.0', attachments: [{ target: 'swe', artifact: 'marketplace-plugin:feature-dev' }] }),
  );
  writeFileSync(
    keyedFixture,
    JSON.stringify({
      'feature-dev': { installed: true, version: '1.0.0', attachments: [{ target: 'swe', artifact: 'marketplace-plugin:feature-dev' }] },
      'code-review': { installed: true, version: '1.0.0', attachments: [{ target: 'code-reviewer', artifact: 'marketplace-plugin:code-review' }] },
    }),
  );
  writeFileSync(
    join(probeDir, INSTALL_FIXTURE_FILE),
    JSON.stringify({ installed: true, version: '9.9.9', error: null, attachments: [{ target: 'swe', artifact: 'marketplace-plugin:feature-dev' }] }),
  );
  writeFileSync(winsFixture, '{ "installed": true, "version": "1.1.1", "error": null }');
  shim = claudeShim(
    ws.dir,
    `case "$*" in\n  "plugin marketplace list"*) printf '[]\\n' ;;\n  "plugin marketplace add"*) printf "Successfully added marketplace 'x-mkt'\\n" ;;\nesac`,
  );
});
after(() => ws.cleanup());

const PDF_PLUGIN = '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf"}';
const PDF_SKILL = '{"name":"pdf-skill","kind":"skill","source_url":"https://x.test/pdf-skill"}';
const FEATURE_DEV = '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/feature-dev"}';

function withFixture(fixture: string, input: CandidateInput & { scope?: string }, projectRoot = project): Promise<InstallOutput> {
  return cheatcodeInstall(input, { projectRoot, env: cleanEnv({ TMB_CHEATCODE_INSTALL_FIXTURE: fixture }) });
}

function noFixture(input: CandidateInput & { scope?: string }, projectRoot = project): Promise<InstallOutput> {
  return cheatcodeInstall(input, { projectRoot, env: cleanEnv({ PATH: '/usr/bin:/bin' }) });
}

function live(input: CandidateInput & { scope?: string }): Promise<InstallOutput> {
  shim.reset();
  return cheatcodeInstall(input, { projectRoot: project, env: shim.env });
}

async function inputError(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CheatcodeInputError) return e.payload;
    throw e;
  }
  assert.fail('expected a CheatcodeInputError');
}

describe('cheatcodeInstall over a fixture (Part A)', () => {
  let out: InstallOutput;
  before(async () => {
    out = await withFixture(flatFixture, { candidate: '{"name":"pdf-plugin","kind":"plugin","source_url":"https://x.test/pdf","tier":1}' });
  });

  it('output round-trips as JSON', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  });
  it('plugin kind installs via the marketplace method', () => {
    assert.equal(out.method, 'marketplace');
  });
  it('plugin install reports installed=true with version', () => {
    assert.equal(out.installed, true);
    assert.equal(out.version, '1.2.3');
  });
  it('plugin attachment targets the plugin (no prompt-surface edit)', () => {
    assert.equal(out.attachments[0]?.target, 'plugin');
  });
  it('plugin install has no proposed_pr', () => {
    assert.equal(out.proposed_pr, null);
  });
  it('scope defaults to local when omitted', () => {
    assert.equal(out.scope, 'local');
  });
});

describe('cheatcodeInstall through the claude CLI shim', () => {
  it('scope global is refused with outside_project before any claude call', async () => {
    const err = await inputError(live({ scope: 'global', candidate: PDF_PLUGIN }));
    assert.equal(err.error, 'outside_project');
    assert.deepEqual(shim.calls(), []);
  });
  it('plugin kind: marketplace add + install run with --scope project', async () => {
    const res = await live({ candidate: PDF_PLUGIN });
    assert.equal(res.installed, true);
    assert.deepEqual(shim.calls(), [
      'plugin marketplace list --json',
      'plugin marketplace add https://x.test/pdf --scope project',
      'plugin install pdf-plugin@x-mkt --scope project',
    ]);
  });
  it('plugin kind: every claude call runs in the project root, not the server cwd', () => {
    const real = realpathSync(project);
    assert.deepEqual(shim.cwds(), [real, real, real]);
  });
  it('mcp kind: fails closed with no claude call and no .mcp.json', async () => {
    const res = await live({ candidate: '{"name":"pdf-mcp","kind":"mcp","source_url":"https://x.test/pdf-mcp"}' });
    assert.equal(res.installed, false);
    assert.equal(res.error, 'mcp add needs a run-command (source_url only) — see follow-up');
    assert.deepEqual(shim.calls(), []);
    assert.deepEqual(shim.cwds(), []);
    assert.ok(!existsSync(join(project, '.mcp.json')));
    assert.ok(!existsSync(join(process.cwd(), '.mcp.json')));
  });
  it('an unset project root fails with a clear message', async () => {
    const err = await inputError(withFixture(flatFixture, { candidate: PDF_PLUGIN }, ''));
    assert.match(String(err.error), /TMB_PROJECT_ROOT is unset/);
  });
  it('an invalid scope fails', async () => {
    const err = await inputError(noFixture({ scope: 'bad', candidate: '{"name":"x","kind":"plugin","source_url":"https://x"}' }));
    assert.equal(err.error, "--scope must be local|global (got 'bad')");
  });
});

describe('cheatcodeInstall fixture routing', () => {
  it('a fixture-supplied attachment target passes through', async () => {
    assert.equal((await withFixture(attFixture, { candidate: FEATURE_DEV })).attachments[0]?.target, 'swe');
  });

  let fd: InstallOutput;
  let cr: InstallOutput;
  before(async () => {
    fd = await withFixture(keyedFixture, { candidate: FEATURE_DEV });
    cr = await withFixture(keyedFixture, { candidate: '{"name":"code-review","kind":"plugin","source_url":"https://x.test/code-review"}' });
  });
  it('a per-candidate keyed fixture routes feature-dev to swe', () => {
    assert.equal(fd.attachments[0]?.target, 'swe');
  });
  it('a per-candidate keyed fixture routes code-review to code-reviewer', () => {
    assert.equal(cr.attachments[0]?.target, 'code-reviewer');
  });
  it('per-candidate keyed targets are distinct', () => {
    assert.notEqual(fd.attachments[0]?.target, cr.attachments[0]?.target);
  });
  it('a flat fixture still works for an unmatched candidate name (regression)', async () => {
    const flat = await withFixture(flatFixture, { candidate: '{"name":"feature-dev","kind":"plugin","source_url":"https://x.test/pdf"}' });
    assert.equal(flat.installed, true);
    assert.equal(flat.version, '1.2.3');
    assert.equal(flat.attachments[0]?.target, 'plugin');
  });
  it('env unset + default fixture file in the project -> fixture used', async () => {
    const probe = await noFixture({ candidate: FEATURE_DEV }, probeDir);
    assert.equal(probe.installed, true);
    assert.equal(probe.version, '9.9.9');
    assert.equal(probe.attachments[0]?.target, 'swe');
  });
  it('a default fixture in the server cwd (not the project) is ignored', async () => {
    const cwd = process.cwd();
    process.chdir(probeDir);
    try {
      assert.equal((await noFixture({ candidate: PDF_SKILL }, nofixDir)).installed, false);
    } finally {
      process.chdir(cwd);
    }
  });
  it('an env-set fixture wins over the default file in the project', async () => {
    assert.equal((await withFixture(winsFixture, { candidate: FEATURE_DEV }, probeDir)).version, '1.1.1');
  });
  it('no env + no default file -> no-fixture path unchanged (not installed)', async () => {
    const res = await noFixture({ candidate: PDF_SKILL }, nofixDir);
    assert.equal(res.installed, false);
    assert.equal(res.method, 'skill-proposed-pr');
  });
});

describe('cheatcodeInstall of a skill', () => {
  let skill: InstallOutput;
  before(async () => {
    skill = await noFixture({ candidate: PDF_SKILL }, nofixDir);
  });
  it('uses the skill-proposed-pr method', () => {
    assert.equal(skill.method, 'skill-proposed-pr');
  });
  it('returns an agent-frontmatter proposed-PR payload', () => {
    assert.equal(skill.proposed_pr?.kind, 'agent-frontmatter');
  });
  it('installs nothing at the marketplace', () => {
    assert.equal(skill.installed, false);
  });
  it('an invalid kind fails', async () => {
    const err = await inputError(noFixture({ candidate: '{"name":"x","kind":"bad","source_url":"https://x"}' }));
    assert.equal(err.error, "candidate.kind must be skill|mcp|plugin (got 'bad')");
  });
});

describe('cheatcode-install-approval gate fails closed (Part B)', () => {
  const db = join(ws.dir, 'ws/.claude/tmb/trajectory.db');
  const gateEnv = () => ({ ...process.env, TRAJECTORY_DB_PATH: db });
  const installInput = (url: string) =>
    JSON.stringify({
      tool_name: 'mcp__plugin_tmb_trajectory-server__cheatcode_install',
      tool_input: { agent: 'bro', candidate: { name: 'pdf', kind: 'plugin', source_url: url } },
    });
  const isDeny = (stdout: string) => stdout.includes('"permissionDecision":"deny"');

  before(() => {
    mkdirSync(join(ws.dir, 'ws/.claude/tmb'), { recursive: true });
    const conn = new DatabaseSync(db);
    conn.exec(`
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL DEFAULT -1,
        branch_id TEXT,
        from_node TEXT NOT NULL DEFAULT 'bro',
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);
    `);
    conn.close();
  });

  it('a non-cheatcode_install tool passes through silently', () => {
    assert.equal(cheatcodeInstallApproval('{"tool_name":"Bash"}', gateEnv()).stdout, '');
  });
  it('an install WITHOUT an approval record is denied (fail closed)', () => {
    const { stdout } = cheatcodeInstallApproval(installInput('https://x.test/pdf'), gateEnv());
    assert.ok(isDeny(stdout), stdout);
    assert.ok(stdout.includes('cheatcode_approve'), stdout);
  });
  it('a missing candidate.source_url is denied', () => {
    assert.ok(isDeny(cheatcodeInstallApproval('{"tool_name":"mcp__x__cheatcode_install","tool_input":{}}', gateEnv()).stdout));
  });
  it('an install WITH a matching approval record is allowed', () => {
    const conn = new DatabaseSync(db);
    conn.exec(`
      INSERT INTO audit (event_type, summary, content_json, created_at)
      VALUES ('cheatcode_approved', 'approved pdf',
              json_object('name','pdf','kind','plugin','source_url','https://x.test/pdf'),
              datetime('now'));
    `);
    conn.close();
    assert.equal(cheatcodeInstallApproval(installInput('https://x.test/pdf'), gateEnv()).stdout, '');
  });
  it('an approval for a different candidate does NOT unlock this one (per-candidate)', () => {
    assert.ok(isDeny(cheatcodeInstallApproval(installInput('https://x.test/OTHER'), gateEnv()).stdout));
  });
});

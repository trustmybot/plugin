/**
 * session-start-persona (GH 1692): the plugin CLAUDE.md as additionalContext
 * behind a header line on every SessionStart source (startup, resume, clear,
 * compact), whatever the project CLAUDE.md holds; the one-line note for an old
 * tmb:persona block; the per-session persona marker; silence for the
 * plugin-root project; raw text without jq; silence without a readable source;
 * and the project CLAUDE.md left byte-identical. Each case runs
 * `node dist/hooks.js session-start-persona` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checksum, contextOf, jsonValues, lineAt, makeSandbox, noCmdPath, PLUGIN_ROOT, runGate, type Sandbox, without } from './hook-sandbox.js';

const GATE = 'session-start-persona';
const HEADER = "[Persona loaded by the TMB persona hook from the tmb plugin's CLAUDE.md, v1.1.0]";
const NOTE =
  "[The project's CLAUDE.md still holds a <!-- tmb:persona --> block from an older /onboard. It is no longer needed, since this hook delivers the persona; tell the Human they may delete it.]";

const TZ_LINE = 'User time zone: UTC (UTC+00:00). Give the Human times in this zone with its abbreviation; GitHub, commit and DB timestamps stay in UTC.';

const payload = (sid: string, source: string) => JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', source });

describe('session-start-persona: the persona as SessionStart context', () => {
  let sb: Sandbox;
  let plugin: string;
  let project: string;
  let projectMd: string;

  before(() => {
    sb = makeSandbox(GATE);
    plugin = join(sb.dir, 'plugin');
    project = join(sb.dir, 'project');
    projectMd = join(project, 'CLAUDE.md');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(plugin, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"1.1.0"}\n');
    writeFileSync(join(plugin, 'CLAUDE.md'), '# You are bro\n\nOrchestrate.\n');
  });

  after(() => sb.remove());

  const marker = (sid: string) => join(project, `.claude/tmb/sessions/${sid}.persona`);

  function run(dir: string, input: string, extra: NodeJS.ProcessEnv = {}): string {
    return runGate(GATE, { cwd: dir, input, env: { ...sb.env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: dir, TZ: 'UTC', ...extra } }).stdout;
  }

  function assertPersonaEmitted(label: string, sid: string, source: string): void {
    const beforeSum = checksum(projectMd);
    rmSync(marker(sid), { force: true });
    const out = run(project, payload(sid, source));
    const v = jsonValues(out)[0] as { hookSpecificOutput?: { hookEventName?: string } } | undefined;
    assert.equal(v?.hookSpecificOutput?.hookEventName, 'SessionStart', `${label}: event name`);
    const ctx = contextOf(out);
    assert.equal(lineAt(ctx, 1), HEADER, `${label}: header line`);
    assert.ok(ctx.includes('# You are bro'), `${label}: persona body`);
    assert.ok(ctx.includes(`Project root (<project> in TMB prompts): ${project}\n${TZ_LINE}\n\n`), `${label}: project root line, then the time zone line`);
    assert.equal(checksum(projectMd), beforeSum, `${label}: project CLAUDE.md byte-identical`);
    assert.ok(existsSync(marker(sid)), `${label}: persona marker for ${sid}`);
  }

  it('every SessionStart source injects the persona and writes the marker', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact']) assertPersonaEmitted(source, `s-${source}`, source);
    assert.equal(checksum(projectMd), 'absent', 'no CLAUDE.md created');
  });

  it('project CLAUDE.md without a block: persona, no note', () => {
    writeFileSync(projectMd, '# Mine\n\nOur rules.\n');
    assertPersonaEmitted('no block', 's-plain', 'startup');
    assert.ok(!contextOf(run(project, payload('s-plain', 'startup'))).includes('tmb:persona'), 'no block: no note');
  });

  it('an old tmb:persona block, any version: persona plus the one-line note', () => {
    for (const version of ['1.0.3', '1.1.0']) {
      writeFileSync(projectMd, `# Mine\r\n\r\n<!-- tmb:persona start v${version} -->\r\n# You are bro\r\n<!-- tmb:persona end -->\r\n`);
      assertPersonaEmitted(`block v${version}`, `s-block-${version}`, 'resume');
      const ctx = contextOf(run(project, payload(`s-block-${version}`, 'resume')));
      assert.equal(lineAt(ctx, 2), NOTE, `block v${version}: note on line 2`);
      assert.ok(ctx.includes('Orchestrate.'), `block v${version}: persona body still sent`);
    }
    rmSync(projectMd);
  });

  it('plugin root as the project: silent, no marker', () => {
    assert.equal(run(plugin, payload('s-root', 'startup')), '', 'plugin-root project');
    const link = join(sb.dir, 'plugin-link');
    symlinkSync(plugin, link);
    assert.equal(run(link, payload('s-root', 'startup')), '', 'plugin root through a symlink');
    assert.equal(checksum(join(plugin, '.claude/tmb/sessions/s-root.persona')), 'absent', 'no marker in the plugin root');
  });

  it('no or unsafe session_id: persona still injected, no marker', () => {
    assert.ok(contextOf(run(project, '{"source":"startup"}')).includes('# You are bro'), 'no session_id');
    assert.ok(contextOf(run(project, payload('../escape', 'startup'))).includes('# You are bro'), 'unsafe session_id');
    assert.equal(checksum(join(project, '.claude/tmb/escape.persona')), 'absent', 'no marker outside sessions/');
  });

  it('CLAUDE_PROJECT_DIR unset: falls back to the working directory', () => {
    const env = without({ ...sb.env, CLAUDE_PLUGIN_ROOT: plugin }, 'CLAUDE_PROJECT_DIR');
    assert.equal(runGate(GATE, { cwd: plugin, env, input: payload('s-cwd', 'startup') }).stdout, '', 'cwd = plugin root');
    assert.ok(contextOf(runGate(GATE, { cwd: project, env, input: payload('s-cwd', 'startup') }).stdout).includes('# You are bro'), 'cwd = project');
  });

  it('jq off PATH: raw text with the header, marker still written', () => {
    const nojq = noCmdPath(join(sb.dir, 'nojq'), 'jq', sb.env.PATH ?? '');
    rmSync(marker('s-nojq'), { force: true });
    const out = run(project, payload('s-nojq', 'startup'), { PATH: nojq });
    assert.equal(lineAt(out, 1), HEADER, 'no-jq header');
    assert.ok(out.includes('# You are bro'), 'no-jq body');
    assert.ok(existsSync(marker('s-nojq')), 'no-jq: persona marker');
    writeFileSync(projectMd, '# Mine\n<!-- tmb:persona start v1.0.3 -->\n# bro\n<!-- tmb:persona end -->\n');
    assert.equal(lineAt(run(project, payload('s-nojq', 'startup'), { PATH: nojq }), 2), NOTE, 'no-jq note');
    rmSync(projectMd);
  });

  it('no readable plugin CLAUDE.md: silent, exit 0, no marker', () => {
    const empty = join(sb.dir, 'empty-plugin');
    mkdirSync(empty);
    rmSync(marker('s-empty'), { force: true });
    const r = runGate(GATE, { cwd: project, input: payload('s-empty', 'startup'), env: { ...sb.env, CLAUDE_PLUGIN_ROOT: empty, CLAUDE_PROJECT_DIR: project } });
    assert.equal(r.status, 0, 'exit code');
    assert.equal(r.stdout + r.stderr, '', 'output');
    assert.equal(checksum(marker('s-empty')), 'absent', 'no marker without a persona');
  });

  it('the shipped plugin CLAUDE.md fits the hook context cap', () => {
    const ctx = contextOf(run(project, payload('s-shipped', 'startup'), { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }));
    assert.ok(ctx.includes('# You are bro'), 'shipped persona');
    assert.ok(ctx.length < 10_000, `shipped context is ${ctx.length} chars, under the 10k cap`);
  });
});

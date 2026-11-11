/**
 * user-prompt-persona (GH 1692): with no persona marker for the session
 * (plugin hooks reloaded mid-session) the persona is injected once and the
 * marker written; silence once session-start-persona marked the session; the
 * old-block note; silence at the plugin root and without a session_id; a
 * once-only plain notice to start a new session when the plugin CLAUDE.md
 * cannot be read; raw text without jq; and the project CLAUDE.md never
 * written. Each case runs `node dist/hooks.js <gate>` in a sandbox with its
 * own HOME.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checksum, contextOf, jsonValues, lineAt, makeSandbox, noCmdPath, runGate, type Sandbox } from './hook-sandbox.js';

const GATE = 'user-prompt-persona';
const HEADER = "[Persona loaded by the TMB persona hook from the tmb plugin's CLAUDE.md, v1.1.0]";
const NOTICE =
  "TMB could not read the plugin CLAUDE.md that carries bro's persona, so this session runs without it. Start a new Claude Code session to load it.";
const TZ_LINE = 'User time zone: UTC (UTC+00:00). Give the Human times in this zone with its abbreviation; GitHub, commit and DB timestamps stay in UTC.';

const payload = (sid: string) => JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
const systemMessage = (stdout: string) => (jsonValues(stdout)[0] as { systemMessage?: string } | undefined)?.systemMessage;

describe('user-prompt-persona: the persona once per session when SessionStart did not deliver it', () => {
  let sb: Sandbox;
  let plugin: string;
  let emptyPlugin: string;
  let project: string;
  let projectMd: string;

  before(() => {
    sb = makeSandbox(GATE);
    plugin = join(sb.dir, 'plugin');
    emptyPlugin = join(sb.dir, 'empty-plugin');
    project = join(sb.dir, 'project');
    projectMd = join(project, 'CLAUDE.md');
    for (const p of [plugin, emptyPlugin]) {
      mkdirSync(join(p, '.claude-plugin'), { recursive: true });
      writeFileSync(join(p, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"1.1.0"}\n');
    }
    mkdirSync(project);
    writeFileSync(join(plugin, 'CLAUDE.md'), '# You are bro\n\nOrchestrate.\n');
  });

  after(() => sb.remove());

  const marker = (sid: string) => join(project, `.claude/tmb/sessions/${sid}.persona`);

  function exec(dir: string, input: string, pluginRoot: string, extra: NodeJS.ProcessEnv = {}, gate = GATE) {
    return runGate(gate, { cwd: dir, input, env: { ...sb.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: dir, TZ: 'UTC', ...extra } });
  }
  const run = (dir: string, input: string, pluginRoot: string, extra: NodeJS.ProcessEnv = {}) => exec(dir, input, pluginRoot, extra).stdout;

  it('no marker: the persona is injected once and the marker written', () => {
    const out = run(project, payload('s-mid'), plugin);
    const v = jsonValues(out)[0] as { hookSpecificOutput?: { hookEventName?: string } } | undefined;
    assert.equal(v?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit', 'event name');
    const ctx = contextOf(out);
    assert.equal(lineAt(ctx, 1), HEADER, 'header line');
    assert.ok(ctx.includes('# You are bro'), 'persona body');
    assert.equal(lineAt(ctx, 2), `Project root (<project> in TMB prompts): ${project}`, 'project root line');
    assert.equal(lineAt(ctx, 3), TZ_LINE, 'time zone line');
    assert.ok(existsSync(marker('s-mid')), 'persona marker written');
    assert.equal(run(project, payload('s-mid'), plugin), '', 'second prompt silent');
    assert.equal(checksum(projectMd), 'absent', 'no CLAUDE.md created');
  });

  it('a session SessionStart already marked: silent', () => {
    exec(project, '{"session_id":"s-start","source":"startup"}', plugin, {}, 'session-start-persona');
    assert.ok(existsSync(marker('s-start')), 'session-start-persona wrote the marker');
    assert.equal(run(project, payload('s-start'), plugin), '', 'marked session');
  });

  it('an old tmb:persona block: the fallback carries the note, file byte-identical', () => {
    writeFileSync(projectMd, '# Mine\r\n\r\n<!-- tmb:persona start v1.0.3 -->\r\n# You are bro\r\n<!-- tmb:persona end -->\r\n');
    const beforeSum = checksum(projectMd);
    const ctx = contextOf(run(project, payload('s-block'), plugin));
    assert.ok(lineAt(ctx, 2).includes('tell the Human they may delete it'), 'note on line 2');
    assert.ok(ctx.includes('Orchestrate.'), 'persona body');
    assert.equal(checksum(projectMd), beforeSum, 'project CLAUDE.md byte-identical');
    rmSync(projectMd);
  });

  it('plugin root as the project: silent, no marker', () => {
    assert.equal(run(plugin, payload('s-root'), plugin), '', 'plugin-root project');
    assert.equal(checksum(join(plugin, '.claude/tmb/sessions/s-root.persona')), 'absent', 'no marker in the plugin root');
  });

  it('no or unsafe session_id: silent', () => {
    assert.equal(run(project, '{"prompt":"hello"}', plugin), '', 'no session_id');
    assert.equal(run(project, payload('../escape'), plugin), '', 'unsafe session_id');
  });

  it('unreadable plugin CLAUDE.md: a plain notice once, exit 0, no persona marker', () => {
    const r = exec(project, payload('s-gone'), emptyPlugin);
    assert.equal(r.status, 0, 'exit code');
    assert.equal(systemMessage(r.stdout + r.stderr), NOTICE, 'notice as systemMessage');
    assert.equal(checksum(marker('s-gone')), 'absent', 'no persona marker');
    assert.equal(run(project, payload('s-gone'), emptyPlugin), '', 'notice shown once');
    assert.ok(contextOf(run(project, payload('s-gone'), plugin)).includes('# You are bro'), 'persona once the file is readable again');
  });

  it('jq off PATH: raw text once, then silent; the notice still parses', () => {
    const nojq = { PATH: noCmdPath(join(sb.dir, 'nojq'), 'jq', sb.env.PATH ?? '') };
    const out = run(project, payload('s-nojq'), plugin, nojq);
    assert.equal(lineAt(out, 1), HEADER, 'no-jq header');
    assert.ok(out.includes('# You are bro'), 'no-jq body');
    assert.equal(run(project, payload('s-nojq'), plugin, nojq), '', 'no-jq second prompt silent');
    assert.equal(systemMessage(run(project, payload('s-nojq-gone'), emptyPlugin, nojq)), NOTICE, 'no-jq notice is valid JSON');
  });

  it('the hooks never wrote the project CLAUDE.md', () => {
    assert.equal(checksum(projectMd), 'absent', 'still absent');
  });
});

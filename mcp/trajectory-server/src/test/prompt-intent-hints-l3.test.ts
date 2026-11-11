/**
 * The prompt-intent-hints l3 bash suite in node:test (GH 1692): positive (fires)
 * and negative (false-positive guard) cases for every pattern class —
 * cheatcode-install, cheatcode-routing, consultant-spawn, search-grounding,
 * concerns-protocol, push-intent, reonboard-intent, headless-intent,
 * resume-intent, adr-required and audit-intent. Without a DB the DB-backed
 * classes stay silent; the GH 1199 cases run against a schema.sql DB.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HOOKS_JS, PLUGIN_ROOT, makeSandbox, runGate, type HookRun, type Sandbox } from './hook-sandbox.js';
import { has, hasNot, sql } from './git-push-guard-l3.js';
import { execDb } from './swe-atomic-close-l3.js';

const GATE = 'prompt-intent-hints';
const NO_DB = '/nonexistent.db';
const HINTS_ON = Object.fromEntries(
  ['CHEATCODE_INSTALL', 'CONSULTANT', 'SEARCH', 'CONCERNS', 'PUSH_INTENT', 'REONBOARD', 'HEADLESS', 'RESUME', 'ADR', 'AUDIT'].map((k) => [`TMB_DISABLE_${k}_HINT`, '0']),
);

describe('prompt-intent-hints l3', () => {
  let sb: Sandbox;
  let proj: string;
  let hintDb: string;

  before(() => {
    sb = makeSandbox('prompt-intent-hints');
    proj = join(sb.dir, 'proj');
    mkdirSync(proj);
    hintDb = join(sb.dir, 'trajectory.db');
    execDb(hintDb, readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
    execDb(
      hintDb,
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at)
         VALUES (1, 'auth work', 'd', 'open', datetime('now'), datetime('now'));
       INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
         VALUES (1, 1, 'feat/done', 'done task', 'd', 'completed', '', 'abc123', datetime('now'), datetime('now'));
       INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
         VALUES (2, 1, 'feat/next', 'next task', 'd', 'pending', '', datetime('now'), datetime('now'));
       INSERT INTO audit (issue_id, event_type, summary, created_at)
         VALUES (1, 'planning_complete', 'planned', datetime('now'));`,
    );
  });
  after(() => sb.remove());

  const envOf = (cwd: string, db: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...sb.env,
    CLAUDE_PROJECT_DIR: proj,
    PWD: cwd,
    TRAJECTORY_DB_PATH: db,
    ...extra,
  });
  const runRaw = (prompt: string, cwd: string, db: string, extra: NodeJS.ProcessEnv = {}): HookRun =>
    runGate(GATE, { cwd, env: envOf(cwd, db, extra), input: JSON.stringify({ prompt }) });
  const out = (r: HookRun) => r.stdout + r.stderr;
  /** The gate from the plugin root with every hint enabled and no DB. */
  const runHook = (prompt: string) => out(runRaw(prompt, PLUGIN_ROOT, NO_DB, HINTS_ON));
  /** The gate from the sandbox against the seeded DB. */
  const runHookDb = (prompt: string, extra: NodeJS.ProcessEnv = {}) => out(runRaw(prompt, sb.dir, hintDb, extra));
  /** The gate from the plugin root with no DB and only <extra> set. */
  const runHookEnv = (prompt: string, extra: NodeJS.ProcessEnv) => out(runRaw(prompt, PLUGIN_ROOT, NO_DB, extra));

  describe('empty and long prompts', () => {
    it('empty prompt emits nothing', () => {
      hasNot(runHook(''), 'additionalContext', 'empty prompt must be silent');
    });

    it('whitespace-only prompt emits nothing', () => {
      hasNot(runHook('  \t\n \t \n\n   '), 'additionalContext', 'spaces, tabs and newlines alone must be silent');
    });

    it('20k-char prompt still fires its hint within the 6 s hooks.json budget (GH 1711)', () => {
      const longPrompt = `${'lorem ipsum dolor sit amet consectetur '.repeat(520)}\nPlease install the superpowers skill`;
      assert.ok(longPrompt.length >= 20000, 'prompt is at least 20,000 characters');
      const r = spawnSync(process.execPath, [HOOKS_JS, GATE], {
        cwd: PLUGIN_ROOT,
        input: JSON.stringify({ prompt: longPrompt }),
        env: envOf(PLUGIN_ROOT, NO_DB, { TMB_DISABLE_CHEATCODE_INSTALL_HINT: '0' }),
        encoding: 'utf8',
        timeout: 6000,
      });
      has(r.stdout + r.stderr, 'cheatcode-install routing', 'a hook killed at the budget prints nothing; the hint must arrive in time');
    });
  });

  describe('cheatcode-install: install of a named plugin/skill/mcp/cheatcode', () => {
    it('cheatcode-install: row-44 install-plugins-in-local-scope prompt fires', () => {
      const o = runHook('install the feature-dev and code-review plugins in local scope');
      has(o, 'cheatcode-install routing', 'named plugin install must fire');
      has(o, 'cheatcode_approve', 'CTX must name cheatcode_approve');
      has(o, 'cheatcode_install', 'CTX must name cheatcode_install');
      has(o, 'NOT agent', 'CTX must say NOT agent-create');
    });

    const fires: Array<[string, string, string]> = [
      ["cheatcode-install: 'install the X skill' fires", 'Please install the superpowers skill', 'named skill install must fire'],
      ["cheatcode-install: 'install the X mcp' fires", 'install the linear mcp', 'named mcp install must fire'],
      ["cheatcode-install: 'in global scope' alone fires", 'set it up in global scope', 'in global scope must fire'],
    ];
    for (const [name, prompt, msg] of fires) it(name, () => has(runHook(prompt), 'cheatcode-install routing', msg));

    const silent: Array<[string, string, string]> = [
      ["cheatcode-install: 'npm install' does NOT fire", 'Run npm install to get the deps', 'npm install must not fire'],
      ["cheatcode-install: 'pip install' does NOT fire", 'pip install requests for the script', 'pip install must not fire'],
      ["cheatcode-install: 'bun install' does NOT fire", 'bun install in the server directory', 'bun install (no capability noun) must not fire'],
      ["cheatcode-install: 'install dependencies' does NOT fire", 'install dependencies before running the build', 'install dependencies must not fire'],
    ];
    for (const [name, prompt, msg] of silent) it(name, () => hasNot(runHook(prompt), 'cheatcode-install routing', msg));

    it('cheatcode-install: bare role name still routes to agent-create (no regression)', () => {
      const o = runHook("get the architect's read on this design choice?");
      hasNot(o, 'cheatcode-install routing', 'bare role must not hit cheatcode hint');
      has(o, 'consultant-spawn enforcement', 'bare role still routes to agent-create');
    });
  });

  describe('cheatcode-routing: install/add a capability targeted at a known agent', () => {
    it("cheatcode-routing: 'install <X> for swe and code-reviewer' fires cheatcode cue", () => {
      const o = runHook('install typescript-lsp for swe and code-reviewer');
      has(o, 'cheatcode-routing', 'capability-on-agent install must fire');
      has(o, 'tmb_cheatcode', 'CTX must point to tmb_cheatcode skill');
    });

    it("cheatcode-routing: 'add <X> to bro' fires cheatcode cue", () => {
      const o = runHook('add a web-search tool to bro');
      has(o, 'cheatcode-routing', 'add-to-agent must fire');
      has(o, 'tmb_cheatcode', 'CTX must point to tmb_cheatcode skill');
    });

    it("cheatcode-routing: positive cue does not name a 'don't use planning' clause", () => {
      const o = runHook('install ripgrep for swe');
      has(o, 'cheatcode-routing', 'capability-on-agent must fire');
      hasNot(o, 'planning', 'positive disambiguation only — no negative planning clause');
    });

    it('cheatcode-routing: plain dependency install does NOT fire cheatcode cue', () => {
      hasNot(runHook('npm install to get the deps for the build'), 'cheatcode-routing', 'dependency install (no agent target) must not fire');
    });

    it("cheatcode-routing: 'install dependencies' does NOT fire cheatcode cue", () => {
      hasNot(runHook('install dependencies before running the build'), 'cheatcode-routing', 'install dependencies must not fire');
    });

    it('cheatcode-routing: words inside an injected <system-reminder> do NOT fire (GH 1764)', () => {
      const o = runHook(
        'tag 1737 - 1745 with token-burn\n<system-reminder>\nAnother session: no dependencies installed yet; passed the overlap warning to swe.\n</system-reminder>',
      );
      hasNot(o, 'cheatcode-routing', "harness-injected reminder text is not the Human's intent");
    });

    it("cheatcode-routing: 'install the playwright skill for swe' fires (GH 1764)", () => {
      has(runHook('install the playwright skill for swe'), 'cheatcode-routing', 'install + skill + for swe in one clause must fire');
    });

    it("cheatcode-routing: 'installed' and a later clause's 'to swe' do NOT fire (GH 1764)", () => {
      hasNot(runHook('I installed it. Then hand it to swe'), 'cheatcode-routing', 'install must be a whole word with its target in the same clause');
    });

    it('cheatcode-routing: install verb and agent target split by a newline do NOT fire (GH 1764)', () => {
      hasNot(runHook('install it\nthen hand the result to swe'), 'cheatcode-routing', 'a newline ends the clause');
    });

    it("cheatcode-routing: 'add <X> onto code-reviewer' fires (GH 1764)", () => {
      has(runHook('add the lint skill onto code-reviewer'), 'cheatcode-routing', 'onto <agent> is an agent target');
    });

    it('injected blocks: <pasted_content> and <agent-message> spans are stripped (GH 1764)', () => {
      hasNot(
        runHook('what changed? <pasted_content id="1">install the x skill for swe</pasted_content>'),
        'cheatcode-routing',
        "pasted content is not the Human's own words",
      );
      hasNot(runHook('thanks <agent-message from="swe">please audit the importer</agent-message>'), 'audit-intent hint', 'an agent-message turn stays silent');
    });

    it('injected blocks: typed text outside a <system-reminder> still fires', () => {
      has(
        runHook('<system-reminder>nothing to see</system-reminder>\nplease check the audit'),
        'audit-intent hint',
        "the Human's words around a reminder are still matched",
      );
    });

    it('injected blocks: a reminder-only prompt emits nothing', () => {
      hasNot(runHook('<system-reminder>install the x skill for swe; audit it</system-reminder>'), 'additionalContext', 'a prompt of injected text alone is silent');
    });
  });

  describe('synthetic-turn early-exit: harness-generated turns emit nothing', () => {
    it('synthetic-turn: <task-notification> body emits nothing', () => {
      hasNot(
        runHook('<task-notification>swe reports: ran bun install in plugin/mcp/ to rebuild the dist</task-notification>'),
        'additionalContext',
        'task-notification turn must be fully silent',
      );
    });

    it('synthetic-turn: [SYSTEM NOTIFICATION] body emits nothing', () => {
      hasNot(
        runHook('[SYSTEM NOTIFICATION - NOT USER INPUT] code-reviewer finished reviewing plugin/mcp/dist'),
        'additionalContext',
        'system-notification turn must be fully silent',
      );
    });
  });

  describe('cheatcode-install: package-manager installs never route to cheatcodes', () => {
    it("cheatcode-install: 'bun install to fix the plugin build' does NOT fire", () => {
      hasNot(runHook('i ran bun install to fix the plugin build'), 'cheatcode-install routing', 'bun install + plugin noun must not fire');
    });

    it("cheatcode-install: 'npm install left the mcp dist stale' does NOT fire", () => {
      hasNot(runHook('npm install left the mcp dist stale'), 'cheatcode-install routing', 'npm install + mcp noun must not fire');
    });

    it("cheatcode-routing: 'add the code-review skill for swe' fires capability-on-agent", () => {
      const o = runHook('add the code-review skill for swe');
      has(o, 'cheatcode-routing', 'add-skill-for-agent must fire capability-on-agent');
      hasNot(o, 'cheatcode-install routing', 'capability-on-agent must not also fire install hint');
    });
  });

  describe('consultant-spawn: domain keyword + advisory shape required', () => {
    const fires: Array<[string, string, string]> = [
      ['consultant-spawn: security + question shape fires', 'Is this SQL injection vulnerability safe to ignore?', 'security + ? must fire'],
      ['consultant-spawn: performance word-boundary + advisory shape fires', 'Should we benchmark our perf to find bottlenecks?', 'perf word + should fires'],
      ['consultant-spawn: architecture trade-off + question fires', 'What are the architecture trade-offs between these two approaches?', 'architecture trade-off + ? fires'],
      ['consultant-spawn: legal + should fires', 'Should we be worried about GDPR compliance here?', 'legal/gdpr + should fires'],
    ];
    for (const [name, prompt, msg] of fires) it(name, () => has(runHook(prompt), 'consultant-spawn enforcement', msg));

    const silent: Array<[string, string, string]> = [
      ["consultant-spawn: 'performance' substring does NOT fire (no advisory shape)", 'The CI pipeline has a performance issue I am debugging', 'bare performance substring must not fire'],
      ["consultant-spawn: 'perform' does NOT fire (not word-bounded 'perf')", 'Please perform the deployment', 'perform must not fire on perf check'],
      ["consultant-spawn: 'perfect' does NOT fire", "That's a perfect solution to the problem", 'perfect must not fire'],
      ['consultant-spawn: domain keyword alone without advisory shape does NOT fire', 'The security module is now updated', 'security statement without ? must not fire'],
    ];
    for (const [name, prompt, msg] of silent) it(name, () => hasNot(runHook(prompt), 'consultant-spawn enforcement', msg));
  });

  describe('search-grounding: decision-anchored patterns', () => {
    const fires: Array<[string, string, string]> = [
      ["search-grounding: 'why did we' fires", 'Why did we choose SQLite over Postgres?', 'why did we must fire'],
      ["search-grounding: 'what did we decide' fires", 'What did we decide about the branching model?', 'what did we decide must fire'],
      ["search-grounding: 'rationale for' fires", 'What was the rationale for using jq here?', 'rationale for must fire'],
    ];
    for (const [name, prompt, msg] of fires) it(name, () => has(runHook(prompt), 'search-grounding hint', msg));

    const silent: Array<[string, string, string]> = [
      ["search-grounding: 'why is' does NOT fire (bare debugging — dropped)", 'Why is the build failing on CI?', "bare 'why is' must not fire"],
      ["search-grounding: 'why was' does NOT fire (bare debugging — dropped)", 'Why was this variable renamed?', "bare 'why was' must not fire"],
      ["search-grounding: 'why are we' does NOT fire", 'Why are we using this library instead of that one?', "bare 'why are we' must not fire"],
    ];
    for (const [name, prompt, msg] of silent) it(name, () => hasNot(runHook(prompt), 'search-grounding hint', msg));
  });

  describe('concerns-protocol: doubt-class phrases', () => {
    it("concerns-protocol: 'delete the test' fires with pointer shape", () => {
      const o = runHook("Can you delete the test that's failing?");
      has(o, 'concerns-protocol hint', 'delete the test fires');
      has(o, 'tmb_concerns-protocol', 'CTX must point to skill, not restate procedure');
      has(
        o,
        "Then follow the protocol: wait for the Human's call, or, when the Human said not to ask, record the concern with the recommended default as kind='decision' and proceed.",
        'the hint names the away path the protocol admits (GH 2713)',
      );
      hasNot(o, 'a documented decision is not a substitute', 'the stale ban on a decision row is gone');
    });

    const fires: Array<[string, string, string]> = [
      ["concerns-protocol: 'force push' fires", 'Just force push the branch', 'force push fires'],
      ["concerns-protocol: 'skip validation' fires", 'Skip validation for this one', 'skip validation fires'],
      ["concerns-protocol: 'bypass the check' fires", 'Can we bypass the check this time?', 'bypass the check fires'],
    ];
    for (const [name, prompt, msg] of fires) it(name, () => has(runHook(prompt), 'concerns-protocol hint', msg));

    const silent: Array<[string, string, string]> = [
      ["concerns-protocol: benign 'delete' does NOT fire", 'Please delete the temp files after the build', 'benign delete must not fire'],
      ["concerns-protocol: benign 'push' does NOT fire", 'Can you push the code when ready?', 'benign push must not fire'],
    ];
    for (const [name, prompt, msg] of silent) it(name, () => hasNot(runHook(prompt), 'concerns-protocol hint', msg));
  });

  describe('DB-backed classes without a DB stay silent', () => {
    const silent: Array<[string, string, string, string]> = [
      ["push-intent: 'git push' with no DB → silent", 'git push origin main', 'push-intent hint', 'push-intent with no DB must be silent'],
      ["push-intent: 'ship it' with no DB → silent", 'ship it', 'push-intent hint', 'ship it with no DB must be silent'],
      ["push-intent: 'ship the code' does NOT fire (not in pattern list)", 'ship the code when ready', 'push-intent hint', 'ship the code is not a push-intent pattern'],
      ["reonboard-intent: 'host on github' with no DB → silent", 'I want to host on github', 'reonboard-intent hint', 'reonboard with no DB must be silent'],
      ["reonboard-intent: '/onboard' in prompt → skipped", '/onboard my project on github', 'reonboard-intent hint', '/onboard prompt must be skipped'],
      ["resume-intent: 'keep going' with no DB → silent", 'keep going on the auth work', 'resume-intent hint', 'resume with no DB must be silent'],
      ["resume-intent: 'still pending' with no DB → silent", 'Any tasks still pending?', 'resume-intent hint', 'still pending with no DB must be silent'],
    ];
    for (const [name, prompt, hint, msg] of silent) it(name, () => hasNot(runHook(prompt), hint, msg));
  });

  describe('adr-required: architectural intent', () => {
    it("adr-required: 'migrate to postgres' fires with pointer shape", () => {
      const o = runHook('We should migrate to postgres this sprint');
      has(o, 'architectural-change hint', 'migrate to postgres fires');
      has(o, 'tmb_planning', 'CTX must point to skill, not restate ADR procedure');
    });

    const fires: Array<[string, string, string]> = [
      ["adr-required: 'plugin architecture' fires", "Let's adopt a plugin architecture for extensibility", 'plugin architecture fires'],
      ["adr-required: 'rewrite ... in' two-token check fires", "Let's rewrite the scanner in Go for speed", 'rewrite ... in fires'],
      ["adr-required: 'port ... to' two-token check fires", 'Can we port the plugin to TypeScript?', 'port ... to fires'],
      ["adr-required: dead literal 'rewrite ... in' glob does NOT false-negative", 'rewrite ... in', "literal 'rewrite ... in' still matches via two-token"],
      ["adr-required: 'replatform' fires", 'We need to replatform the backend service', 'replatform fires'],
      ["adr-required: 'use react instead' fires", 'Should we use React instead of vanilla JS?', 'use react instead fires'],
    ];
    for (const [name, prompt, msg] of fires) it(name, () => has(runHook(prompt), 'architectural-change hint', msg));

    it("adr-required: benign 'port' does NOT fire", () => {
      hasNot(runHook('Open port 8080 in the firewall'), 'architectural-change hint', 'open port N must not fire');
    });
  });

  describe('bypass env vars and exit status', () => {
    const bypass: Array<[string, string, string, string]> = [
      ['TMB_DISABLE_CONCERNS_HINT', 'delete the test that is flaky', 'concerns-protocol hint', 'TMB_DISABLE_CONCERNS_HINT=1 must suppress'],
      ['TMB_DISABLE_ADR_HINT', 'migrate to postgres this sprint', 'architectural-change hint', 'TMB_DISABLE_ADR_HINT=1 must suppress'],
      ['TMB_DISABLE_SEARCH_HINT', 'why did we choose sqlite?', 'search-grounding hint', 'TMB_DISABLE_SEARCH_HINT=1 must suppress'],
    ];
    const label: Record<string, string> = {
      TMB_DISABLE_CONCERNS_HINT: 'concerns-protocol',
      TMB_DISABLE_ADR_HINT: 'adr-required',
      TMB_DISABLE_SEARCH_HINT: 'search-grounding',
    };
    for (const [key, prompt, hint, msg] of bypass) {
      it(`${key}=1 suppresses ${label[key]}`, () => hasNot(runHookEnv(prompt, { [key]: '1' }), hint, msg));
    }

    it('hook exits 0 on all inputs', () => {
      for (const prompt of ['', 'ls', 'why is this slow', 'delete the test', 'migrate to postgres', 'git push']) {
        assert.equal(runRaw(prompt, sb.dir, NO_DB).status, 0, `hook exited non-zero for prompt: ${prompt}`);
      }
    });
  });

  describe('GH 1199: harness hand-back turns are silent; hints read only unquoted text', () => {
    const framings = [
      '<task-notification>swe finished; git push origin feat/done next; port the parser to Rust</task-notification>',
      '[SYSTEM NOTIFICATION - NOT USER INPUT] still open: push it',
      'Another Claude session sent a message: push it, keep going',
      '[Subagent hand-back] swe: done. Next: git push origin feat/done; tasks still open.',
      '<agent-message from="swe">rewrite the scanner in Go; push it</agent-message>',
      '<cross-session-message from="bro">ship it and keep going</cross-session-message>',
    ];
    for (const framing of framings) {
      it(`GH 1199: hand-back framing is silent: ${framing.slice(0, 40)}`, () => {
        assert.equal(runHookDb(framing), '', 'a harness turn emits no hint');
      });
    }

    it("GH 1199: 'report the result to the user' → no architectural hint", () => {
      hasNot(runHook('report the result to the user'), 'architectural-change hint', 'report … to is not port … to');
    });

    it("GH 1199: 'port the parser to Rust' → architectural hint", () => {
      has(runHook('port the parser to Rust'), 'architectural-change hint', 'port within 6 words of to');
    });

    it("GH 1199: 'port' too far from 'to' → no architectural hint", () => {
      hasNot(runHook('port number nine on the old box was later moved to staging'), 'architectural-change hint', 'more than 6 words apart');
    });

    it('GH 1199: a quoted git push inside a report → no push hint', () => {
      hasNot(
        runHookDb('The guard said "BLOCKED: run git push from the main checkout" — what does that mean?'),
        'push-intent hint',
        'quoted hook text is not push intent',
      );
      hasNot(runHookDb('what does `git push --force-with-lease` do?'), 'push-intent hint', 'backticked command is not push intent');
    });

    it("GH 1199: 'push it' → push hint", () => {
      const o = runHookDb('looks good, push it');
      has(o, 'push-intent hint', 'unquoted push intent fires');
      has(o, 'feat/done', 'the unsigned task is listed');
      has(
        o,
        'spawn code-reviewer per pending task with the `reviewer_spawn` Agent call review_handoff returned, passed as is (its prompt carries the anchors the spawn gates require), per tmb_push-gate; bro_atomic_close closes each task once it passes.',
        'push hint spawns code-reviewer with the reviewer_spawn call review_handoff returned (GH 2743)',
      );
      hasNot(o, "prompt='task_id=<N>'", 'no bare task_id spawn prompt the anchor gates deny (GH 2743)');
      hasNot(o, 'isolation=', 'no empty isolation argument');
    });

    it("GH 1199: 'still open' inside a quoted report → no resume hint", () => {
      hasNot(runHookDb("swe said 'two tasks still open' — is that right?"), 'resume-intent hint', 'quoted report text is not resume intent');
    });

    it("GH 1199: unquoted 'keep going' → resume hint", () => {
      const o = runHookDb('keep going');
      has(o, 'resume-intent hint', 'unquoted resume intent fires');
      has(o, 'task_reopen(task_id=2', 'resume hint routes the pending task through task_reopen');
      has(o, "Agent(subagent_type='swe', effort='<tasks.effort>', prompt='task_id=2')", 'resume hint spawns swe with its effort');
      hasNot(o, 'git switch', 'resume hint never switches the main checkout');
    });

    it('resume hint: each field parsed whole, a | in title or objective included', () => {
      sql(hintDb, "UPDATE tasks SET title = 'next | task' WHERE id = 2");
      sql(hintDb, "UPDATE issues SET objective = 'auth | work' WHERE id = 1");
      try {
        const o = runHookDb('keep going');
        has(o, 'task_reopen(task_id=2, reason', 'task_id is the bare id');
        has(o, 'branch_id=feat/next', 'branch_id parsed');
        has(o, "title='next / task'", 'a | in the title is shown as /');
        has(o, "issue.objective='auth | work'", 'the objective keeps its |');
      } finally {
        sql(hintDb, "UPDATE tasks SET title = 'next task' WHERE id = 2");
        sql(hintDb, "UPDATE issues SET objective = 'auth work' WHERE id = 1");
      }
    });
  });

  describe('onboarded project: reonboard-intent and headless-intent', () => {
    before(() => sql(hintDb, "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')"));

    it("reonboard-intent: 'switch to gitflow' on an onboarded project → hint names onboard_state_get", () => {
      const o = runHookDb("I want to switch to gitflow — what's the right way to reconfigure?");
      has(o, 'reonboard-intent hint', 'branching-model switch fires');
      has(o, 'onboard_state_get', 'CTX names the required first action');
    });

    it("reonboard-intent: 'change pr target to main' fires", () => {
      has(runHookDb('change pr target to main'), 'reonboard-intent hint', 'PR-target change fires');
    });

    it("reonboard-intent: 'gitflow is a popular model' does NOT fire", () => {
      hasNot(runHookDb('gitflow is a popular model'), 'reonboard-intent hint', 'no verb phrase, no hint');
    });

    it("headless-intent: 'claude -p' on an onboarded project → consent hint names the settings file", () => {
      const o = runHookDb('how do I run this under `claude -p` in CI?');
      has(o, 'headless-intent hint', 'claude -p fires');
      has(o, '.claude/settings.local.json', 'CTX names the file the shim writes');
      has(o, "headless_enforcement='yes'", 'CTX names the apply call');
    });

    it('headless-intent: TMB_DISABLE_HEADLESS_HINT=1 suppresses', () => {
      hasNot(runHookDb('run it with claude -p', { TMB_DISABLE_HEADLESS_HINT: '1' }), 'headless-intent hint', 'TMB_DISABLE_HEADLESS_HINT=1 must suppress');
    });

    it('headless-intent: a /onboard prompt is silent', () => {
      hasNot(runHookDb('/onboard — I want gates in headless runs too'), 'headless-intent hint', '/onboard prompt must be skipped');
    });

    it("headless-intent: 'the main circuit' does NOT fire (whole words)", () => {
      hasNot(runHookDb('the main circuit board'), 'headless-intent hint', 'in ci needs word boundaries');
    });

    it('GH 1751: a question about quoted claude -p is not headless intent', () => {
      hasNot(
        runHookDb('What is the L0 success criteria? I thought it should be claude -p "@bro health check" and everything is green?'),
        'headless-intent hint',
        'a question naming claude -p stays silent',
      );
    });

    it('GH 1751: claude -p only inside backticks is not headless intent', () => {
      hasNot(runHookDb('I ran `claude -p` yesterday.'), 'headless-intent hint', 'a quoted claude -p stays silent');
    });

    it('GH 1751: stated headless intent still fires', () => {
      has(runHookDb('set up claude -p for CI'), 'headless-intent hint', 'an unquoted statement fires');
      has(runHookDb('make the gates work headless'), 'headless-intent hint', 'headless in a statement fires');
    });

    it('headless-intent: headless_enforcement already yes → silent', () => {
      sql(hintDb, "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('headless_enforcement', '\"yes\"')");
      try {
        hasNot(runHookDb('run it with claude -p'), 'headless-intent hint', 'an enabled project needs no hint');
      } finally {
        sql(hintDb, "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('headless_enforcement', '\"no\"')");
      }
    });

    it("GH 1199: quoted 'skip validation' → no concerns hint; unquoted → hint", () => {
      hasNot(runHook('the log line "skip validation: off" confused me'), 'concerns-protocol hint', 'quoted text is not a doubt-class request');
      has(runHook('skip validation for this one'), 'concerns-protocol hint', 'unquoted doubt-class request fires');
    });
  });

  describe('audit-intent: whole-word audit / verify / check / double-check / architecture', () => {
    for (const prompt of [
      'audit the trajectory DB writes',
      'verify that the scraper output is right',
      'check the job-post extractor',
      'double-check the importer for me',
      'walk me through the architecture of the scanner',
    ]) {
      it(`audit-intent: '${prompt}' fires`, () => {
        const o = runHook(prompt);
        has(o, 'audit-intent hint', 'audit keyword fires');
        has(o, 'tmb_audit', 'hint names tmb_audit');
        has(o, 'outputs-first', 'hint asks for outputs-first work');
      });
    }

    it("audit-intent: 'verification' alone does NOT fire (whole word)", () => {
      hasNot(runHook('the verification step looks slow today'), 'audit-intent hint', 'verification is not verify');
    });

    it("audit-intent: quoted 'audit' does NOT fire", () => {
      hasNot(runHook('the log line "audit row written" confused me'), 'audit-intent hint', 'quoted text is not audit intent');
    });

    const bashTurn = '<bash-input>make check</bash-input><bash-stdout>check passed</bash-stdout><bash-stderr>check warning</bash-stderr>';

    it("bash-turn: '!' shell-turn spans alone emit no hint (GH 1598)", () => {
      hasNot(runHook(bashTurn), 'additionalContext', 'shell input/output is not Human intent');
    });

    it('bash-turn: typed text alongside the spans still fires the audit hint', () => {
      has(runHook(`${bashTurn}\nplease check the audit`), 'audit-intent hint', 'typed text outside the spans is still matched');
    });

    it('bash-turn: multi-line stdout span is stripped', () => {
      hasNot(
        runHook('<bash-input>ls</bash-input><bash-stdout>line one\nplease check the audit\nline three</bash-stdout><bash-stderr></bash-stderr>'),
        'additionalContext',
        'multi-line stdout must be stripped whole',
      );
    });

    it("adr-required: 'report back to me' does NOT fire", () => {
      hasNot(runHook('report back to me when it is done'), 'architectural-change hint', 'report … to is not port … to');
    });

    it('TMB_DISABLE_AUDIT_HINT=1 suppresses audit-intent', () => {
      hasNot(runHookEnv('audit the importer', { TMB_DISABLE_AUDIT_HINT: '1' }), 'audit-intent hint', 'TMB_DISABLE_AUDIT_HINT=1 must suppress');
    });
  });
});

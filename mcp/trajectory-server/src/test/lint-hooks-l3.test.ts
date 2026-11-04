/**
 * code-quality-lint, commit-msg-lint and naming-lint end to end (GH 1692), the
 * advisory PreToolUse gates:
 *   1. code-quality-lint flags bare except, except Exception, f-string and
 *      template-string SQL, utcnow, mutable defaults, catch (e: any) and TODOs
 *      in a source file's new text, and skips other tools, non-source files,
 *      fixtures paths and TMB_SKIP_CQ_LINT=1;
 *   2. commit-msg-lint flags a git commit subject with no emoji, an unknown
 *      type or over 72 chars, reads the subject from the real argv (GH 1196),
 *      and skips amend, fixup, heredoc messages and TMB_SKIP_COMMIT_MSG_LINT=1;
 *   3. naming-lint flags a new file whose basename breaks its language's
 *      convention, and skips existing files, exempt names, node_modules and
 *      TMB_SKIP_NAMING_LINT=1.
 * Each case runs `node dist/hooks.js <hook>` with CLAUDE_PROJECT_DIR pinned to a sandbox.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { jsonValues, makeSandbox, runGate, type Sandbox } from './hook-sandbox.js';

let sb: Sandbox;
before(() => {
  sb = makeSandbox('lint-hooks-l3');
});
after(() => sb.remove());

function run(gate: string, payload: unknown, env: NodeJS.ProcessEnv = {}): string {
  const r = runGate(gate, { cwd: sb.dir, env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, ...env }, input: JSON.stringify(payload) });
  return r.stdout + r.stderr;
}

const eventOf = (out: string) =>
  (jsonValues(out)[0] as { hookSpecificOutput?: { hookEventName?: string } } | undefined)?.hookSpecificOutput?.hookEventName;

const write = (path: string, content: string) => ({ tool_name: 'Write', tool_input: { file_path: path, content } });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

describe('code-quality-lint', () => {
  const GATE = 'code-quality-lint';
  const at = (name: string) => join(sb.dir, name);

  it('a Bash tool call is silent', () => {
    assert.equal(run(GATE, bash('ls')), '');
  });

  it('TMB_SKIP_CQ_LINT=1 bypasses the hook', () => {
    assert.equal(run(GATE, write(at('foo.py'), 'except:'), { TMB_SKIP_CQ_LINT: '1' }), '');
  });

  for (const name of ['README.md', 'deploy.sh']) {
    it(`${name} is not a source file and is ignored`, () => {
      assert.equal(run(GATE, write(at(name), 'except:')), '');
    });
  }

  for (const [label, file, content, phrase] of [
    ['Python bare except', 'foo.py', 'try:\n    pass\nexcept:\n    pass', "bare 'except:'"],
    ['Python except Exception', 'foo.py', 'try:\n    pass\nexcept Exception as e:\n    pass', 'except Exception'],
    ['Python f-string SQL', 'foo.py', 'query = f"SELECT * FROM users WHERE id = {user_id}"', 'f-string SQL'],
    ['Python datetime.utcnow()', 'foo.py', 'now = datetime.utcnow()', 'utcnow'],
    ['Python mutable default list arg', 'foo.py', 'def process(items=[]):\n    pass', 'mutable default argument'],
    ['TS catch (e: any)', 'foo.ts', 'try { } catch (e: any) { console.log(e); }', 'catch (e: any)'],
    ['TS template-string SQL', 'foo.ts', 'const q = `SELECT * FROM users WHERE id = ${id}`;', 'template-string SQL'],
    ['a TODO comment in a .ts file', 'foo.ts', '// TODO: fix this later', 'TODO/FIXME/HACK'],
  ] as const) {
    it(`${label} emits an advisory naming it`, () => {
      const out = run(GATE, write(at(file), content));
      assert.ok(out.includes('additionalContext'), out);
      assert.ok(out.includes(phrase), out);
    });
  }

  it('a clean Python file is silent', () => {
    assert.equal(run(GATE, write(at('foo.py'), 'def process(items=None):\n    if items is None:\n        items = []\n    return items')), '');
  });

  it('a fixtures path is skipped even with violations', () => {
    assert.equal(run(GATE, write(at('fixtures/foo.py'), 'except:')), '');
  });

  it('a MultiEdit with a bare except in an edit new_string emits an advisory', () => {
    const out = run(GATE, {
      tool_name: 'MultiEdit',
      tool_input: { file_path: at('foo.py'), edits: [{ old_string: 'pass', new_string: 'except:\n    pass' }] },
    });
    assert.ok(out.includes('additionalContext'), out);
  });

  it('the advisory is JSON with hookEventName PreToolUse', () => {
    assert.equal(eventOf(run(GATE, write(at('foo.py'), 'except:'))), 'PreToolUse');
  });
});

describe('commit-msg-lint', () => {
  const GATE = 'commit-msg-lint';

  it('a non-Bash tool call is silent', () => {
    assert.equal(run(GATE, { tool_name: 'Read', tool_input: { file_path: join(sb.dir, 'foo') } }), '');
  });

  it('a Bash command that is not a commit is silent', () => {
    assert.equal(run(GATE, bash('ls -la')), '');
  });

  it('TMB_SKIP_COMMIT_MSG_LINT=1 bypasses the hook', () => {
    assert.equal(run(GATE, bash("git commit -m 'bad message no emoji'"), { TMB_SKIP_COMMIT_MSG_LINT: '1' }), '');
  });

  for (const [label, command] of [
    ['an emoji + type message', "git commit -m '✨ feat(auth): add JWT refresh endpoint'"],
    ['a colon-shortcode emoji + type message', "git commit -m ':bug: fix(db): prevent null pointer in query'"],
    ['--amend --no-edit', 'git commit --amend --no-edit'],
    ['--fixup', 'git commit --fixup=HEAD'],
    ['a heredoc message it cannot inspect', String.raw`git commit -m "$(cat <<EOF\nmy msg\nEOF\n)"`],
    ['GH 1196: a markdown heredoc mentioning git commit', ["cat > notes.md <<'EOF'", "Run git commit -m 'bad message' then gh pr merge 1.", 'EOF', ''].join('\n')],
    ['GH 1196: an echo of a git commit line', `echo "git commit -m 'bad message'"`],
    ['GH 1196: a valid first -m with a later body -m', "git -C /w commit -m '✨ feat(x): add y' -m 'body line that is not a subject'"],
  ] as const) {
    it(`${label} is silent`, () => {
      assert.equal(run(GATE, bash(command)), '');
    });
  }

  it('a subject with no emoji emits an advisory naming the hook', () => {
    const out = run(GATE, bash("git commit -m 'feat(auth): add refresh endpoint'"));
    assert.ok(out.includes('additionalContext'), out);
    assert.ok(out.includes('commit-msg-lint'), out);
  });

  it('an unknown type emits an advisory', () => {
    assert.ok(run(GATE, bash("git commit -m '🔥 update(auth): change something'")).includes('additionalContext'));
  });

  it('a subject over 72 chars emits an advisory naming >72', () => {
    const long = '🐛 fix(auth): this is a very long commit message that exceeds seventy-two characters total';
    const out = run(GATE, bash(`git commit -m '${long}'`));
    assert.ok(out.includes('additionalContext'), out);
    assert.ok(out.includes('>72'), out);
  });

  it('the advisory is JSON with hookEventName PreToolUse', () => {
    assert.equal(eventOf(run(GATE, bash("git commit -m 'bad message without emoji or type'"))), 'PreToolUse');
  });

  it('GH 1196: a real commit after a heredoc is linted on its own -m', () => {
    const out = run(GATE, bash(["cat > notes.md <<'EOF'", '✨ feat(x): fine', 'EOF', "git commit -m 'bad subject'", ''].join('\n')));
    assert.ok(out.includes('Subject seen: \\"bad subject\\"'), out);
  });
});

describe('naming-lint', () => {
  const GATE = 'naming-lint';
  const at = (name: string) => join(sb.dir, name);
  const newFile = (name: string) => write(at(name), 'x');

  it('a Bash tool call is silent', () => {
    assert.equal(run(GATE, bash('ls')), '');
  });

  it('TMB_SKIP_NAMING_LINT=1 bypasses the hook', () => {
    assert.equal(run(GATE, newFile('BadName.py'), { TMB_SKIP_NAMING_LINT: '1' }), '');
  });

  it('an existing file is skipped even when its name is wrong', () => {
    writeFileSync(at('BadFile.py'), '');
    assert.equal(run(GATE, newFile('BadFile.py')), '');
  });

  for (const [label, name] of [
    ['snake_case .py', 'my_module.py'],
    ['kebab-case .ts', 'my-module.ts'],
    ['kebab-case .sh', 'my-script.sh'],
    ['snake_case .sql', 'create_table.sql'],
    ['PascalCase .tsx (a React component)', 'MyComponent.tsx'],
    ['kebab-case .tsx (a route or hook)', 'use-auth.tsx'],
    ['__init__.py', '__init__.py'],
    ['index.ts', 'index.ts'],
    ['a node_modules path', 'node_modules/BadName.ts'],
    ['a kebab base before .test.sh', 'some-hook.test.sh'],
    ['another kebab base before .test.sh', 'other-lint.test.sh'],
  ] as const) {
    it(`${label} is silent`, () => {
      assert.equal(run(GATE, newFile(name)), '');
    });
  }

  for (const [label, name, phrase] of [
    ['PascalCase .py', 'MyModule.py', 'snake_case'],
    ['camelCase .ts', 'myModule.ts', 'kebab-case'],
    ['snake_case .sh', 'my_script.sh', 'kebab-case'],
    ['camelCase .sql', 'createTable.sql', ''],
    ['a snake_case base before .test.sh', 'my_script.test.sh', ''],
  ] as const) {
    it(`${label} emits an advisory`, () => {
      const out = run(GATE, newFile(name));
      assert.ok(out.includes('additionalContext'), out);
      assert.ok(out.includes(phrase), out);
    });
  }

  it('the advisory is JSON with hookEventName PreToolUse', () => {
    assert.equal(eventOf(run(GATE, newFile('BadModule.ts'))), 'PreToolUse');
  });
});

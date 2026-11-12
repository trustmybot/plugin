import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyChange,
  classifyPath,
  PATH_CLASSES_FILE,
  proposePathClasses,
  readPathClasses,
  type PathClasses,
} from '../path-classes.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function committedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'path-classes-'));
  dirs.push(dir);
  const git = (...a: string[]): void => {
    const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
  };
  for (const [p, body] of Object.entries({ 'src/app.ts': 'export {};\n', ...files })) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return dir;
}

const CLASSES: PathClasses = {
  docs: { paths: ['docs/**/*.md', 'README.md'] },
  prompts: { paths: ['CLAUDE.md', '.claude/skills/**/*.md', 'agents/**/*.md'], rubric: ['guide/RUBRIC.txt'] },
};
const CATCH_ALL_DOCS: PathClasses = { docs: { paths: ['**'] }, prompts: CLASSES.prompts };

describe('readPathClasses (GH 3074)', () => {
  it('no file at a resolving ref is { classes: null }, and every change is code', () => {
    const dir = committedRepo({ 'README.md': '# x\n', 'CLAUDE.md': 'be nice\n' });
    const read = readPathClasses(dir, 'main');
    assert.deepEqual(read, { classes: null });
    assert.ok('classes' in read);
    const { classes } = read;
    for (const paths of [['README.md'], ['CLAUDE.md'], ['README.md', 'CLAUDE.md'], ['src/app.ts'], []]) {
      assert.equal(classifyChange(paths, classes), 'code', JSON.stringify(paths));
    }
    assert.equal(classifyPath('README.md', null), 'code');
    assert.deepEqual(readPathClasses(null, 'main'), { classes: null });
    assert.deepEqual(readPathClasses(dir, null), { classes: null });
  });

  it('reads the committed file, not the working tree', () => {
    const file = { version: 1, docs: { paths: ['docs/**/*.md'] }, prompts: { paths: ['CLAUDE.md'] } };
    const dir = committedRepo({ [PATH_CLASSES_FILE]: JSON.stringify(file) });
    writeFileSync(join(dir, PATH_CLASSES_FILE), '{not json');
    assert.deepEqual(readPathClasses(dir, 'main'), {
      classes: { docs: { paths: ['docs/**/*.md'] }, prompts: { paths: ['CLAUDE.md'], rubric: [] } },
    });
  });

  it('a malformed file is { error } naming the problem', () => {
    const cases: Array<[string, RegExp]> = [
      ['{not json', /not valid JSON/],
      ['[]', /must be a JSON object/],
      ['{"version":2}', /version must be 1, got 2/],
      ['{"version":1,"doc":{"paths":[]}}', /unknown key doc/],
      ['{"version":1,"docs":{"paths":"docs/**"}}', /docs must be \{"paths":\[globs\]\}/],
      ['{"version":1,"docs":{"paths":[""]}}', /docs must be/],
      ['{"version":1,"prompts":{"rubric":[]}}', /prompts must be/],
      ['{"version":1,"prompts":{"paths":[],"rubric":[3]}}', /prompts must be/],
    ];
    for (const [body, expected] of cases) {
      const dir = committedRepo({ [PATH_CLASSES_FILE]: body });
      const read = readPathClasses(dir, 'main');
      assert.ok('error' in read, `${body} → ${JSON.stringify(read)}`);
      assert.match(read.error, expected, body);
    }
  });

  it('an unresolvable ref is { error }', () => {
    const dir = committedRepo({});
    const read = readPathClasses(dir, 'no-such-branch');
    assert.ok('error' in read && /cannot resolve no-such-branch/.test(read.error), JSON.stringify(read));
  });
});

describe('classifyPath and classifyChange (GH 3074)', () => {
  it('classes a change as docs, prompts, mixed or code', () => {
    const cases: Array<[string[], string]> = [
      [['docs/a.md', 'README.md'], 'docs'],
      [['CLAUDE.md', 'agents/swe.md'], 'prompts'],
      [['docs/a.md', 'CLAUDE.md'], 'prompts'],
      [['src/app.ts', 'docs/a.md'], 'mixed'],
      [['src/app.ts', 'CLAUDE.md'], 'mixed'],
      [['src/app.ts', 'src/b.ts'], 'code'],
      [[], 'code'],
    ];
    for (const [paths, expected] of cases) assert.equal(classifyChange(paths, CLASSES), expected, JSON.stringify(paths));
  });

  it('a rubric file is prompts', () => {
    assert.equal(classifyPath('guide/RUBRIC.txt', CLASSES), 'prompts');
    assert.equal(classifyChange(['guide/RUBRIC.txt', 'README.md'], CLASSES), 'prompts');
    assert.equal(classifyPath('guide/OTHER.txt', CLASSES), 'code');
  });

  it('prompts win over docs on overlap', () => {
    assert.equal(classifyPath('CLAUDE.md', CATCH_ALL_DOCS), 'prompts', 'docs ** also matches it');
  });

  it('the classes file itself is code even when a docs ** glob matches it', () => {
    assert.equal(classifyPath('src/app.ts', CATCH_ALL_DOCS), 'docs', 'the ** docs glob matches everything else');
    assert.equal(classifyPath(PATH_CLASSES_FILE, CATCH_ALL_DOCS), 'code');
    assert.equal(classifyPath(`./${PATH_CLASSES_FILE}`, CATCH_ALL_DOCS), 'code');
    assert.equal(classifyPath(`docs/../${PATH_CLASSES_FILE}`, CATCH_ALL_DOCS), 'code');
    assert.equal(classifyChange(['README.md', PATH_CLASSES_FILE], CATCH_ALL_DOCS), 'mixed');
  });

  it('paths outside the repo are code', () => {
    assert.equal(classifyPath('/etc/README.md', CATCH_ALL_DOCS), 'code');
    assert.equal(classifyPath('../other/README.md', CATCH_ALL_DOCS), 'code');
  });

  it('dot-directory paths match their glob', () => {
    assert.equal(classifyPath('.claude/skills/x/SKILL.md', CLASSES), 'prompts');
    assert.equal(classifyPath('.claude/agents/x.md', CLASSES), 'code');
    const dotDocs: PathClasses = { docs: { paths: ['**/*.md'] }, prompts: null };
    assert.equal(classifyPath('.github/ISSUE_TEMPLATE/bug.md', dotDocs), 'docs');
  });
});

describe('proposePathClasses (GH 3074)', () => {
  it('proposes nothing for a repo with only code', () => {
    assert.deepEqual(proposePathClasses(['src/app.ts', 'package.json']), { docs: null, prompts: null });
  });

  it('proposes only the conventions the file list shows', () => {
    const files = [
      '.claude-plugin/plugin.json',
      '.claude/agents/a.md',
      '.claude/commands/c.md',
      'AGENTS.md',
      'CLAUDE.md',
      'CONTRIBUTING.md',
      'README.md',
      'changelog.d/1-x.md',
      'doc/notes.txt',
      'documentation/guide/intro.md',
      'skills/s/SKILL.md',
      'src/CLAUDE.md',
      'src/app.ts',
    ];
    assert.deepEqual(proposePathClasses(files), {
      docs: { paths: ['documentation/**/*.md', 'CONTRIBUTING.md', 'README.md', 'changelog.d/**'] },
      prompts: {
        paths: ['CLAUDE.md', 'AGENTS.md', '**/CLAUDE.md', '.claude/agents/**/*.md', '.claude/commands/**/*.md', 'skills/**/*.md'],
        rubric: [],
      },
    });
  });

  it('plugin prompt dirs count only with a plugin manifest', () => {
    assert.deepEqual(proposePathClasses(['agents/a.md', 'skills/s/SKILL.md', 'commands/c.md']), { docs: null, prompts: null });
  });
});

describe("this repo's own path classes (GH 3074)", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

  it('parse and declare the prompt-engineering guides as the rubric', () => {
    const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(head.status, 0, head.stderr);
    const read = readPathClasses(repoRoot, head.stdout.trim());
    const working = JSON.parse(readFileSync(join(repoRoot, PATH_CLASSES_FILE), 'utf8')) as { prompts: { rubric: string[] } };
    assert.ok(!('error' in read), JSON.stringify(read));
    assert.ok(read.classes, `${PATH_CLASSES_FILE} is committed`);
    assert.deepEqual(read.classes.prompts?.rubric, working.prompts.rubric);
    for (const rubric of read.classes.prompts?.rubric ?? []) {
      assert.equal(classifyPath(rubric, read.classes), 'prompts', rubric);
      assert.ok(readFileSync(join(repoRoot, rubric), 'utf8').length > 0, `${rubric} exists`);
    }
    assert.equal(read.classes.prompts?.rubric.length, 2);
  });

  it('path-classes.ts and onboard.ts name none of its paths', () => {
    const src = join(repoRoot, 'mcp', 'trajectory-server', 'src');
    const read = JSON.parse(readFileSync(join(repoRoot, PATH_CLASSES_FILE), 'utf8')) as { prompts: { rubric: string[] } };
    for (const file of ['path-classes.ts', join('tools', 'onboard.ts')]) {
      const body = readFileSync(join(src, file), 'utf8');
      for (const own of [...read.prompts.rubric, 'templates/**', 'CONTRIBUTING.md', 'SECURITY.md', 'prompt-engineering']) {
        assert.equal(body.includes(own), false, `${file} names ${own}`);
      }
    }
  });
});

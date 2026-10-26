import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPurpose,
  isPurposeCandidate,
  normalizePurpose,
  PURPOSE_MAX_CHARS,
  purposeFromSymbols,
  type PurposeSource,
  type PurposeSymbol,
} from '../file-purpose.js';
import { refreshSymbolPurposes } from '../symbol-purpose.js';
import { tempDB } from './helpers.js';

function expectPurpose(path: string, head: string, source: PurposeSource, purpose: string): void {
  const got = extractPurpose(path, head);
  assert.equal(got.source, source, `${path}: source`);
  assert.ok(got.purpose.length > 0, `${path}: purpose is populated`);
  assert.equal(got.purpose, purpose, `${path}: purpose`);
}

describe('extractPurpose — deterministic per-file purpose', () => {
  it('reads a python module docstring after a shebang and coding comment', () => {
    expectPurpose(
      'tools/sync.py',
      '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n"""Sync the local mirror with the\nupstream registry.\n\nLonger notes.\n"""\nimport os\n',
      'docstring',
      'Sync the local mirror with the upstream registry.',
    );
  });

  it('reads the first // comment block of a ts file, stopping at the first sentence', () => {
    expectPurpose(
      'src/graph.ts',
      '// World-model graph wrapper over the SQLite\n// wm_ tables. See ADR 0002.\nimport x from "y";\n',
      'comment',
      'World-model graph wrapper over the SQLite wm_ tables.',
    );
  });

  it('skips a license line and reads a /* */ block', () => {
    expectPurpose(
      'lib/index.js',
      '// SPDX-License-Identifier: MIT\n\n/*\n * Router for inbound webhook events\n */\nexport {};\n',
      'comment',
      'Router for inbound webhook events',
    );
  });

  it('prefers a JSDoc @file tag over the first comment block', () => {
    expectPurpose(
      'src/cli.mjs',
      '// eslint-disable-next-line\n// generic banner text here.\n/**\n * @file Command-line entry point for the bundler.\n * @author someone\n */\n',
      'jsdoc',
      'Command-line entry point for the bundler.',
    );
  });

  it('reads a @fileoverview whose text sits on the following lines', () => {
    expectPurpose(
      'src/a.ts',
      '/**\n * @fileoverview\n * Parses spec bodies into sections.\n */\n',
      'jsdoc',
      'Parses spec bodies into sections.',
    );
  });

  it('reads the # comment block after a shell shebang, skipping shellcheck directives', () => {
    expectPurpose(
      'scripts/build.sh',
      '#!/usr/bin/env bash\n# shellcheck disable=SC2034\n# Deterministic project scanner for the world model.\n# More detail.\nset -euo pipefail\n',
      'comment',
      'Deterministic project scanner for the world model.',
    );
  });

  it('reads a -- comment from a sql file', () => {
    expectPurpose('db/schema.sql', '-- Trajectory DB schema: issues, tasks, audit.\nCREATE TABLE x (id INT);\n', 'comment', 'Trajectory DB schema: issues, tasks, audit.');
  });

  it('reads a markdown frontmatter description, plain and folded', () => {
    expectPurpose(
      'skills/x/SKILL.md',
      '---\nname: x\ndescription: "Walks bro through planning. Extra."\n---\n# Planning\n\nBody.\n',
      'frontmatter',
      'Walks bro through planning.',
    );
    expectPurpose(
      'agents/swe.md',
      '---\nname: swe\ndescription: >\n  The executor that implements\n  one task spec.\n---\n',
      'frontmatter',
      'The executor that implements one task spec.',
    );
  });

  it('falls back to the first H1 plus the first paragraph sentence for markdown', () => {
    expectPurpose(
      'docs/WORLD_MODEL.md',
      '# World Model\n\n[![badge](x.svg)](y)\n\nBro is the **architect** of every project. It builds a map.\n\n## Schema\n',
      'heading',
      'World Model — Bro is the architect of every project.',
    );
  });

  it('reads a manifest description, even from a head cut mid-file', () => {
    expectPurpose('package.json', '{\n  "name": "x",\n  "description": "Trajectory MCP server."\n}\n', 'manifest', 'Trajectory MCP server.');
    expectPurpose(
      '.claude-plugin/plugin.json',
      '{ "name": "tmb", "description": "Orchestrator plugin for Claude Code.", "hooks": [ "a", ',
      'manifest',
      'Orchestrator plugin for Claude Code.',
    );
  });

  it('returns none for binary heads, empty heads and unmatched shapes', () => {
    assert.deepEqual(extractPurpose('logo.png', '\x89PNG\r\n\x1a\n\0\0\0'), { purpose: '', source: 'none' });
    assert.deepEqual(extractPurpose('src/a.ts', 'abc\0def'), { purpose: '', source: 'none' });
    assert.deepEqual(extractPurpose('src/empty.ts', ''), { purpose: '', source: 'none' });
    assert.deepEqual(extractPurpose('src/blank.py', '\n\n  \n'), { purpose: '', source: 'none' });
    assert.deepEqual(extractPurpose('src/code.ts', 'import x from "y";\n// late comment\n'), { purpose: '', source: 'none' });
    assert.deepEqual(extractPurpose('README', 'Plain text.'), { purpose: '', source: 'none' });
  });

  it('caps a sentence-free purpose at 200 chars and cuts at the first sentence end', () => {
    const long = `// ${'word '.repeat(80)}\n`;
    const got = extractPurpose('src/long.ts', long);
    assert.equal(got.source, 'comment');
    assert.ok(got.purpose.length > 0 && got.purpose.length <= PURPOSE_MAX_CHARS, `capped: ${got.purpose.length}`);
    assert.ok(got.purpose.endsWith('…'));
    assert.equal(normalizePurpose('First one.  Second one.'), 'First one.');
    assert.equal(normalizePurpose('Uses e.g. small steps. Then more.'), 'Uses e.g. small steps.');
  });

  it('only reads heads for extension shapes it can extract', () => {
    assert.equal(isPurposeCandidate('a/b.ts'), true);
    assert.equal(isPurposeCandidate('a/package.json'), true);
    assert.equal(isPurposeCandidate('a/Page.tsx'), true);
    for (const p of ['a/data.json', 'a/ci.yml', 'a/ci.yaml', 'a/notes.txt']) assert.equal(isPurposeCandidate(p), true, p);
    assert.equal(isPurposeCandidate('a/logo.png'), false);
    assert.equal(isPurposeCandidate('a/rows.jsonl'), false);
  });
});

describe('extractPurpose — header extraction for tsx', () => {
  it('reads a // header and a JSDoc @file from a tsx file', () => {
    expectPurpose('web/TaskPage.tsx', '// The task page: one task and its runs.\nexport function TaskPage() {}\n', 'comment', 'The task page: one task and its runs.');
    expectPurpose('web/App.tsx', '/**\n * @file Dashboard shell and routes.\n */\n', 'jsdoc', 'Dashboard shell and routes.');
  });
});

describe('extractPurpose — structural fallback for data files', () => {
  it('json: $schema / name / description when present, else the top-level keys, even from a cut head', () => {
    expectPurpose(
      'hooks/schema.json',
      '{\n  "$schema": "https://json.schemastore.org/claude-code-hooks.json",\n  "name": "tmb-hooks",\n  "hooks": {"a": 1}\n}\n',
      'structural',
      'tmb-hooks (schema json.schemastore.org/claude-code-hooks.json)',
    );
    expectPurpose('a/meta.json', '{"name": "corpus", "description": "Write-path probes. More text."}', 'structural', 'corpus: Write-path probes.');
    expectPurpose('a/s.json', '{"$schema": "http://json-schema.org/draft-07/schema#", "type": "object"}', 'structural', 'schema json-schema.org/draft-07/schema');
    expectPurpose(
      'tests/l5-l6/rows/05/script.json',
      '{\n  "max_turns": 1,\n  "user_after_bro": [{"name": "nested"}],\n  "terminal_pattern": "task closed',
      'structural',
      'keys: max_turns, user_after_bro, terminal_pattern',
    );
    expectPurpose('a/rows.json', '[{"id": 1, "label": "x"}, {"other": 2}]', 'structural', 'items with keys: id, label');
    expectPurpose('rows/tools-required.json', '[\n  "mcp__tmb__branch_id_propose",\n  "Bash"\n]', 'structural', 'items: mcp__tmb__branch_id_propose, Bash');
    assert.deepEqual(extractPurpose('a/empty.json', '{}'), { purpose: '', source: 'none' });
    assert.deepEqual(extractPurpose('a/none.json', '[]'), { purpose: '', source: 'none' });
  });

  it('a manifest with no description falls back to its name', () => {
    expectPurpose('package.json', '{"name": "@acme/app", "version": "1.0.0"}', 'structural', '@acme/app');
  });

  it('yml: name and description when present, else the top-level keys', () => {
    expectPurpose(
      '.github/ISSUE_TEMPLATE/bug.yml',
      'name: Bug report\ndescription: Something in TMB is broken\nlabels: ["Bug"]\nbody:\n  - type: textarea\n',
      'structural',
      'Bug report: Something in TMB is broken',
    );
    expectPurpose('.github/workflows/dev-build.yml', 'name: dev-build\non:\n  push:\n    branches: [dev]\n', 'structural', 'dev-build');
    expectPurpose('adapters/codex/agents/openai.yaml', 'interface:\n  display_name: "x"\npolicy:\n  allow: true\n', 'structural', 'keys: interface, policy');
  });

  it('changelog.d fragments and txt files: <dir role>: <file name>', () => {
    expectPurpose('changelog.d/1813-foo.md', '### Fixed\n- **A fix** (GH 1813): details.\n', 'structural', 'changelog fragment: 1813-foo');
    expectPurpose('changelog.d/README.md', '# changelog.d/\n\nOne file per change.\n', 'heading', 'changelog.d/ — One file per change.');
    expectPurpose('tests/l5-l6/rows/05/05.01-simple-task/prompt.txt', '@bro write a python cli todo\n', 'structural', '05.01-simple-task text: prompt');
    expectPurpose('tests/l1-lint/fixtures/no-bare-mktemp/bad.txt', 'mktemp\n', 'structural', 'no-bare-mktemp fixture: bad');
    expectPurpose('tests/hooks/fixtures/prescan.golden.txt', 'x\n', 'structural', 'hooks fixture: prescan.golden');
    expectPurpose('NOTES.txt', 'x\n', 'structural', 'text: NOTES');
  });

  it('markdown with no heading: the first non-empty line, stripped of inline markup', () => {
    expectPurpose(
      'docs/notes.md',
      '<!-- generated -->\n\nUse **bold** `code` and [a link](x.md) here. More.\n',
      'structural',
      'Use bold code and a link here.',
    );
    expectPurpose('docs/sub.md', '## Setup steps\n\nBody.\n', 'structural', 'Setup steps');
    expectPurpose('skills/x/SKILL.md', '---\nname: x\n---\n\n- *First* bullet point\n', 'structural', 'First bullet point');
  });

  it('markdown with no heading: nested tags leave no < or > in the purpose', () => {
    const got = extractPurpose('docs/nested.md', '<<script>script>x\n');
    assert.equal(got.source, 'structural');
    assert.ok(!/[<>]/.test(got.purpose), `purpose kept a tag character: ${got.purpose}`);
  });

  it('never overrides a header: a // header, a JSDoc @file and a docstring keep their source', () => {
    assert.equal(extractPurpose('src/a.ts', '// Parses payloads.\nexport const a = 1;\n').source, 'comment');
    assert.equal(extractPurpose('src/b.ts', '/**\n * @file Routes requests.\n */\nexport const b = 1;\n').source, 'jsdoc');
    assert.equal(extractPurpose('src/c.py', '"""Retry queue."""\n').source, 'docstring');
  });
});

const sym = (kind: string, qualified_name: string, extra: Partial<PurposeSymbol> = {}): PurposeSymbol => ({
  kind,
  qualified_name,
  doc: '',
  exported: 0,
  start_line: null,
  end_line: null,
  ...extra,
});

describe('purposeFromSymbols — symbols fallback for code files', () => {
  it('a header-less ts file: its exports, kind and name, skipping private helpers', () => {
    const got = purposeFromSymbols('src/task-runs.ts', [
      sym('module', 'src/task-runs.ts'),
      sym('function', 'loadRuns', { start_line: 1, end_line: 3 }),
      sym('function', 'useTaskRuns', { exported: 1, start_line: 5, end_line: 9 }),
      sym('type', 'TaskRun', { exported: 1, start_line: 11, end_line: 11 }),
    ]);
    assert.deepEqual(got, { purpose: 'exports: useTaskRuns (function), TaskRun (type)', source: 'symbols' });
  });

  it('a tsx component: the main export doc follows the exports', () => {
    const got = purposeFromSymbols('web/TaskPage.tsx', [
      sym('module', 'web/TaskPage.tsx'),
      sym('function', 'useTaskRuns', { exported: 1, doc: 'Polls the runs.', start_line: 1, end_line: 4 }),
      sym('function', 'TaskPage', { exported: 1, doc: 'Renders one task with its runs. Second.', start_line: 6, end_line: 30 }),
    ]);
    assert.deepEqual(got, {
      purpose: 'exports: useTaskRuns (function), TaskPage (function) — Renders one task with its runs.',
      source: 'symbols',
    });
  });

  it('no exports: the top-level definitions, nested ones and methods left out', () => {
    const got = purposeFromSymbols('scripts/run.mjs', [
      sym('module', 'scripts/run.mjs', { doc: 'eslint-disable no-console' }),
      sym('function', 'main', { start_line: 1, end_line: 20 }),
      sym('function', 'inner', { start_line: 3, end_line: 5 }),
      sym('class', 'Runner', { start_line: 22, end_line: 40 }),
      sym('method', 'Runner.go', { start_line: 23, end_line: 25 }),
    ]);
    assert.deepEqual(got, { purpose: 'defines: main (function), Runner (class)', source: 'symbols' });
  });

  it('a sh file: its function names, with the module doc sentence', () => {
    assert.deepEqual(
      purposeFromSymbols('scripts/lib/util.sh', [
        sym('module', 'scripts/lib/util.sh'),
        sym('sh_function', 'tmb_log', { exported: 1, start_line: 1, end_line: 3 }),
        sym('sh_function', 'tmb_die', { exported: 1, start_line: 5, end_line: 8 }),
      ]),
      { purpose: 'functions: tmb_log, tmb_die', source: 'symbols' },
    );
    assert.deepEqual(
      purposeFromSymbols('scripts/lib/db.sh', [
        sym('module', 'scripts/lib/db.sh', { doc: 'Opens the trajectory DB. More.' }),
        sym('sh_function', 'db_open', { exported: 1, start_line: 3, end_line: 9 }),
      ]),
      { purpose: 'functions: db_open — Opens the trajectory DB.', source: 'symbols' },
    );
    assert.deepEqual(
      purposeFromSymbols('scripts/lib/q.sh', [
        sym('module', 'scripts/lib/q.sh', { doc: 'shellcheck shell=bash' }),
        sym('sh_function', 'q_run', { exported: 1, start_line: 3, end_line: 9 }),
      ]),
      { purpose: 'functions: q_run', source: 'symbols' },
      'a directive-only module doc adds nothing',
    );
  });

  it('a test file: tests for <subject> with its first describe/test titles, from the head', () => {
    const head = "import { describe, it } from 'node:test';\ndescribe('extractPurpose', () => {\n  it(\"reads a docstring\", () => {});\n  it.skip(`caps at 200`, () => {});\n});\n";
    assert.deepEqual(purposeFromSymbols('src/test/file-purpose.test.ts', [sym('module', 'src/test/file-purpose.test.ts')], head), {
      purpose: 'tests for file-purpose: extractPurpose; reads a docstring; caps at 200',
      source: 'symbols',
    });
    assert.deepEqual(
      purposeFromSymbols('src/test/helpers.ts', [sym('function', 'tempDB', { exported: 1, start_line: 1, end_line: 4 })], 'export function tempDB() {}\n'),
      { purpose: 'exports: tempDB (function)', source: 'symbols' },
      'a test-tree helper with no titles falls back to its exports',
    );
  });

  it('caps a long export list at PURPOSE_MAX_CHARS with a +N more tail, and yields null with no definitions', () => {
    const many = Array.from({ length: 40 }, (_, i) => sym('function', `exportedFunctionNumber${i}`, { exported: 1, start_line: i * 3 + 1, end_line: i * 3 + 2 }));
    const got = purposeFromSymbols('src/many.ts', many)!;
    assert.ok(got.purpose.length <= PURPOSE_MAX_CHARS, `${got.purpose.length}`);
    assert.match(got.purpose, /^exports: exportedFunctionNumber0 \(function\), .*, \+\d+ more$/);
    assert.equal(purposeFromSymbols('src/side-effect.ts', [sym('module', 'src/side-effect.ts')]), null);
  });
});

describe('refreshSymbolPurposes — the post-pass over wm_files', () => {
  it('fills none rows, refreshes symbols rows, and leaves header and swe purposes alone', () => {
    const db = tempDB();
    try {
      const file = (path: string, purpose: string, source: string): void => {
        db.run(
          `INSERT INTO wm_files (repo, path, dir, purpose, purpose_source, updated_at) VALUES ('app', ?, 'src', ?, ?, 't0')`,
          [path, purpose, source],
        );
      };
      const symbol = (path: string, name: string): void => {
        db.run(
          `INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash, exported, start_line, end_line) VALUES ('app', ?, 'function', ?, 'h', 1, 1, 2)`,
          [path, name],
        );
      };
      file('src/a.ts', 'Parses payloads.', 'comment');
      file('src/b.ts', 'Routes requests.', 'jsdoc');
      file('src/c.ts', 'Hand-written.', 'swe');
      file('src/d.ts', '', 'none');
      file('src/e.ts', 'exports: old (function)', 'symbols');
      file('src/f.ts', 'exports: gone (function)', 'symbols');
      for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']) symbol(p, 'run');
      symbol('src/e.ts', 'renamed');

      assert.deepEqual(refreshSymbolPurposes(db, 'app'), { updated: 3 });
      const rows = Object.fromEntries(
        db
          .all<{ path: string; purpose: string; purpose_source: string }>(
            `SELECT path, purpose, purpose_source FROM wm_files WHERE repo = 'app'`,
          )
          .map((r) => [r.path, [r.purpose_source, r.purpose]]),
      );
      assert.deepEqual(rows, {
        'src/a.ts': ['comment', 'Parses payloads.'],
        'src/b.ts': ['jsdoc', 'Routes requests.'],
        'src/c.ts': ['swe', 'Hand-written.'],
        'src/d.ts': ['symbols', 'exports: run (function)'],
        'src/e.ts': ['symbols', 'exports: renamed (function)'],
        'src/f.ts': ['none', ''],
      });
      assert.deepEqual(refreshSymbolPurposes(db, 'app'), { updated: 0 }, 'a second pass over unchanged symbols writes nothing');
    } finally {
      db.close();
    }
  });
});

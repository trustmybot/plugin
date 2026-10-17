import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPurpose, isPurposeCandidate, normalizePurpose, PURPOSE_MAX_CHARS, } from '../file-purpose.js';
function expectPurpose(path, head, source, purpose) {
    const got = extractPurpose(path, head);
    assert.equal(got.source, source, `${path}: source`);
    assert.ok(got.purpose.length > 0, `${path}: purpose is populated`);
    assert.equal(got.purpose, purpose, `${path}: purpose`);
}
describe('extractPurpose — deterministic per-file purpose', () => {
    it('reads a python module docstring after a shebang and coding comment', () => {
        expectPurpose('tools/sync.py', '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n"""Sync the local mirror with the\nupstream registry.\n\nLonger notes.\n"""\nimport os\n', 'docstring', 'Sync the local mirror with the upstream registry.');
    });
    it('reads the first // comment block of a ts file, stopping at the first sentence', () => {
        expectPurpose('src/graph.ts', '// World-model graph wrapper over kuzu native\n// bindings. See ADR 0002.\nimport x from "y";\n', 'comment', 'World-model graph wrapper over kuzu native bindings.');
    });
    it('skips a license line and reads a /* */ block', () => {
        expectPurpose('lib/index.js', '// SPDX-License-Identifier: MIT\n\n/*\n * Router for inbound webhook events\n */\nexport {};\n', 'comment', 'Router for inbound webhook events');
    });
    it('prefers a JSDoc @file tag over the first comment block', () => {
        expectPurpose('src/cli.mjs', '// eslint-disable-next-line\n// generic banner text here.\n/**\n * @file Command-line entry point for the bundler.\n * @author someone\n */\n', 'jsdoc', 'Command-line entry point for the bundler.');
    });
    it('reads a @fileoverview whose text sits on the following lines', () => {
        expectPurpose('src/a.ts', '/**\n * @fileoverview\n * Parses spec bodies into sections.\n */\n', 'jsdoc', 'Parses spec bodies into sections.');
    });
    it('reads the # comment block after a shell shebang, skipping shellcheck directives', () => {
        expectPurpose('scripts/build.sh', '#!/usr/bin/env bash\n# shellcheck disable=SC2034\n# Deterministic project scanner for the world model.\n# More detail.\nset -euo pipefail\n', 'comment', 'Deterministic project scanner for the world model.');
    });
    it('reads a -- comment from a sql file', () => {
        expectPurpose('db/schema.sql', '-- Trajectory DB schema: issues, tasks, audit.\nCREATE TABLE x (id INT);\n', 'comment', 'Trajectory DB schema: issues, tasks, audit.');
    });
    it('reads a markdown frontmatter description, plain and folded', () => {
        expectPurpose('skills/x/SKILL.md', '---\nname: x\ndescription: "Walks bro through planning. Extra."\n---\n# Planning\n\nBody.\n', 'frontmatter', 'Walks bro through planning.');
        expectPurpose('agents/swe.md', '---\nname: swe\ndescription: >\n  The executor that implements\n  one task spec.\n---\n', 'frontmatter', 'The executor that implements one task spec.');
    });
    it('falls back to the first H1 plus the first paragraph sentence for markdown', () => {
        expectPurpose('docs/WORLD_MODEL.md', '# World Model\n\n[![badge](x.svg)](y)\n\nBro is the **architect** of every project. It builds a map.\n\n## Schema\n', 'heading', 'World Model — Bro is the architect of every project.');
    });
    it('reads a manifest description, even from a head cut mid-file', () => {
        expectPurpose('package.json', '{\n  "name": "x",\n  "description": "Trajectory MCP server."\n}\n', 'manifest', 'Trajectory MCP server.');
        expectPurpose('.claude-plugin/plugin.json', '{ "name": "tmb", "description": "Orchestrator plugin for Claude Code.", "hooks": [ "a", ', 'manifest', 'Orchestrator plugin for Claude Code.');
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
        assert.equal(isPurposeCandidate('a/data.json'), false);
        assert.equal(isPurposeCandidate('a/logo.png'), false);
    });
});
//# sourceMappingURL=file-purpose.test.js.map
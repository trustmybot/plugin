// L1 lint: a script a .github/workflows/*.yml job runs with `node scripts/…` must not reach trajectory-server/dist/
// through its relative imports unless an earlier run line in that job builds it (GH 2610 — issue-triage.yml ran
// labels.mjs, which imported dist/bug-report/form.js, and no step built dist, so every run died at load).
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = 'trajectory-server/dist/';
const BUILD_RE = /\brun\s+build(?::(?:tsc|payload))?(?![\w:-])/;
const NODE_RE = /\bnode\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:\.\/)?(scripts\/\S+?\.(?:mjs|js|ts))(?![\w.])/g;
const IMPORT_RES = [
  /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];

const indentOf = (line) => line.length - line.trimStart().length;
const isFile = (p) => existsSync(p) && statSync(p).isFile();

function resolveImport(fromFile, spec) {
  const target = resolve(dirname(fromFile), spec);
  if (isFile(target)) return target;
  if (target.endsWith('.js') && isFile(target.replace(/\.js$/, '.ts'))) return target.replace(/\.js$/, '.ts');
  return null;
}

function distHits(base, entry) {
  const hits = [];
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = relative(base, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, idx) => {
        if (line.includes(DIST)) hits.push(`${rel}:${idx + 1}`);
        for (const re of IMPORT_RES) {
          for (const m of line.matchAll(re)) {
            const next = resolveImport(file, m[1]);
            if (next && !relative(base, next).startsWith('..') && !next.includes(DIST)) stack.push(next);
          }
        }
      });
  }
  return hits;
}

function runLinesByJob(lines) {
  const jobs = new Map();
  let inJobs = false;
  let job = null;
  let block = null;
  lines.forEach((line, idx) => {
    if (block !== null) {
      if (line.trim() === '' || indentOf(line) > block) {
        jobs.get(job).push({ n: idx + 1, text: line });
        return;
      }
      block = null;
    }
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*(?:#.*)?$/.test(line);
      job = null;
      return;
    }
    if (!inJobs) return;
    const jobKey = /^ {2}([\w-]+):\s*(?:#.*)?$/.exec(line);
    if (jobKey) {
      job = jobKey[1];
      jobs.set(job, []);
      return;
    }
    if (!job) return;
    const run = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!run) return;
    if (/^[|>][-+]?\s*(?:#.*)?$/.test(run[2])) block = run[1].length;
    else jobs.get(job).push({ n: idx + 1, text: run[2] });
  });
  return jobs;
}

export function checkWorkflow(base, file) {
  const out = [];
  const wf = relative(base, file);
  for (const [job, runs] of runLinesByJob(readFileSync(file, 'utf8').split('\n'))) {
    let built = false;
    for (const { n, text } of runs) {
      for (const m of text.matchAll(NODE_RE)) {
        const buildAt = text.search(BUILD_RE);
        if (built || (buildAt !== -1 && buildAt < m.index)) continue;
        const entry = join(base, m[1]);
        if (!isFile(entry)) continue;
        for (const hit of distHits(base, entry)) {
          out.push(`${wf}:${n}: job ${job} runs ${m[1]} with no earlier build step, but it reaches ${DIST} at ${hit}`);
        }
      }
      if (BUILD_RE.test(text)) built = true;
    }
  }
  return out;
}

function ymlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const child = join(dir, e.name);
    if (e.isDirectory()) return ymlFiles(child);
    return /\.ya?ml$/.test(e.name) ? [child] : [];
  });
}

function fixture(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-no-dist-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'entry.mjs'), "import { helper } from './lib/helper.mjs';\nhelper();\n");
  writeFileSync(
    join(dir, 'scripts', 'lib', 'helper.mjs'),
    "export async function helper() {\n  return import('../../mcp/trajectory-server/dist/x.js');\n}\n",
  );
  const wf = join(dir, '.github', 'workflows', 'ci.yml');
  writeFileSync(wf, `name: ci\non: push\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`);
  return { dir, wf };
}

test('fixture: a workflow script reaching dist/ with no build step fails', () => {
  const { dir, wf } = fixture('      - uses: actions/checkout@v5\n      - name: Go\n        run: node scripts/entry.mjs --go\n');
  try {
    const out = checkWorkflow(dir, wf);
    assert.equal(out.length, 1, out.join('\n'));
    assert.match(out[0], /^\.github\/workflows\/ci\.yml:9: job go runs scripts\/entry\.mjs .* at scripts\/lib\/helper\.mjs:2$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture: the same script passes once a build step precedes it', () => {
  const { dir, wf } = fixture(
    '      - run: bun run build\n      - name: Go\n        run: |\n          echo start\n          node --no-warnings scripts/entry.mjs\n',
  );
  try {
    assert.deepEqual(checkWorkflow(dir, wf), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture: a build in another job does not count', () => {
  const { dir, wf } = fixture('      - run: bun run build:payload\n  other:\n    steps:\n      - run: node scripts/entry.mjs\n');
  try {
    assert.equal(checkWorkflow(dir, wf).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow scripts reach dist/ only after a build step', () => {
  const dir = join(ROOT, '.github', 'workflows');
  if (!existsSync(dir)) return;
  const out = ymlFiles(dir)
    .sort()
    .flatMap((f) => checkWorkflow(ROOT, f));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nworkflow-scripts-no-dist: FAIL`);
});

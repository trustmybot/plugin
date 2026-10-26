import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from '../lib/paths.ts';
import type { Question } from './questions.ts';

const dir = join(RESULTS_DIR, 'm1m2');
const cells = JSON.parse(readFileSync(join(dir, 'cells.json'), 'utf8')) as Array<{ input: string; arm: string; answers: string[]; correct: boolean[] }>;
const qs = new Map((JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as Array<{ id: string; questions: Question[] }>).map((x) => [x.id, x.questions]));

for (const c of cells) {
  c.correct.forEach((ok, k) => {
    const q = qs.get(c.input)![k]!;
    if (ok || (!q.conciseAnswerable && c.arm.startsWith('concise'))) return;
    console.log(`${c.arm.padEnd(13)} ${c.input} [${q.kind}] ${q.text.slice(0, 70)}\n    truth=${q.truth.slice(0, 80)}\n    got  =${String(c.answers[k]).slice(0, 80)}`);
  });
}

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from '../lib/paths.ts';
import { ARMS, render } from './formats.ts';
import { makeQuestions } from './questions.ts';

const TOOLS = ['audit_list', 'discussion_list', 'validation_history', 'task_get', 'issue_list', 'world_model_get'];
const dir = join(RESULTS_DIR, 'm1m2', 'outputs');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '');
  const tool = TOOLS.find((t) => id.startsWith(`${t}_`))!;
  const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
  const sizes = ARMS.map((a) => `${a.name}=${render(tool, data, a).length}`).join(' ');
  console.log(`\n## ${id}  ${sizes}`);
  for (const q of makeQuestions(id, tool, data)) console.log(`  [${q.kind}${q.conciseAnswerable ? '' : ' DETAIL-ONLY'}] ${q.text}  => ${q.truth.slice(0, 80)}`);
}

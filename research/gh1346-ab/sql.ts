import { query } from './lib/snapshot.ts';

for (const sql of process.argv.slice(2)) {
  for (const row of query(sql)) console.log(Object.values(row).join('\t'));
  console.log('--');
}

import { exportSource } from './source.ts';
import { m3Questions } from './questions.ts';

for (const q of m3Questions(exportSource())) console.log(`${q.kind.padEnd(6)} ${q.id.padEnd(22)} ${q.truth}`);

import { callTool } from './lib/snapshot.ts';

const [name, json] = process.argv.slice(2);
const text = await callTool(name!, { agent: 'bro', ...(JSON.parse(json ?? '{}') as object) });
console.log(text.length, text.slice(0, Number(process.env['N'] ?? 1500)));

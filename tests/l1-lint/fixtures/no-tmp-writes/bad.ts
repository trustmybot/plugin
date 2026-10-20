import { writeFileSync, mkdirSync, mkdtempSync, createWriteStream } from 'node:fs';
writeFileSync('/tmp/tmb-state.json', '{}'); // VIOLATION
mkdirSync("/var/tmp/tmb", { recursive: true }); // VIOLATION
mkdtempSync('/tmp/tmb-'); // VIOLATION
const LOG = '/tmp/tmb.log';
createWriteStream(LOG); // VIOLATION
const sub = `${LOG}.d`;
mkdirSync(sub); // VIOLATION

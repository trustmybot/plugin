const a = runClaude(['plugin', 'install', ref], timeoutSec); // VIOLATION
const b = runClaude(["plugin", "uninstall", name, "--scope", "user"], t); // VIOLATION
const c = runClaude(['mcp', 'add', name, url], t); // VIOLATION
const d = runClaude(['mcp', 'remove', name], t); // VIOLATION
const e = runClaude(['plugin', 'marketplace', 'add', url], t); // VIOLATION
const f = execSync(`claude mcp add-json ${name} ${json}`); // VIOLATION
const g = runClaude(['plugin', 'disable', name, '--scope', scope], t); // VIOLATION
const h = runClaude(['plugin', sub, name], t); // VIOLATION
const i = runClaude(['--debug', 'mcp', 'remove', name], t); // VIOLATION
const j = runClaude(['plugin', 'install', ref, '--scope', 'project', '--scope', 'user'], t); // VIOLATION
const k = runClaude(['plugin', 'install', ref, '-s', 'project', `--scope=${s}`], t); // VIOLATION
const l = spawnSync('npx', ['claude', 'mcp', 'add', name, url]); // VIOLATION
const m = execSync(`${claudeBin} plugin install ${ref}`); // VIOLATION
const bin = 'claude';
const n = execSync(`${bin} mcp remove ${name}`); // VIOLATION
const o = runClaude(['plugin', 'marketplace', 'update', mkt], t); // VIOLATION
const p = runClaude(['mcp', 'add-from-claude-desktop'], t); // VIOLATION
const q = runClaude(['plugin', 'i', ref, '--scope', 'user'], t); // VIOLATION
const r = runClaude(['plugin', 'marketplace', 'rm', mkt], t); // VIOLATION
const s2 = execSync('claude plugin install x --scope user'); // VIOLATION
const u = 'http://x'; execSync(`claude mcp remove ${name}`); // VIOLATION
const v = runClaude(['mcp', 'add', name, '--', 'npx', 'srv', '--scope', 'project'], t); // VIOLATION
const w = runClaude([ // VIOLATION
  'plugin',
  'prune',
], t);

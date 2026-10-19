// runClaude(['plugin', 'install', ref]) — comment lines are skipped
const a = runClaude(['plugin', 'install', ref, '--scope', 'project'], timeoutSec);
const b = runClaude(["plugin", "uninstall", name, "--scope", "project", "--keep-data"], t);
const c = runClaude(['mcp', 'add', '--scope=project', name, url], t);
const d = runClaude([
  'mcp',
  'remove',
  name,
  '--scope',
  'project',
], t);
const e = runClaude(['plugin', 'marketplace', 'add', url, '--scope', 'project'], t);
const f = execSync(`claude mcp add-json --scope project ${name} ${json}`);
const g = runClaude(['plugin', 'list', '--json'], t);
const h = runClaude(['mcp', 'list'], t);
const i = runClaude(['plugin', 'marketplace', 'list', '--json'], t);
const j = runClaude(['mcp', 'get', name], t);
const kind: 'plugin' | 'mcp' = 'plugin';

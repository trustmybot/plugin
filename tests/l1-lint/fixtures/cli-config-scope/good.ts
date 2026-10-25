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
const k = runClaude(['plugin', 'install', ref, '-s', 'project'], t);
const l = runClaude(['plugin', sub, name, '--scope', 'project'], t);
const m = runClaude(['--debug', 'mcp', 'remove', name, '-s', 'project'], t);
const n = runClaude(['plugin', 'details', name], t);
const o = runClaude(['plugin', 'validate', dir], t);
const p = 'a # b'; execSync(`claude plugin install ${ref} --scope project`);
const q = 'https://example.com'; // claude mcp remove x in a trailing comment
/* claude mcp remove x in a block comment */
const kinds = ['skill', 'mcp', 'plugin'];
const r = execSync(`${claudeBin} mcp remove ${name} --scope project`);
const s = runClaude(['plugin', 'install', ref, '--scope', 'user', '--scope=project'], t);
const remedy = 'run `claude plugin disable <plugin>@<marketplace> --scope <scope>`'; // cli-config-scope: printed

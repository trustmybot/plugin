const a = runClaude(['plugin', 'install', ref], timeoutSec); // VIOLATION
const b = runClaude(["plugin", "uninstall", name, "--scope", "user"], t); // VIOLATION
const c = runClaude(['mcp', 'add', name, url], t); // VIOLATION
const d = runClaude(['mcp', 'remove', name], t); // VIOLATION
const e = runClaude(['plugin', 'marketplace', 'add', url], t); // VIOLATION
const f = execSync(`claude mcp add-json ${name} ${json}`); // VIOLATION
const g = runClaude(['plugin', 'disable', name, '--scope', scope], t); // VIOLATION

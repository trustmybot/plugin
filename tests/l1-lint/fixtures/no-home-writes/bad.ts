import { homedir } from 'node:os';
const logDir = join(homedir(), '.claude', 'tmb', 'logs');
mkdirSync(logDir, { recursive: true }); // VIOLATION
appendFileSync(join(logDir, 'x.log'), 'line'); // VIOLATION
writeFileSync(join(process.env['HOME'] ?? '', '.claude', 's.json'), '{}'); // VIOLATION
function resolveLogDir(): string {
  return join(homedir(), '.claude', 'tmb', 'logs');
}
const syncDir = resolveLogDir();
mkdirSync(syncDir, { recursive: true }); // VIOLATION
export function materialize(homeDir: string): void {
  const resolverDir = join(homeDir, '.claude', 'tmb-hooks');
  mkdirSync(resolverDir, { recursive: true }); // VIOLATION
}

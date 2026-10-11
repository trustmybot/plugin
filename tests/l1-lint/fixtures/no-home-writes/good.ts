import { homedir } from 'node:os';
export const TMB_MODEL_CACHE_DIR = process.env['TMB_MODEL_CACHE_DIR'] ?? join(homedir(), '.cache', 'huggingface');
const manifest = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
mkdirSync(join(projectRoot, '.claude', 'tmb', 'logs'), { recursive: true });
writeFileSync(join(projectRoot, '.claude', 'settings.local.json'), JSON.stringify(parsed));

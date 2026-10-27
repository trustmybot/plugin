/**
 * Prints the router table, one gate per line in run order:
 *   <gate> <budget ms> <enforcement|advisory> <event> <tool,...>
 * The build pipes this into dist/hooks-router.txt: the marker that an
 * install's dist ships the router, and the table scripts/hooks/lib and the
 * hook lints read.
 */
import { ROUTER_GROUPS } from '../registry.js';
process.stdout.write(ROUTER_GROUPS.flatMap((g) => g.gates.map((x) => `${x.name} ${x.budgetMs} ${x.kind} ${g.event} ${g.tools.join(',')}\n`)).join(''));
//# sourceMappingURL=manifest.js.map
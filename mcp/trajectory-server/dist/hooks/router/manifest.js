/**
 * Prints the router table, one gate per line in run order:
 *   <gate> <budget ms> <enforcement|advisory> <event> <matcher or -> <tool suffix|*> [<part>]
 * The build pipes this into dist/hooks-router.txt: the marker that an
 * install's dist ships the router, and the table scripts/hooks/lib and the
 * hook lints read.
 */
import { ROUTER_GROUPS } from '../registry.js';
import { matcherColumn, partColumn } from './table.js';
process.stdout.write(ROUTER_GROUPS.flatMap((g) => g.gates.map((x) => `${x.name} ${x.budgetMs} ${x.kind} ${g.event} ${matcherColumn(g.matcher)} ${x.toolSuffix ?? '*'}${partColumn(g.part)}\n`)).join(''));
//# sourceMappingURL=manifest.js.map
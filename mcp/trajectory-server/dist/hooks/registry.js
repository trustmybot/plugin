import { askuserquestionLengthLint } from './askuserquestion-length-lint.js';
import { ensureMcpDepsInstalled } from './ensure-mcp-deps-installed.js';
const GATES = new Map([
    ['askuserquestion-length-lint', askuserquestionLengthLint],
    ['ensure-mcp-deps-installed', ensureMcpDepsInstalled],
]);
export function findGate(name) {
    return GATES.get(name);
}
export function gateNames() {
    return [...GATES.keys()].sort();
}
//# sourceMappingURL=registry.js.map
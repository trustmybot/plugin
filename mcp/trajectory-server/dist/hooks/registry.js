import { askuserquestionLengthLint } from './askuserquestion-length-lint.js';
const GATES = new Map([
    ['askuserquestion-length-lint', askuserquestionLengthLint],
]);
export function findGate(name) {
    return GATES.get(name);
}
export function gateNames() {
    return [...GATES.keys()].sort();
}
//# sourceMappingURL=registry.js.map
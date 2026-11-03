// The deferred-tools-drift-warn gate of router-parity.suite.ts, run as its own node --test process (GH 2118).
import { routerParityGate } from './router-parity.suite.js';

routerParityGate('deferred-tools-drift-warn');

// The lane-membership gate of router-parity.suite.ts, run as its own node --test process (GH 3020).
import { routerParityGate } from './router-parity.suite.js';

routerParityGate('lane-membership');

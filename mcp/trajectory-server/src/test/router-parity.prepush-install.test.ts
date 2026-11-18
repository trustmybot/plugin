// The prepush-install gate of router-parity.suite.ts, run as its own node --test process (GH 3281).
import { routerParityGate } from './router-parity.suite.js';

routerParityGate('prepush-install');

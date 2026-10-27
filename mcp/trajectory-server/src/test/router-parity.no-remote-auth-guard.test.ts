// The no-remote-auth-guard gate of router-parity.suite.ts, run as its own node --test process (GH 2118).
import { routerParityGate } from './router-parity.suite.js';

routerParityGate('no-remote-auth-guard');

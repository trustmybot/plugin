// The user-prompt-persona gate of router-parity.suite.ts, run as its own node --test process (GH 2118).
import { routerParityGate } from './router-parity.suite.js';

process.env.TZ = 'UTC';
routerParityGate('user-prompt-persona');

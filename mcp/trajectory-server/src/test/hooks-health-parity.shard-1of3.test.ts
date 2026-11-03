// Shard 1 of 3 of hooks-health-parity.suite.ts, run as its own node --test process (GH 1947).
import { healthHooksParityShard } from './hooks-health-parity.suite.js';

healthHooksParityShard(1, 3);

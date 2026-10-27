// Shard 1 of 4 of hooks-session-parity.suite.ts, run as its own node --test process (GH 1947).
import { sessionHooksParityShard } from './hooks-session-parity.suite.js';

sessionHooksParityShard(1, 4);

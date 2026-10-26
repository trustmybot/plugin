// Shard 1 of 6 of hooks-parity.suite.ts, run as its own node --test process (GH 1947).
import { hooksParityShard } from './hooks-parity.suite.js';

hooksParityShard(1, 6);

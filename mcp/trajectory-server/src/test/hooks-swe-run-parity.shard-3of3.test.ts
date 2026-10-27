// Shard 3 of 3 of hooks-swe-run-parity.suite.ts, run as its own node --test process (GH 1947).
import { sweRunParityShard } from './hooks-swe-run-parity.suite.js';

sweRunParityShard(3, 3);

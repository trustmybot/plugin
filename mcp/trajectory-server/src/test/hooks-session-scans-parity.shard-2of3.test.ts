// Shard 2 of 3 of hooks-session-scans-parity.suite.ts, run as its own node --test process (GH 1947).
import { sessionScansParityShard } from './hooks-session-scans-parity.suite.js';

sessionScansParityShard(2, 3);

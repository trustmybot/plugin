// Shard 1 of 3 of hooks-lint-parity.suite.ts, run as its own node --test process (GH 1947).
import { lintParityShard } from './hooks-lint-parity.suite.js';

lintParityShard(1, 3);

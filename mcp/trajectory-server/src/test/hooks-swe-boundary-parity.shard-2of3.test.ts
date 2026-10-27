// Shard 2 of 3 of hooks-swe-boundary-parity.suite.ts, run as its own node --test process (GH 1947).
import { sweBoundaryParityShard } from './hooks-swe-boundary-parity.suite.js';

sweBoundaryParityShard(2, 3);

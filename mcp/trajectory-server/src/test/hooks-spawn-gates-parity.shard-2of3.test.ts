// Shard 2 of 3 of hooks-spawn-gates-parity.suite.ts, run as its own node --test process (GH 1947).
import { spawnGatesParityShard } from './hooks-spawn-gates-parity.suite.js';

spawnGatesParityShard(2, 3);

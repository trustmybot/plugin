// Shard 2 of 3 of hooks-reviewer-spawn-parity.suite.ts, run as its own node --test process (GH 1947).
import { reviewerSpawnParityShard } from './hooks-reviewer-spawn-parity.suite.js';

reviewerSpawnParityShard(2, 3);

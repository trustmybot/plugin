// Shard 1 of 3 of hooks-worktree-lifecycle-parity.suite.ts, run as its own node --test process (GH 1947).
import { worktreeLifecycleParityShard } from './hooks-worktree-lifecycle-parity.suite.js';

worktreeLifecycleParityShard(1, 3);

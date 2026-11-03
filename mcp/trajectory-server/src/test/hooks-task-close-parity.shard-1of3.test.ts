// Shard 1 of 3 of hooks-task-close-parity.suite.ts, run as its own node --test process (GH 1947).
import { taskCloseParityShard } from './hooks-task-close-parity.suite.js';

taskCloseParityShard(1, 3);

// Shard 1 of 3 of hooks-git-guards-parity.suite.ts, run as its own node --test process (GH 1947).
import { gitGuardsParityShard } from './hooks-git-guards-parity.suite.js';

gitGuardsParityShard(1, 3);

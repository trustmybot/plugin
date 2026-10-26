// Shard 1 of 3 of hooks-git-push-guard-parity.suite.ts, run as its own node --test process (GH 1947).
import { gitPushGuardParityShard } from './hooks-git-push-guard-parity.suite.js';

gitPushGuardParityShard(1, 3);

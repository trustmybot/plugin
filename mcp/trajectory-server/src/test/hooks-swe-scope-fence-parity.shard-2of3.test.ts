// Shard 2 of 3 of hooks-swe-scope-fence-parity.suite.ts, run as its own node --test process (GH 1947).
import { sweScopeFenceParityShard } from './hooks-swe-scope-fence-parity.suite.js';

sweScopeFenceParityShard(2, 3);

// Shard 1 of 3 of hooks-trajectory-chain-parity.suite.ts, run as its own node --test process (GH 1947).
import { trajectoryChainParityShard } from './hooks-trajectory-chain-parity.suite.js';

trajectoryChainParityShard(1, 3);

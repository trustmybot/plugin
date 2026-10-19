#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
spawnSync('claude', ['plugin', 'install', process.argv[2]]); // VIOLATION
spawnSync('claude', ['plugin', 'configure', name, '--values-stdin']); // VIOLATION

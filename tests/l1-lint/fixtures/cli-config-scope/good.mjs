#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
spawnSync('claude', ['plugin', 'install', process.argv[2], '--scope', 'project']);
spawnSync('claude', ['plugin', 'list', '--json']);

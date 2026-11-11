// /tmp growth check for test runners that share /tmp with other sessions.
//
// A runner names everything it creates with its run id (TMB_TEST_RUN_ID,
// exported to the tests). After the suite, a new top-level /tmp entry whose name
// carries the run id is this run's leak and fails the check; any other new
// tmb*/claude* entry may belong to a concurrent session, so it is printed as a
// warning and never fails. Claude Code's own per-session entries
// (claude-*-cwd, claude-<uid>) are not counted at all. TMB_TMP_FOOTPRINT_ROOT
// moves the watched root off /tmp (a test runs a runner against a sandbox dir).
//
// Usage:
//   import { tmpFootprintStart, tmpFootprintParent, tmpFootprintCheck } from '../lib/tmp-footprint.mjs';
//   tmpFootprintStart('<label>');        // sets + exports TMB_TEST_RUN_ID
//   const dir = mkdtempSync(`${tmpFootprintParent()}/${process.env.TMB_TEST_RUN_ID}.`);
//   ...run the suite...
//   if (!tmpFootprintCheck('<suite name>', dir)) fail = 1;
import { readdirSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename } from 'node:path';

let before = [];

/** TMPDIR (default /tmp) with every trailing slash stripped. */
export function tmpFootprintParent() {
  return (process.env.TMPDIR || '/tmp').replace(/\/*$/, '');
}

/** The watched root: TMB_TMP_FOOTPRINT_ROOT (default /tmp) with every trailing slash stripped. */
export function tmpFootprintRoot() {
  return (process.env.TMB_TMP_FOOTPRINT_ROOT || '/tmp').replace(/\/*$/, '');
}

/** The sorted <root>/<name> entries a run could have made: tmb* and claude*, less Claude Code's own. */
export function tmpFootprintEntries() {
  const root = tmpFootprintRoot();
  let names;
  try {
    names = readdirSync(`${root}/`);
  } catch {
    return [];
  }
  const own = `claude-${process.getuid?.() ?? ''}`;
  return names
    .filter((n) => (n.startsWith('tmb') || n.startsWith('claude')) && !/^claude-.*-cwd$/.test(n) && n !== own)
    .map((n) => `${root}/${n}`)
    .sort();
}

/** Sets and exports TMB_TEST_RUN_ID (`tmb-<label>-<pid>-<epoch s>`) and records the /tmp entries before the run. */
export function tmpFootprintStart(label) {
  const id = `tmb-${label}-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  process.env.TMB_TEST_RUN_ID = id;
  before = tmpFootprintEntries();
  return id;
}

function physical(dir) {
  try {
    return statSync(dir).isDirectory() ? realpathSync(dir) : null;
  } catch {
    return null;
  }
}

/** Prints the /tmp verdict for <suite>; false when /tmp gained an entry named for this run outside <ownDirs>. */
export function tmpFootprintCheck(suite, ...ownDirs) {
  const id = process.env.TMB_TEST_RUN_ID ?? '';
  const seen = new Set(before);
  const ownReal = ownDirs.map(physical);
  let own = '';
  let foreign = '';
  for (const entry of tmpFootprintEntries()) {
    if (seen.has(entry)) continue;
    const real = physical(entry) ?? entry;
    if (ownDirs.some((mine, i) => entry === mine || real === ownReal[i])) continue;
    if (basename(entry).includes(id)) own += `${entry}\n`;
    else foreign += `${entry}\n`;
  }
  const root = tmpFootprintRoot();
  if (foreign) writeSync(1, `warning: ${root} gained entries not named for this run (another session?):\n${foreign}`);
  if (own) {
    writeSync(1, `\nFAIL footprint: ${suite} left entries in ${root}:\n${own}`);
    return false;
  }
  writeSync(1, `footprint: ${root} gained no entries from this run (${id})\n`);
  return true;
}

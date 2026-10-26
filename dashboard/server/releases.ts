import { readFileSync } from 'node:fs';

export interface Release {
  version: string;
  date: string;
}

const HEADING = /^## v(\S+) — (\d{4}-\d{2}-\d{2})\s*$/;

// Every `## v<X> — YYYY-MM-DD` heading, newest date first; a tie keeps file order.
export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) releases.push({ version: m[1]!, date: m[2]! });
  }
  return releases.map((r, i) => ({ r, i })).sort((a, b) => b.r.date.localeCompare(a.r.date) || a.i - b.i).map(({ r }) => r);
}

export function loadReleases(path: string): Release[] {
  try {
    return parseChangelog(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

// The release in effect on `at`: the topmost one dated on or before its day.
export function releaseAt(releases: readonly Release[], at: string | null): Release | null {
  if (!at) return null;
  const day = at.slice(0, 10);
  return releases.find((r) => r.date <= day) ?? null;
}

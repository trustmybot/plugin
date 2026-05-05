// labels.ts — retired in #179.
//
// The issues.labels column was always-empty across all production rows in the
// pre-#179 schema audit. Local label storage was retired and the tools (
// issue_add_labels / issue_remove_labels / issue_set_labels) no longer expose
// MCP definitions. Remote label sync still works (syncIssueCreate accepts a
// labels arg and forwards to GitLab/GitHub at issue creation), but those
// labels are not persisted locally and cannot be queried back via MCP.
//
// This file is kept as a stub to satisfy any lingering imports during the
// transition. The stub exports an empty toolset; registerTools no longer
// imports it. Future cleanup may delete this file outright once we're
// confident no dependents remain (file deletion needs explicit Human
// authorization per the bro safety boundary).

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

export function labelTools(_db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  return { definitions: [], handlers: {} };
}

// decodeLabels and encodeLabels are no longer used; left as no-ops in case
// any external caller imports them (the test file did).
export function decodeLabels(_raw: string | null | undefined): string[] {
  return [];
}

export function encodeLabels(_labels: string[]): string {
  return '[]';
}

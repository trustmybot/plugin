/**
 * swe's checkpoint handback (GH 1905; tasks.checkpoint, schema v52): instead
 * of running on, swe stores what it did, what is left and the files in play
 * through task_update_status(status='running', checkpoint), and the next
 * spawn resumes from task_brief's `checkpoint`. The server adds `at`.
 */
export const CHECKPOINT_TEXT_MAX_CHARS = 2000;
export const CHECKPOINT_MAX_FILES = 50;

export interface Checkpoint {
  done: string;
  left: string;
  files: string[];
  commit_sha?: string;
  at: string;
}

function requiredText(r: Record<string, unknown>, key: 'done' | 'left'): string {
  const v = r[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`task_update_status: checkpoint.${key} must be a non-empty string.`);
  }
  if (v.length > CHECKPOINT_TEXT_MAX_CHARS) {
    throw new Error(
      `task_update_status: checkpoint.${key} is ${v.length} characters (max ${CHECKPOINT_TEXT_MAX_CHARS}).`,
    );
  }
  return v;
}

/** A checkpoint argument as stored, `at` = <now>; throws on a malformed one. */
export function parseCheckpoint(raw: unknown, now: string): Checkpoint {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('task_update_status: checkpoint must be an object {done, left, files, commit_sha?}.');
  }
  const r = raw as Record<string, unknown>;
  const done = requiredText(r, 'done');
  const left = requiredText(r, 'left');
  const files = r['files'];
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
    throw new Error('task_update_status: checkpoint.files must be an array of strings.');
  }
  if (files.length > CHECKPOINT_MAX_FILES) {
    throw new Error(
      `task_update_status: checkpoint.files holds ${files.length} entries (max ${CHECKPOINT_MAX_FILES}).`,
    );
  }
  const sha = r['commit_sha'];
  if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(sha))) {
    throw new Error('task_update_status: checkpoint.commit_sha must be a hex string of 7 to 40 characters.');
  }
  return {
    done,
    left,
    files: files as string[],
    ...(typeof sha === 'string' ? { commit_sha: sha.toLowerCase() } : {}),
    at: now,
  };
}

/** tasks.checkpoint parsed, or null when absent or unreadable. */
export function parseStoredCheckpoint(stored: string | null | undefined): Checkpoint | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Checkpoint;
    return parsed && typeof parsed === 'object' && typeof parsed.at === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

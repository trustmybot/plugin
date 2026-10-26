import type { ReactNode } from 'react';
import { LinkExternalIcon } from '@primer/octicons-react';
import type { Row } from '../api.ts';
import { ENTITY_LINK } from './columns.tsx';

export const SHA_LENGTH = 7;

const base = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);

export function ExternalLink({ href, title, className = '', children }: { href: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer" className={`${ENTITY_LINK} inline-flex items-center gap-1 ${className}`}>
      {children}
      <LinkExternalIcon size={12} aria-hidden="true" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

export interface RemoteIssue {
  label: string;
  href: string | null;
}

export function remoteIssue(issue: Row): RemoteIssue | null {
  const web = base(issue['remote_web_url']);
  if (issue['gh_iid'] !== null && issue['gh_iid'] !== undefined) {
    const n = String(issue['gh_iid']);
    return { label: `GH ${n}`, href: web && `${web}/issues/${encodeURIComponent(n)}` };
  }
  if (issue['gl_iid'] !== null && issue['gl_iid'] !== undefined) {
    const n = String(issue['gl_iid']);
    return { label: `GL ${n}`, href: web && `${web}/-/issues/${encodeURIComponent(n)}` };
  }
  return null;
}

export function RemoteIssueLink({ issue, className }: { issue: Row; className?: string }) {
  const remote = remoteIssue(issue);
  if (!remote) return null;
  return remote.href ? <ExternalLink href={remote.href} className={className}>{remote.label}</ExternalLink> : <span className={className}>{remote.label}</span>;
}

export function commitHref(web: unknown, provider: unknown, sha: string): string | null {
  const b = base(web);
  if (!b || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  if (provider === 'github') return `${b}/commit/${sha}`;
  if (provider === 'gitlab') return `${b}/-/commit/${sha}`;
  return null;
}

export function CommitSha({ sha, web, provider }: { sha: unknown; web: unknown; provider: unknown }) {
  const full = sha === null || sha === undefined ? '' : String(sha);
  if (!full) return <span className="text-fg-muted">—</span>;
  const short = <code className="font-mono">{full.slice(0, SHA_LENGTH)}</code>;
  const href = commitHref(web, provider, full);
  return href ? (
    <ExternalLink href={href} title={full}>
      {short}
    </ExternalLink>
  ) : (
    <span title={full}>{short}</span>
  );
}

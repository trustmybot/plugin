import { ApiError, type Row } from '../../api.ts';
import { Badge } from '../../shared/Badge.tsx';
import { ENTITY_LINK, hrefFor } from '../../shared/columns.tsx';
import { Flash } from '../../ui/Flash.tsx';

export function WriteError({ error }: { error: Error | null }) {
  if (!error) return null;
  const body = error instanceof ApiError ? error.body : {};
  const tasks = Array.isArray(body['tasks']) ? (body['tasks'] as Row[]) : [];
  const applied = Array.isArray(body['applied']) ? body['applied'].map(String) : [];
  return (
    <Flash variant="danger">
      <div className="space-y-1">
        <p>{error.message}</p>
        {applied.length > 0 && <p>Already applied before the error: {applied.join(', ')}</p>}
        {tasks.length > 0 && (
          <ul className="list-inside list-disc">
            {tasks.map((t) => (
              <li key={String(t['task_id'])}>
                <a href={hrefFor('task', t['task_id'])} className={`${ENTITY_LINK} underline`}>
                  task {String(t['task_id'])}
                </a>{' '}
                {t['status'] ? <Badge value={t['status']} /> : `commit ${String(t['commit_sha'] ?? '—').slice(0, 8)}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Flash>
  );
}

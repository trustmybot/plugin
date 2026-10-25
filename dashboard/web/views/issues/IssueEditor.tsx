import { useState } from 'react';
import { useIssueWrite, type IssueDetail, type Row } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { Button } from '../../ui/Button.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { parseLabels } from './labels.tsx';
import { WriteError } from './WriteError.tsx';

const splitLabels = (raw: string) => raw.split(',').map((l) => l.trim()).filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function IssueEditor({ id, detail, onDone }: { id: string; detail: IssueDetail; onDone: () => void }) {
  const { label_taxonomy: taxonomy, milestones } = detail;
  const [base] = useState(() => detail.issue);
  const changedElsewhere = detail.issue['updated_at'] !== base['updated_at'];
  const priorities = taxonomy.priority ?? [];
  const labels0 = parseLabels(base['labels']);
  const priority0 = labels0.find((l) => priorities.includes(l)) ?? '';
  const objective0 = String(base['objective'] ?? '');
  const description0 = String(base['description'] ?? '');
  const milestone0 = String(base['milestone'] ?? '');
  const [objective, setObjective] = useState(objective0);
  const [description, setDescription] = useState(description0);
  const [priority, setPriority] = useState(priority0);
  const [labels, setLabels] = useState(labels0.filter((l) => l !== priority0).join(', '));
  const [milestone, setMilestone] = useState(milestone0);
  const write = useIssueWrite(id, 'edit');

  const save = () => {
    const body: Row = { updated_at: base['updated_at'] };
    if (objective !== objective0) body['objective'] = objective;
    if (description !== description0) body['description'] = description;
    const nextLabels = [...splitLabels(labels), ...(priority ? [priority] : [])];
    if (!sameList(nextLabels, labels0)) body['labels'] = nextLabels;
    if (milestone !== milestone0) body['milestone'] = milestone;
    if (Object.keys(body).length === 1) return onDone();
    write.mutate(body, { onSuccess: onDone });
  };

  return (
    <form
      className="space-y-3 border-b border-(--borderColor-default) pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {changedElsewhere && (
        <div role="status">
          <Flash variant="warning">This issue changed since you started editing. Cancel and reopen the editor to see it; saving now is refused as stale.</Flash>
        </div>
      )}
      <label className="block space-y-1 text-sm font-semibold">
        <span>Objective</span>
        <input className={FIELD} value={objective} onChange={(e) => setObjective(e.target.value)} />
      </label>
      <label className="block space-y-1 text-sm font-semibold">
        <span>Description</span>
        <textarea className={`${FIELD} h-40 font-mono`} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block space-y-1 text-sm font-semibold">
          <span>Priority</span>
          <select className={FIELD} value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">—</option>
            {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm font-semibold">
          <span>Labels (comma-separated{taxonomy.classification ? `; one of ${taxonomy.classification.join(', ')}` : ''})</span>
          <input className={FIELD} value={labels} onChange={(e) => setLabels(e.target.value)} />
        </label>
        <label className="block space-y-1 text-sm font-semibold">
          <span>Milestone</span>
          <input className={FIELD} list="tmb-milestones" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
          <datalist id="tmb-milestones">
            {milestones.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
      </div>
      <WriteError error={write.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="small" disabled={write.isPending}>Save</Button>
        <Button size="small" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

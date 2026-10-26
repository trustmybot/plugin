import { GitBranchIcon, IssueOpenedIcon } from '@primer/octicons-react';
import type { TaskDetail } from '../../api.ts';
import { statusVariant } from '../../shared/Badge.tsx';
import { taskState } from '../../shared/taskState.ts';
import { Label } from '../../ui/Label.tsx';
import { TaskSidebar } from './TaskSidebar.tsx';
import { AgentRunsSection, CriteriaSection, ReviewsSection, SpecSection, VerificationSection } from './sections.tsx';

export function TaskPage({ detail }: { detail: TaskDetail }) {
  const { task, issue, validations, findings, verifications, agent_runs } = detail;
  const issueId = String(task['issue_id']);
  const StateIcon = taskState(task['status']).icon;
  return (
    <div className="space-y-6">
      <div className="space-y-2 border-b border-(--borderColor-default) pb-4">
        <h2 className="text-2xl leading-tight break-words text-fg md:text-[32px]">
          {String(task['title'] || task['branch_id'] || '')} <span className="font-light text-fg-muted">#{String(task['id'])}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <Label variant={statusVariant(String(task['status'] ?? ''))}>
            <StateIcon size={12} aria-hidden="true" />
            {String(task['status'] ?? '—')}
          </Label>
          {task['branch_id'] ? (
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              <GitBranchIcon size={16} aria-hidden="true" />
              {String(task['branch_id'])}
            </span>
          ) : null}
          <a href={`#/issues/${issueId}`} className="inline-flex min-w-0 items-center gap-1 text-(--fgColor-accent) hover:underline">
            <IssueOpenedIcon size={16} aria-hidden="true" />
            <span className="break-words">
              {issue ? String(issue.objective) : 'Issue'} #{issueId}
            </span>
          </a>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_256px]">
        <TaskSidebar task={task} />
        <div className="min-w-0 space-y-8">
          <SpecSection body={task['spec_body']} />
          <CriteriaSection report={task.completion_report} raw={task.completion_report_raw} />
          <ReviewsSection validations={validations} findings={findings} />
          <VerificationSection runs={verifications} />
          <AgentRunsSection runs={agent_runs} />
        </div>
      </div>
    </div>
  );
}

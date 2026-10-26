export type HelpKey = 'overview' | 'insights' | 'issues' | 'tasks' | 'runs' | 'audit' | 'map' | 'issue' | 'task';

export interface HelpEntry {
  intro: string;
  layers?: { name: string; text: string }[];
  uses: string[];
}

export const HELP_USES_HEADING = 'Use it to';

export const HELP: Record<HelpKey, HelpEntry> = {
  overview: {
    intro: "A snapshot of this project: open issues, tasks by status and headline counts. It reads the project's local TMB database.",
    uses: ['Check what is open before you start a session.', 'Spot tasks stuck in review or blocked.'],
  },
  insights: {
    intro: 'Charts of tokens, cost, time and outcomes per agent. Figures come from recorded runs in this project.',
    uses: ['Compare token use and cost across agents and models.', 'Spot runs that took longer than usual.', 'Export a chart as CSV.'],
  },
  issues: {
    intro: 'Every issue TMB tracks for this project, with its status and labels. Issues come from your requests to bro and from GitHub sync.',
    uses: ['Find an issue by title, label or status.', 'Check which issues still have open tasks.', 'Open an issue to read its discussion.'],
  },
  issue: {
    intro: "One issue's full history: the discussion, decisions and the tasks it was split into. Entries are written by you, bro and the agents as work happens.",
    uses: ['Read why a decision was made.', 'Check which tasks are done and which are left.', 'Add a note or question for the next session.'],
  },
  tasks: {
    intro: 'All tasks across issues, each a unit of work an agent picks up. Status updates as agents start, finish and pass review.',
    uses: ['Find tasks waiting on review or blocked.', 'Check who worked on a task and when.', 'Compare progress across issues.'],
  },
  task: {
    intro: "One task's spec, runs, commits and review results. It shows what the agent was asked to do and what it delivered.",
    uses: ['Check that the work matches the spec.', 'Read why a review passed or failed.', 'Find the branch or commit for this task.'],
  },
  runs: {
    intro: 'Each agent run and each check the work had to pass, such as tests and code review. Rows are recorded as runs start and gates report.',
    uses: ['Find runs that failed and see why.', 'Check which gate blocked a task.', 'See how long runs take.'],
  },
  audit: {
    intro: 'A time-ordered log of every recorded action: spawns, commits, status changes and denied tool calls. Nothing here can be edited.',
    uses: ['Trace what happened on an issue, step by step.', 'Find when and why a tool call was denied.', 'Check what an agent did while you were away.'],
  },
  map: {
    intro: 'The map agents read before they touch your code, so they do not have to re-read the repo each session. It has two layers.',
    layers: [
      { name: 'Structure', text: 'folders, files and the functions inside them, each with a one-line summary. /scan builds it from your code.' },
      {
        name: 'Concepts',
        text: 'features such as cold start, traced step by step through the functions that make them up. Agents write them, and each step is checked against the code; a step whose code changed is marked Suspect or Broken.',
      },
    ],
    uses: [
      'Find where a feature or function lives.',
      'Check whether a folder summary is out of date.',
      'Follow a concept through the code, step by step.',
      'See which concepts need checking after a change.',
    ],
  },
};

export const DETAIL_PAGE: Record<'issue' | 'task', string> = { issue: 'Issue detail', task: 'Task detail' };

export function helpKey(tab: string, id: string | undefined): HelpKey {
  if (id && tab === 'issues') return 'issue';
  if (id && tab === 'tasks') return 'task';
  return tab in HELP && !(tab in DETAIL_PAGE) ? (tab as HelpKey) : 'overview';
}

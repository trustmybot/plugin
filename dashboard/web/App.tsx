import { useEffect, useState } from 'react';
import {
  FileDirectoryIcon,
  HomeIcon,
  IssueOpenedIcon,
  LightBulbIcon,
  LogIcon,
  PlayIcon,
  TasklistIcon,
} from '@primer/octicons-react';
import { useLiveRefresh } from './api.ts';
import { AppHeader } from './ui/AppHeader.tsx';
import { UnderlineNav, type NavTab } from './ui/UnderlineNav.tsx';
import { AuditView } from './views/AuditView.tsx';
import { ConceptsView } from './views/concepts/ConceptsView.tsx';
import { IssuesView } from './views/IssuesView.tsx';
import { IssueView } from './views/IssueView.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { ProjectMapView } from './views/ProjectMapView.tsx';
import { RunsView } from './views/RunsView.tsx';
import { TasksView } from './views/TasksView.tsx';

export const TABS: readonly NavTab[] = [
  ['overview', 'Overview', HomeIcon],
  ['issues', 'Issues', IssueOpenedIcon],
  ['tasks', 'Tasks', TasklistIcon],
  ['runs', 'Runs & gates', PlayIcon],
  ['audit', 'Audit', LogIcon],
  ['map', 'Project map', FileDirectoryIcon],
  ['concepts', 'Concepts', LightBulbIcon],
];

function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  useLiveRefresh();
  const [tab = 'overview', id] = useHashRoute();
  return (
    <>
      <AppHeader />
      <UnderlineNav tabs={TABS} active={tab} />
      <main className="mx-auto w-full max-w-[120rem] space-y-4 px-4 py-4 sm:px-6 2xl:px-10">
        {tab === 'issues' && id ? <IssueView id={id} /> : tab === 'concepts' ? <ConceptsView id={id} /> : <TabView tab={tab} />}
      </main>
    </>
  );
}

function TabView({ tab }: { tab: string }) {
  switch (tab) {
    case 'issues': return <IssuesView />;
    case 'tasks': return <TasksView />;
    case 'runs': return <RunsView />;
    case 'audit': return <AuditView />;
    case 'map': return <ProjectMapView />;
    default: return <OverviewView />;
  }
}

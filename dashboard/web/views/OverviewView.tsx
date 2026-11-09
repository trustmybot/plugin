import { useApi, type IssueListing, type Summary } from '../api.ts';
import { Loading } from '../shared/Loading.tsx';
import { HealthSection } from './overview/Health.tsx';
import { Overview } from './overview/Overview.tsx';

export function OverviewView() {
  const summary = useApi<Summary>('summary');
  const issues = useApi<IssueListing>('issues');
  return (
    <div className="min-w-0 space-y-6">
      <Loading q={summary}>{(s) => <Overview summary={s} issues={{ data: issues.data?.issues, error: issues.error }} />}</Loading>
      <HealthSection />
    </div>
  );
}

import { useApi, type Row } from '../api.ts';
import { Loading } from '../shared/Loading.tsx';
import { useHashParam } from '../shared/route.ts';
import { IssueList } from './issues/IssueList.tsx';

export function IssuesView() {
  const q = useApi<Row[]>('issues');
  const state = useHashParam('state') === 'closed' ? 'closed' : 'open';
  return <Loading q={q}>{(rows) => <IssueList rows={rows} state={state} />}</Loading>;
}

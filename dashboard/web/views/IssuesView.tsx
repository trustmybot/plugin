import { useApi, type IssueListing } from '../api.ts';
import { Loading } from '../shared/Loading.tsx';
import { useHashParam } from '../shared/route.ts';
import { IssueList } from './issues/IssueList.tsx';

export function IssuesView() {
  const q = useApi<IssueListing>('issues');
  const state = useHashParam('state') === 'closed' ? 'closed' : 'open';
  const label = useHashParam('label') || null;
  const milestone = useHashParam('milestone') || null;
  return (
    <Loading q={q}>
      {(listing) => <IssueList rows={listing.issues} taxonomy={listing.label_taxonomy} state={state} label={label} milestone={milestone} />}
    </Loading>
  );
}

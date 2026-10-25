import { useApi, type IssueDetail } from '../api.ts';
import { Loading } from '../shared/Loading.tsx';
import { IssuePage } from './issues/IssuePage.tsx';

export function IssueView({ id }: { id: string }) {
  const q = useApi<IssueDetail>(`issues/${id}`);
  return <Loading q={q}>{(d) => <IssuePage id={id} detail={d} />}</Loading>;
}

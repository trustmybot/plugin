import { useApi, type TaskDetail } from '../../api.ts';
import { Loading } from '../../shared/Loading.tsx';
import { TaskPage } from './TaskPage.tsx';

export function TaskView({ id }: { id: string }) {
  const q = useApi<TaskDetail>(`tasks/${id}`);
  return <Loading q={q}>{(d) => <TaskPage detail={d} />}</Loading>;
}

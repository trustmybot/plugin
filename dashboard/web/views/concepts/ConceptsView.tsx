import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { query, useApi, type ConceptHit, type ConceptSearch, type Trust } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { go, hashPath, routeQuery } from '../../shared/route.ts';
import { DerivedBadge, TrustBadge } from './badges.tsx';
import { CONCEPT_COPY, conceptsPath, DERIVED_ID, FOCUS, MIN_QUERY, MUTED, stepCount, TRUST_LABEL } from './copy.ts';
import { DerivedPanel, SavedPanel } from './panels.tsx';

export function ConceptsView({ id }: { id: string | undefined }) {
  const [input, setInput] = useState(routeQuery);
  const [term, setTerm] = useState(() => input.trim());
  const termRef = useRef(term);
  const [repo, setRepo] = useState('');
  useEffect(() => {
    const onHash = () => {
      const q = routeQuery();
      if (q === termRef.current) return;
      termRef.current = q;
      setInput(q);
      setTerm(q);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = input.trim();
      if (next === termRef.current) return;
      termRef.current = next;
      setTerm(next);
      if (routeQuery() !== next) window.history.replaceState(null, '', `#/${hashPath()}${next ? `?${query({ q: next })}` : ''}`);
    }, 200);
    return () => clearTimeout(t);
  }, [input]);
  const search = useApi<ConceptSearch>(`concepts?${query({ q: term, repo })}`, { keepPrevious: true });
  const data = search.data;

  if (search.error) return <p role="alert" className="text-red-700 dark:text-red-400">{search.error.message}</p>;
  if (data && !data.available) return <p role="status" className={MUTED}>{CONCEPT_COPY.unavailable}</p>;

  const hits = data?.concepts ?? [];
  const derived = data?.derived ?? null;
  const searching = term.length >= MIN_QUERY;
  const announce = !searching || !data
    ? ''
    : hits.length === 0
      ? `${CONCEPT_COPY.empty}${derived ? ' Showing an unverified chain built from the call graph.' : ''}`
      : `${hits.length} ${hits.length === 1 ? 'concept' : 'concepts'} found.`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-64 flex-1 text-sm">
          <span className="sr-only">Search concepts</span>
          <input
            type="search"
            className={`${FIELD} min-h-8 ${FOCUS}`}
            placeholder={CONCEPT_COPY.placeholder}
            aria-describedby="concepts-help"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        {data && data.repos.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            Repo
            <select className={`${FIELD} min-h-8 w-auto ${FOCUS}`} value={repo || data.repos[0]} onChange={(e) => setRepo(e.target.value)}>
              {data.repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
      </div>
      <p id="concepts-help" className={`text-sm ${MUTED}`}>{CONCEPT_COPY.help}</p>
      <p role="status" aria-live="polite" className={`text-sm ${MUTED}`}>{announce}</p>
      <div className="grid gap-4 lg:grid-cols-[240px_420px_minmax(0,1fr)]">
        <section aria-label="Results" className="space-y-2">
          <ResultList hits={hits} derived={derived} selected={id} onSelect={(key) => go(conceptsPath(key, term))} />
        </section>
        {id === DERIVED_ID ? (
          derived ? (
            <DerivedPanel steps={derived.steps} />
          ) : (
            <p className={`text-sm ${MUTED}`}>No unverified chain for this search. Try a function name.</p>
          )
        ) : id ? (
          <SavedPanel id={id} />
        ) : (
          <p className={`text-sm ${MUTED}`}>{searching ? 'Select a result to see its steps.' : ''}</p>
        )}
      </div>
    </div>
  );
}

interface ResultItem {
  key: string;
  hit: ConceptHit | null;
}

function ResultList({
  hits,
  derived,
  selected,
  onSelect,
}: {
  hits: ConceptHit[];
  derived: ConceptSearch['derived'];
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  const items: ResultItem[] = [...hits.map((hit) => ({ key: String(hit.id), hit })), ...(derived ? [{ key: DERIVED_ID, hit: null }] : [])];
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  if (items.length === 0) return null;
  const current = Math.min(active, items.length - 1);
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const moves: Record<string, number> = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: items.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      setActive(Math.min(Math.max(moves[e.key]!, 0), items.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(items[current]!.key);
    }
  };
  return (
    <ul
      role="listbox"
      tabIndex={0}
      aria-label="Concepts"
      aria-activedescendant={`concept-option-${items[current]!.key}`}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={`space-y-1 rounded ${FOCUS}`}
    >
      {items.map(({ key, hit }, i) => (
        <li
          key={key}
          id={`concept-option-${key}`}
          role="option"
          aria-selected={selected === key}
          onClick={() => {
            setActive(i);
            onSelect(key);
          }}
          className={`min-h-6 cursor-pointer space-y-1 rounded border px-2 py-1.5 text-sm ${
            selected === key ? 'border-zinc-400 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-800' : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900'
          } ${focused && i === current ? 'outline-2 outline-blue-600 dark:outline-blue-400' : ''}`}
        >
          {hit ? (
            <>
              <div className="font-medium">{hit.name}</div>
              <div className={`text-xs ${MUTED}`}>{stepCount(hit.step_count)}</div>
              <div className="flex flex-wrap gap-1">
                {(Object.keys(TRUST_LABEL) as Trust[]).filter((t) => hit.trust[t] > 0).map((t) => (
                  <TrustBadge key={t} trust={t} count={hit.trust[t]} />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium">{derived?.steps[0]?.symbol?.qualified_name ?? 'Call chain'}</div>
              <div className={`text-xs ${MUTED}`}>{stepCount(derived?.steps.length ?? 0)}</div>
              <DerivedBadge />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

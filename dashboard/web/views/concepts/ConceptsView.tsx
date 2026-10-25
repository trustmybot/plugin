import { LightBulbIcon, SearchIcon } from '@primer/octicons-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { query, useApi, type ConceptHit, type ConceptSearch, type Trust } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { go, hashPath, routeQuery } from '../../shared/route.ts';
import { Blankslate } from '../../ui/Blankslate.tsx';
import { Box } from '../../ui/Box.tsx';
import { CounterLabel } from '../../ui/CounterLabel.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { DerivedBadge, TrustBadge } from './badges.tsx';
import { CONCEPT_COPY, conceptsPath, DERIVED_ID, MIN_QUERY, MUTED, stepCount, TRUST_LABEL } from './copy.ts';
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

  if (search.error) return <Flash variant="danger">{search.error.message}</Flash>;
  if (data && !data.available) {
    return (
      <Box role="status">
        <Blankslate icon={LightBulbIcon} heading="No concepts yet" description={CONCEPT_COPY.unavailable} />
      </Box>
    );
  }

  const hits = data?.concepts ?? [];
  const derived = data?.derived ?? null;
  const searching = term.length >= MIN_QUERY;
  const announce = !searching || !data
    ? ''
    : hits.length === 0
      ? `${CONCEPT_COPY.empty}${derived ? ' Showing an unverified chain built from the call graph.' : ''}`
      : `${hits.length} ${hits.length === 1 ? 'concept' : 'concepts'} found.`;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <SearchField value={input} onChange={setInput} />
        {data && data.repos.length > 1 && (
          <label className="flex items-center gap-2 text-sm font-semibold">
            Repo
            <select className={`${FIELD} min-h-8 w-auto font-normal`} value={repo || data.repos[0]} onChange={(e) => setRepo(e.target.value)}>
              {data.repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
      </div>
      <p id="concepts-help" className={`text-sm ${MUTED}`}>{CONCEPT_COPY.help}</p>
      <p role="status" aria-live="polite" className={`text-sm ${MUTED}`}>{announce}</p>
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,400px)_minmax(0,1fr)]">
        <section aria-label="Results" className="min-w-0">
          {searching && data && hits.length === 0 && !derived ? (
            <Box>
              <Blankslate icon={SearchIcon} heading="No concepts found" description={CONCEPT_COPY.empty} />
            </Box>
          ) : (
            <ResultList hits={hits} derived={derived} selected={id} onSelect={(key) => go(conceptsPath(key, term))} />
          )}
        </section>
        {id === DERIVED_ID ? (
          derived ? (
            <DerivedPanel steps={derived.steps} />
          ) : (
            <Box>
              <Blankslate icon={SearchIcon} heading="No unverified chain" description="No unverified chain for this search. Try a function name." />
            </Box>
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

export function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block min-w-0 flex-1 basis-64 text-sm">
      <span className="sr-only">Search concepts</span>
      <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
      <input
        type="search"
        className={`${FIELD} min-h-8 pl-8`}
        placeholder={CONCEPT_COPY.placeholder}
        aria-describedby="concepts-help"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
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
      className="overflow-hidden rounded-md border border-(--borderColor-default) bg-canvas focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-offset-2 focus-visible:outline-(--focus-outline-color)"
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
          className={`group cursor-pointer space-y-1 border-t border-l-2 border-t-(--borderColor-muted) px-3 py-2 text-sm first:border-t-0 ${
            selected === key ? 'border-l-(--borderColor-accent-emphasis) bg-(--bgColor-accent-muted)' : 'border-l-transparent hover:bg-canvas-muted'
          } ${focused && i === current ? 'outline-(length:--focus-outline-width) -outline-offset-2 outline-(--focus-outline-color)' : ''}`}
        >
          {hit ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold break-words text-fg group-hover:text-(--fgColor-accent)">{hit.name}</span>
                <StepCounter n={hit.step_count} />
              </div>
              {hit.body && <div className={`truncate text-xs ${MUTED}`}>{hit.body}</div>}
              <div className="flex flex-wrap gap-1">
                {(Object.keys(TRUST_LABEL) as Trust[]).filter((t) => hit.trust[t] > 0).map((t) => (
                  <TrustBadge key={t} trust={t} count={hit.trust[t]} />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono font-semibold break-all text-fg group-hover:text-(--fgColor-accent)">
                  {derived?.steps[0]?.symbol?.qualified_name ?? 'Call chain'}
                </span>
                <StepCounter n={derived?.steps.length ?? 0} />
              </div>
              <DerivedBadge />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function StepCounter({ n }: { n: number }) {
  return (
    <CounterLabel>
      <span className="sr-only">{stepCount(n)}</span>
      <span aria-hidden="true">{n}</span>
    </CounterLabel>
  );
}

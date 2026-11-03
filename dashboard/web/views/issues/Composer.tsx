import { useState } from 'react';
import { IssueClosedIcon } from '@primer/octicons-react';
import { useIssueWrite } from '../../api.ts';
import { Markdown } from '../../Markdown.tsx';
import { FIELD } from '../../shared/classes.ts';
import { Button } from '../../ui/Button.tsx';
import { WriteError } from './WriteError.tsx';

type Tab = 'write' | 'preview';

function ComposerTab({ tab, current, onSelect }: { tab: Tab; current: Tab; onSelect: (tab: Tab) => void }) {
  const selected = tab === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(tab)}
      className={`-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-sm focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) ${
        selected ? 'border-(--borderColor-default) bg-canvas text-fg' : 'border-transparent text-fg-muted hover:text-fg'
      }`}
    >
      {tab === 'write' ? 'Write' : 'Preview'}
    </button>
  );
}

export function Composer({ id, open, updatedAt }: { id: string; open: boolean; updatedAt: string }) {
  const [text, setText] = useState('');
  const [tab, setTab] = useState<Tab>('write');
  const comment = useIssueWrite(id, 'comment');
  const close = useIssueWrite(id, 'close');
  return (
    <form
      className="rounded-md border border-(--borderColor-default) bg-canvas sm:ml-14"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) comment.mutate({ body: text }, { onSuccess: () => (setText(''), setTab('write')) });
      }}
    >
      <div role="tablist" aria-label="Comment" className="flex gap-1 rounded-t-md border-b border-(--borderColor-default) bg-canvas-muted px-2 pt-2">
        <ComposerTab tab="write" current={tab} onSelect={setTab} />
        <ComposerTab tab="preview" current={tab} onSelect={setTab} />
      </div>
      <div className="space-y-2 p-2">
        {tab === 'write' ? (
          <textarea
            aria-label="Comment body"
            className={`${FIELD} min-h-24 resize-y bg-canvas-muted py-2`}
            placeholder="Add a comment as the Human — bro sees it on its next read of this issue"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div className="min-h-24 border-b border-(--borderColor-muted) px-2 py-2">
            {text.trim() ? <Markdown>{text}</Markdown> : <p className="text-sm text-fg-muted">Nothing to preview</p>}
          </div>
        )}
        <WriteError error={comment.error} />
        <WriteError error={close.error} />
        <div className="flex flex-wrap justify-end gap-2">
          {open && (
            <Button
              leadingVisual={IssueClosedIcon}
              disabled={close.isPending}
              onClick={() => {
                if (window.confirm(`Close issue #${id}?`)) close.mutate({ updated_at: updatedAt });
              }}
            >
              Close Issue
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={comment.isPending || !text.trim()}>Comment</Button>
        </div>
      </div>
    </form>
  );
}

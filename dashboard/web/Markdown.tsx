import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const COMPONENTS: Components = {
  h1: ({ node: _, ...p }) => <h1 className="mt-4 mb-2 text-lg font-semibold first:mt-0" {...p} />,
  h2: ({ node: _, ...p }) => <h2 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...p} />,
  h3: ({ node: _, ...p }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0" {...p} />,
  h4: ({ node: _, ...p }) => <h4 className="mt-3 mb-1 font-medium first:mt-0" {...p} />,
  h5: ({ node: _, ...p }) => <h5 className="mt-2 mb-1 font-medium first:mt-0" {...p} />,
  h6: ({ node: _, ...p }) => <h6 className="mt-2 mb-1 font-medium first:mt-0" {...p} />,
  p: ({ node: _, ...p }) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  ul: ({ node: _, ...p }) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: ({ node: _, ...p }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  a: ({ node: _, ...p }) => <a className="text-blue-700 underline dark:text-blue-400" target="_blank" rel="noreferrer noopener" {...p} />,
  blockquote: ({ node: _, ...p }) => (
    <blockquote className="my-2 border-l-4 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400" {...p} />
  ),
  pre: ({ node: _, ...p }) => (
    <pre className="my-2 overflow-x-auto rounded bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900 [&_code]:bg-transparent [&_code]:p-0" {...p} />
  ),
  code: ({ node: _, className, ...p }) => (
    <code className={`rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800 ${className ?? ''}`} {...p} />
  ),
  table: ({ node: _, ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-left text-sm" {...p} />
    </div>
  ),
  th: ({ node: _, ...p }) => <th className="border border-zinc-200 bg-zinc-100 px-2 py-1 font-medium dark:border-zinc-800 dark:bg-zinc-900" {...p} />,
  td: ({ node: _, ...p }) => <td className="border border-zinc-200 px-2 py-1 align-top dark:border-zinc-800" {...p} />,
  hr: ({ node: _, ...p }) => <hr className="my-3 border-zinc-200 dark:border-zinc-800" {...p} />,
};

const INLINE_ELEMENTS = ['strong', 'em', 'del', 'code'];

export function Markdown({ children, className = '', inline = false }: { children: string; className?: string; inline?: boolean }) {
  if (inline) {
    return (
      <span className={`break-words ${className}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} allowedElements={INLINE_ELEMENTS} unwrapDisallowed skipHtml>
          {children}
        </ReactMarkdown>
      </span>
    );
  }
  return (
    <div className={`min-w-0 text-sm break-words ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}

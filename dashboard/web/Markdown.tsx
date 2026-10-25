import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const COMPONENTS: Components = {
  h1: ({ node: _, ...p }) => <h1 className="mt-6 mb-4 border-b border-(--borderColor-muted) pb-[.3em] text-2xl font-semibold first:mt-0" {...p} />,
  h2: ({ node: _, ...p }) => <h2 className="mt-6 mb-4 border-b border-(--borderColor-muted) pb-[.3em] text-xl font-semibold first:mt-0" {...p} />,
  h3: ({ node: _, ...p }) => <h3 className="mt-6 mb-4 text-base font-semibold first:mt-0" {...p} />,
  h4: ({ node: _, ...p }) => <h4 className="mt-6 mb-4 font-semibold first:mt-0" {...p} />,
  h5: ({ node: _, ...p }) => <h5 className="mt-6 mb-4 text-sm font-semibold first:mt-0" {...p} />,
  h6: ({ node: _, ...p }) => <h6 className="mt-6 mb-4 text-sm font-semibold text-fg-muted first:mt-0" {...p} />,
  p: ({ node: _, ...p }) => <p className="mt-0 mb-4 last:mb-0" {...p} />,
  ul: ({ node: _, ...p }) => <ul className="mt-0 mb-4 list-disc space-y-1 pl-8 last:mb-0 [&_ol]:mb-0 [&_ul]:mb-0" {...p} />,
  ol: ({ node: _, ...p }) => <ol className="mt-0 mb-4 list-decimal space-y-1 pl-8 last:mb-0 [&_ol]:mb-0 [&_ul]:mb-0" {...p} />,
  a: ({ node: _, ...p }) => <a className="text-(--fgColor-accent) hover:underline" target="_blank" rel="noreferrer noopener" {...p} />,
  blockquote: ({ node: _, ...p }) => (
    <blockquote className="mt-0 mb-4 border-l-4 border-(--borderColor-default) px-4 text-fg-muted last:mb-0" {...p} />
  ),
  pre: ({ node: _, ...p }) => (
    <pre
      className="mt-0 mb-4 overflow-x-auto rounded-md bg-(--bgColor-muted) p-4 font-mono text-[85%] leading-[1.45] last:mb-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[100%]"
      {...p}
    />
  ),
  code: ({ node: _, className, ...p }) => (
    <code className={`rounded-md bg-(--bgColor-muted) px-[.4em] py-[.2em] font-mono text-[85%] ${className ?? ''}`} {...p} />
  ),
  table: ({ node: _, ...p }) => (
    <div className="mt-0 mb-4 overflow-x-auto last:mb-0">
      <table className="border-collapse text-left" {...p} />
    </div>
  ),
  th: ({ node: _, ...p }) => <th className="border border-(--borderColor-default) bg-canvas-muted px-3 py-1.5 font-semibold" {...p} />,
  td: ({ node: _, ...p }) => <td className="border border-(--borderColor-default) px-3 py-1.5 align-top" {...p} />,
  hr: ({ node: _, ...p }) => <hr className="my-6 h-1 border-0 bg-(--borderColor-default)" {...p} />,
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
    <div className={`min-w-0 text-sm leading-normal break-words ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}

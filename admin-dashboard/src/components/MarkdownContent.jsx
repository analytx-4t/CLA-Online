import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Renders the markdown that comes back from the chatbot (headings, bold key
// terms, lists, citation tags like [1]) as actual formatted text instead of
// showing the raw #/**/- characters, matching how the chat UI itself renders
// the same answers.
export default function MarkdownContent({ content }) {
  if (!content) return <span className="text-muted">—</span>;

  return (
    <div className="space-y-2 text-sm leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-bold text-ink first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[15px] font-bold text-ink first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-bold text-ink first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-2.5 mb-1 text-sm font-bold text-ink first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-accent">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          hr: () => <hr className="my-3 border-line" />,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline">{children}</a>,
          code: ({ children }) => <code className="rounded bg-surface-strong px-1 py-0.5 text-xs">{children}</code>,
          table: ({ children }) => <div className="mb-2 overflow-x-auto"><table className="w-full border-collapse text-xs">{children}</table></div>,
          th: ({ children }) => <th className="border border-line px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

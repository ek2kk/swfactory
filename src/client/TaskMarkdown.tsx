import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function TaskMarkdown({ children }: { children: string }) {
  return <div className="task-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
    a: ({ href, title, children }) => href ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt || 'Изображение'}</span>,
    table: ({ children }) => <div className="markdown-table" role="region" aria-label="Таблица требований" tabIndex={0}><table>{children}</table></div>,
    pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  }}>{children}</Markdown></div>;
}

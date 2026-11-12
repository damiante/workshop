import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../markdown.ts';

function inlines(items: Inline[]): ReactNode {
  return items.map((n, i) => {
    if (typeof n === 'string') return n;
    switch (n.t) {
      case 'code':
        return <code key={i}>{n.text}</code>;
      case 'strong':
        return <strong key={i}>{inlines(n.children)}</strong>;
      case 'em':
        return <em key={i}>{inlines(n.children)}</em>;
      case 'del':
        return <del key={i}>{inlines(n.children)}</del>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer">
            {inlines(n.children)}
          </a>
        );
      case 'br':
        return <br key={i} />;
    }
  });
}

function blocks(items: Block[]): ReactNode {
  return items.map((b, i) => {
    switch (b.t) {
      case 'p':
        return <p key={i}>{inlines(b.children)}</p>;
      case 'h': {
        const H = `h${Math.min(b.level + 2, 6)}` as 'h3';
        return <H key={i}>{inlines(b.children)}</H>;
      }
      case 'list': {
        const body = b.items.map((item, k) => (
          <li key={k}>{item.length === 1 && item[0].t === 'p' ? inlines(item[0].children) : blocks(item)}</li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start === 1 ? undefined : b.start}>
            {body}
          </ol>
        ) : (
          <ul key={i}>{body}</ul>
        );
      }
      case 'code':
        return (
          <pre key={i}>
            <code data-lang={b.lang || undefined}>{b.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{blocks(b.children)}</blockquote>;
      case 'hr':
        return <hr key={i} />;
      case 'table':
        return (
          <div key={i} className="table-wrap">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, k) => (
                    <th key={k} style={{ textAlign: b.align[k] ?? undefined }}>
                      {inlines(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, k) => (
                      <td key={k} style={{ textAlign: b.align[k] ?? undefined }}>
                        {inlines(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return <div className={'markdown' + (className ? ` ${className}` : '')}>{blocks(tree)}</div>;
}

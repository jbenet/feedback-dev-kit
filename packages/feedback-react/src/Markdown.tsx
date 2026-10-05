import { safeLinkHref } from './config';
import { parseInline, parseMarkdown, type Block, type Inline } from './markdown-parse';

/**
 * The small markdown renderer, as components.
 *
 * Shared by the feedback editor's preview and the issue page, so **what you see before you
 * file is what gets rendered after**. Two renderers would drift, and the one people check
 * against is the one they stop trusting.
 *
 * `resolveImage` exists because an image reference means different things at different
 * moments: a data URL while you are still typing, a route under the issues directory once
 * the file is written. The markdown does not change; only the resolver does.
 */
export function Spans({
  src, resolveImage,
}: {
  src: string;
  resolveImage?: (href: string) => string | null;
}) {
  return (
    <>
      {parseInline(src).map((s: Inline, i) => {
        if (s.kind === 'code') return <code key={i}>{s.text}</code>;
        if (s.kind === 'strong') return <b key={i}>{s.text}</b>;
        if (s.kind === 'em') return <i key={i}>{s.text}</i>;
        if (s.kind === 'image') {
          const href = resolveImage ? resolveImage(s.href ?? '') : s.href ?? '';
          if (!href) {
            return (
              <span key={i} className="mdmissing">
                image not attached: {s.text || s.href}
              </span>
            );
          }
          // eslint-disable-next-line @next/next/no-img-element
          return <img key={i} className="mdimg" src={href} alt={s.text} loading="lazy" />;
        }
        if (s.kind === 'link') {
          // Issue text is written by reporters: only web, mail, same-site and anchor links are links.
          // `javascript:`, `data:` and protocol-relative `//elsewhere` are shown as their text.
          const href = safeLinkHref(s.href ?? '');
          if (!href) return <span key={i}>{s.text}</span>;
          return /^https?:/i.test(href) ? (
            <a key={i} href={href} target="_blank" rel="noreferrer noopener">{s.text}</a>
          ) : (
            <a key={i} href={href}>{s.text}</a>
          );
        }
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

function Rendered({
  block, resolveImage,
}: {
  block: Block;
  resolveImage?: (href: string) => string | null;
}) {
  switch (block.kind) {
    case 'heading':
      return (
        <h3 className={`mdh mdh${block.level}`} id={block.id}>
          <Spans src={block.text} resolveImage={resolveImage} />
        </h3>
      );
    case 'paragraph':
      return <p><Spans src={block.text} resolveImage={resolveImage} /></p>;
    case 'list':
      return block.ordered ? (
        <ol>{block.items.map((t, i) => <li key={i}><Spans src={t} resolveImage={resolveImage} /></li>)}</ol>
      ) : (
        <ul>{block.items.map((t, i) => <li key={i}><Spans src={t} resolveImage={resolveImage} /></li>)}</ul>
      );
    case 'code':
      return <pre className="block">{block.text}</pre>;
    case 'quote':
      return <blockquote><Spans src={block.text} resolveImage={resolveImage} /></blockquote>;
    case 'table':
      return (
        <div className="scroller">
          <table className="list">
            <thead>
              <tr>{block.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => <td key={j}><Spans src={c} resolveImage={resolveImage} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr />;
    default:
      return null;
  }
}

export function Markdown({
  source, resolveImage,
}: {
  source: string;
  resolveImage?: (href: string) => string | null;
}) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return (
    <div className="prose md">
      {blocks.map((b, i) => <Rendered key={i} block={b} resolveImage={resolveImage} />)}
    </div>
  );
}

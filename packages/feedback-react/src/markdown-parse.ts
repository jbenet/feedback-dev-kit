/**
 * A very small markdown renderer.
 *
 * Shared by the feedback box and the issue page. Document-specific additions are opt-in
 * so the default rendering keeps its original parsing behavior.
 */

export type Block =
  | { kind: 'heading'; level: number; text: string; id: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[]; markers?: string[]; indents?: number[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const splitRow = (line: string, document: boolean): string[] => {
  const row = line.replace(/^\||\|$/g, '');
  if (!document) return row.split('|').map((c) => c.trim());
  // A backslash-escaped pipe belongs to its cell, including inside inline code.
  const cells = [''];
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (char === '\\' && row[i + 1] === '|') { cells[cells.length - 1] += '|'; i += 1; }
    else if (char === '|') cells.push('');
    else cells[cells.length - 1] += char;
  }
  return cells.map((cell) => cell.trim());
};

export function parseMarkdown(src: string, options: { document?: boolean } = {}): Block[] {
  const lines = src.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length) blocks.push({ kind: 'paragraph', text: buf.join(' ').trim() });
    buf.length = 0;
  };

  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      flushParagraph(para);
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      flushParagraph(para);
      const body: string[] = [];
      i += 1;
      // A document may embed a fenced JSON sample inside a fenced Markdown sample.
      // Keep that sample literal. Also accept ordinary longer Markdown fences.
      const fence = /^(`{3,})(.*)$/.exec(line)!;
      let nested = 0;
      while (i < lines.length) {
        const nextFence = /^(`{3,})(.*)$/.exec(lines[i]!);
        if (!options.document && nextFence) break;
        if (options.document && nextFence) {
          if (fence[2]!.trim() === 'markdown' && nextFence[2]!.trim()) nested += 1;
          else if (!nextFence[2]!.trim()) {
            if (nested > 0) nested -= 1;
            else if (nextFence[1]!.length >= fence[1]!.length) break;
          }
        }
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(para);
      const text = heading[2]!.trim();
      blocks.push({ kind: 'heading', level: heading[1]!.length, text, id: slugify(text) });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph(para);
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: body.join(' ').trim() });
      continue;
    }

    if (/^\|/.test(line)) {
      flushParagraph(para);
      const head = splitRow(line, options.document === true);
      i += 1;
      // The |---|---| separator row, which carries no data.
      if (i < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i]!)) i += 1;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) {
        rows.push(splitRow(lines[i]!, options.document === true));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    const bullet = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(para);
      const ordered = /\d/.test(bullet[1]!);
      const items: string[] = [];
      const markers: string[] = [];
      const indents: number[] = [];
      while (i < lines.length) {
        const next = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!next) {
          // A wrapped continuation line belongs to the item above it.
          if (/^\s{2,}\S/.test(lines[i] ?? '') && items.length) {
            items[items.length - 1] += ` ${lines[i]!.trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        items.push(next[2]!);
        markers.push(next[1]!);
        indents.push(/^\s*/.exec(lines[i]!)![0].length);
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items, ...(options.document ? { markers, indents } : {}) });
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushParagraph(para);
  return blocks;
}

export interface Inline {
  kind: 'text' | 'code' | 'strong' | 'em' | 'link' | 'image';
  text: string;
  href?: string;
}

/** Inline spans: `code`, **strong**, *em*, [link](href), ![alt](src). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const pattern =
    /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(src)) !== null) {
    if (match.index > last) out.push({ kind: 'text', text: src.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: 'image', text: match[1], href: match[2] });
    else if (match[3] !== undefined) out.push({ kind: 'link', text: match[3], href: match[4] });
    else if (match[5] !== undefined) out.push({ kind: 'code', text: match[5] });
    else if (match[6] !== undefined) out.push({ kind: 'strong', text: match[6] });
    else if (match[7] !== undefined) out.push({ kind: 'em', text: match[7] });
    else if (match[8] !== undefined) out.push({ kind: 'em', text: match[8] });
    last = pattern.lastIndex;
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
  return out;
}


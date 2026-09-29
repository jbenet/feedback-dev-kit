/**
 * The fallback title: the first sentence somebody wrote, at most 80 characters.
 *
 * Taking the first *line* and cutting it gave "…are hard to see (in this…" for every report written
 * as two sentences on one line. This takes the first sentence, drops parenthetical asides before
 * cutting anything, prefers a clause boundary to a word boundary, and only then uses an ellipsis.
 * It returns '' when there is nothing to name: intake can invent a title, not a complaint.
 */
export const TITLE_MAX = 80;

export function titleFrom(body: string): string {
  const line = continuations(body)
    .split(/\n/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s*/, '').trim())
    // A line with no letter or digit names nothing (a lone backslash once became a title).
    .find((l) => /[\p{L}\p{N}]/u.test(l) && !l.startsWith('```') && !l.startsWith('!['));
  if (!line) return '';

  let t = line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';

  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(t);
  if (sentence && sentence[1]!.length >= 12) t = sentence[1]!;
  t = t.replace(/[.,:;\s—-]+$/, '').trim();

  if (t.length > TITLE_MAX) t = t.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > TITLE_MAX) {
    const head = t.slice(0, TITLE_MAX);
    const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '), head.lastIndexOf(': '));
    t = clause >= 32 ? head.slice(0, clause) : `${head.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * A backslash at the end of a line is a terminal's typed newline (backslash, then Enter), not text
 * anybody meant to file. Removed at line ends; a backslash anywhere else is kept.
 */
export function continuations(text: string): string {
  return text.replace(/[ \t]*\\[ \t]*(?=\r?\n|$)/g, '');
}

/**
 * What a model (or anything else) proposed, made safe to use as a title: one line, no wrapping
 * quotes or markdown, no trailing full stop, at most 80 characters. '' when nothing usable is left.
 */
export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '';
  let t = line
    .replace(/^(?:title\s*:\s*)/i, '')
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/^["'“‘«]+|["'”’»]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  // Control characters never belong in a title (a frontmatter line, a GitHub title).
  t = t.replace(/\p{Cc}/gu, '');
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…`;
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

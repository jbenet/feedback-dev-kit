'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { themeStyle, useFeedbackConfig } from '../config';
import { isTypingTarget } from '../keyboard';
import { ago } from '../time';
import { KINDS, PRIORITIES, STATUSES, type Issue } from './types';

/** A link component, so a router's own (Next's Link) can replace a plain <a>. */
export type LinkLike = ComponentType<{ href: string; className?: string; children?: ReactNode }>;
const PlainLink: LinkLike = ({ href, className, children }) => <a href={href} className={className}>{children}</a>;

type StatusFilter = string | 'all' | 'not-done';

/** Lower case, accents folded: "Café" is found by "cafe". */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** The text to search, built once per issue list rather than per keystroke. */
const haystack = (i: Issue) =>
  fold([i.id, i.title, i.body, i.reporter, i.page, (i.labels ?? []).join(' ')].join('\n'));

/**
 * The issues, filtered and searched in the browser.
 *
 * The list is hundreds of issues at worst, so a round trip per chip or per keystroke would cost
 * more than the filtering. Search matches every word typed, anywhere in the id, title, body,
 * reporter or page; `/` focuses it. The default hides `done`, because the open queue is the
 * question people arrive with — and the count says how many rows that hid.
 */
export function IssueList({
  issues, hrefFor, Link = PlainLink, initialStatus = 'not-done', title = 'All issues',
}: {
  issues: Issue[];
  /** Where a row links. Default: the provider's issueHref. */
  hrefFor?: (id: string) => string;
  Link?: LinkLike;
  initialStatus?: StatusFilter;
  title?: string;
}) {
  const config = useFeedbackConfig();
  const href = hrefFor ?? config.issueHref;
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [priority, setPriority] = useState<string>('all');
  const [kind, setKind] = useState<string>('all');
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('dialog[open], [role="dialog"]:not(dialog)')) return;
      e.preventDefault();
      search.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const indexed = useMemo(() => issues.map((i) => ({ issue: i, text: haystack(i) })), [issues]);
  const statuses = useMemo(() => [...STATUSES, ...new Set(issues.map((i) => i.status).filter((s) => !(STATUSES as string[]).includes(s)))], [issues]);

  const rows = useMemo(() => {
    const words = fold(deferred).split(/\s+/).filter(Boolean);
    return indexed.filter(({ issue: i, text }) => {
      if (status === 'not-done' ? i.status === 'done' : status !== 'all' && i.status !== status) return false;
      if (priority !== 'all' && i.priority !== priority) return false;
      if (kind !== 'all' && i.kind !== kind) return false;
      return words.every((w) => text.includes(w));
    }).map((x) => x.issue);
  }, [indexed, status, priority, kind, deferred]);

  const hidden = issues.length - rows.length;
  const chip = (on: boolean, label: string, act: () => void) => (
    <button key={label} type="button" className={on ? 'on' : ''} onClick={act} aria-pressed={on}>{label}</button>
  );

  return (
    <div className="fbk" style={themeStyle(config.theme)}><div className="card issuelist">
      <div className="chead">
        <h2>{title}</h2>
        <span className="lbl" role="status">
          {rows.length} shown{hidden > 0 ? ` · ${hidden} filtered out` : ''} · {issues.length} on file
        </span>
      </div>

      <div className="issuesearch">
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
          placeholder="Search issues — words in the title, text, reporter or page"
          aria-label="Search issues"
          aria-keyshortcuts="/"
        />
        <kbd aria-hidden>/</kbd>
      </div>
      <div className="sorter" style={{ padding: '10px 15px 0' }} role="group" aria-label="Status">
        {chip(status === 'not-done', 'Not done', () => setStatus('not-done'))}
        {statuses.map((s) => chip(status === s, s, () => setStatus(s)))}
        {chip(status === 'all', 'Any status', () => setStatus('all'))}
      </div>
      <div className="sorter" style={{ padding: '6px 15px 0' }}>
        <span role="group" aria-label="Priority" className="sortergroup">
          {chip(priority === 'all', 'Any priority', () => setPriority('all'))}
          {PRIORITIES.map((p) => chip(priority === p, p, () => setPriority(p)))}
        </span>
        <span role="group" aria-label="Kind" className="sortergroup">
          {chip(kind === 'all', 'Any kind', () => setKind('all'))}
          {KINDS.map((k) => chip(kind === k, k, () => setKind(k)))}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="cbody">
          <div className="empty">
            <span className="stat unavailable"><i />Nothing matches</span>
            <h3>{issues.length ? 'No issue on file matches these filters.' : 'No issues have been filed yet.'}</h3>
            <p>
              {issues.length
                ? `${issues.length} issue${issues.length === 1 ? ' is' : 's are'} filed. This is a statement about the filters, not about the queue.`
                : 'Press Give feedback to file the first one.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="scroller">
          <table className="list">
            <thead>
              <tr>
                <th style={{ width: 60 }}>Id</th>
                <th>Title</th>
                <th style={{ width: 90 }}>Kind</th>
                <th style={{ width: 62 }}>Priority</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 80 }}>Fixed in</th>
                <th style={{ width: 96 }}>Filed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="clickable">
                  <td className="mono muted">{i.id}</td>
                  <td>
                    <Link href={href(i.id)}><b>{i.title}</b></Link>
                    <div className="muted" style={{ fontSize: 11.5 }}>{i.reporter} · {i.page}</div>
                  </td>
                  <td><span className={`kind k-${i.kind}`}>{i.kind}</span></td>
                  <td className="mono">{i.priority}</td>
                  <td><span className={`flag ${i.status === 'done' ? 'f-ok' : 'f-mute'}`}>{i.status}</span></td>
                  <td className="mono">{i.fixedIn ?? <span className="muted">—</span>}</td>
                  <td className="muted nowrap" title={i.created}>{i.created ? ago(i.created) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div></div>
  );
}

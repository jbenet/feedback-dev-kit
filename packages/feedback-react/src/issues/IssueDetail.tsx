'use client';

import { themeStyle, useFeedbackConfig } from '../config';
import { Markdown } from '../Markdown';
import { shortDate } from '../time';
import { PRIORITY, STATUSES, type Issue, type IssuePriority } from './types';
import type { LinkLike } from './IssueList';

const PlainLink: LinkLike = ({ href, className, children }) => <a href={href} className={className}>{children}</a>;

/**
 * One issue: what happened (rendered with the same markdown the box previews with), the
 * screenshots filed with it, its status, and the context captured when it was filed.
 *
 * `onStatusChange`, when given, turns the status into a control; without it the status is shown
 * and changed wherever the issues live (a file, a GitHub issue).
 */
export function IssueDetail({
  issue, backHref = '/issues', Link = PlainLink, onStatusChange,
}: {
  issue: Issue;
  backHref?: string | null;
  Link?: LinkLike;
  onStatusChange?: (status: string) => void;
}) {
  const config = useFeedbackConfig();
  const url = config.endpoints.attachment;
  const p = PRIORITY[issue.priority as IssuePriority];
  return (
    <div className="fbk" style={themeStyle(config.theme)}><div className="issuedetail">
      <div className="issuemain">
        {backHref && <div className="lbl"><Link href={backHref}>← All issues</Link></div>}
        <h1 style={{ marginTop: 8 }}>{issue.title}</h1>
        <p className="sublede">
          <span className="mono muted">{issue.id}</span>{' '}
          <span className={`kind k-${issue.kind}`}>{issue.kind}</span>{' '}
          <span className="flag f-mute">{issue.priority}</span>{' '}
          <span className={`flag ${issue.status === 'done' ? 'f-ok' : 'f-mute'}`} data-status={issue.status}>{issue.status}</span>
        </p>

        <div className="card">
          <div className="chead"><h2>What happened</h2></div>
          <div className="cbody">
            <Markdown
              source={issue.body}
              resolveImage={(href) => (href.startsWith('/') ? href : url(href))}
            />
          </div>
        </div>

        {issue.screenshots.length > 0 && (
          <div className="card">
            <div className="chead">
              <h2>The page as it looked</h2>
              <span className="lbl">{issue.screenshots.length} screenshot{issue.screenshots.length === 1 ? '' : 's'}</span>
            </div>
            <div className="cbody">
              {issue.screenshots.map((shot, i) => (
                <a key={shot} href={url(shot)} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="issueshot" src={url(shot)} alt={`Screenshot ${i + 1} filed with issue ${issue.id}`} loading="lazy" />
                </a>
              ))}
            </div>
            <p className="cover">
              <b>Captured in the reporter&rsquo;s browser when they opened the box</b>, before the box
              covered anything, and annotated by them.
            </p>
          </div>
        )}

        {issue.context && Object.keys(issue.context).length > 0 && (
          <div className="card">
            <div className="chead">
              <h2>Context at the moment it was filed</h2>
              <span className="lbl">captured, not reconstructed</span>
            </div>
            <div className="cbody"><pre className="block">{JSON.stringify(issue.context, null, 2)}</pre></div>
          </div>
        )}
      </div>

      <aside className="issueside" aria-label={`Issue ${issue.id}`}>
        <div className="lbl">Issue {issue.id}</div>
        <div className="ihead">{issue.title}</div>
        <div className="imeta">{issue.reporter} · {issue.created ? shortDate(issue.created, true) : 'undated'}</div>
        <div className="kv">
          <span>Status</span>
          {onStatusChange ? (
            <select aria-label="Status" value={issue.status} onChange={(e) => onStatusChange(e.target.value)}>
              {[...new Set([...STATUSES, issue.status])].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : <span>{issue.status}</span>}
        </div>
        <div className="kv"><span>Kind</span><span>{issue.kind}</span></div>
        <div className="kv"><span>Priority</span><span>{issue.priority}</span></div>
        <div className="kv"><span>Page</span><span className="mono" style={{ fontSize: 11 }}>{issue.page || '—'}</span></div>
        {issue.closedAt && <div className="kv"><span>Closed</span><span>{shortDate(issue.closedAt, true)}</span></div>}
        {issue.fixedIn && <div className="kv"><span>Fixed in</span><span className="mono">{issue.fixedIn}</span></div>}
        {issue.location && (
          <div className="kv">
            <span>Lives at</span>
            <span className="mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
              {/^https?:/.test(issue.location) ? <a href={issue.location}>{issue.location}</a> : issue.location}
            </span>
          </div>
        )}
        {p && (
          <div className="scope">
            <div className="lbl">Priority · {issue.priority}</div>
            <p><b>{p.means}.</b> {p.detail} No date is promised against it — how fast the queue moves is a fact about the queue.</p>
          </div>
        )}
      </aside>
    </div></div>
  );
}

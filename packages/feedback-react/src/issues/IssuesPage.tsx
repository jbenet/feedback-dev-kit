'use client';

import { useState, type ReactNode } from 'react';
import { themeStyle, useFeedbackConfig } from '../config';
import { IssueDetail } from './IssueDetail';
import { IssueList, type LinkLike } from './IssueList';
import { IssueVelocity } from './IssueVelocity';
import { patchIssue, useIssue, useIssues } from './useIssues';
import { PRIORITIES, PRIORITY, type Issue } from './types';

function Notice({ tone, children }: { tone: 'loading' | 'error'; children: ReactNode }) {
  const { theme } = useFeedbackConfig();
  return (
    <div className="fbk" style={themeStyle(theme)}><div className="card">
      <div className="cbody">
        <div className="empty" role={tone === 'error' ? 'alert' : 'status'}>
          <span className={`stat ${tone === 'error' ? 'evidence' : 'working'}`}><i />{tone === 'error' ? 'Could not load' : 'Loading'}</span>
          <p style={{ marginTop: 8 }}>{children}</p>
        </div>
      </div>
    </div></div>
  );
}

/**
 * The issues page: a count per priority and the searchable list. Give it `issues` (fetched on the
 * server, say), or leave them out and it reads the server's list endpoint.
 */
export function IssuesPage({ issues: given, Link, heading = 'Issues', velocity = true }: { issues?: Issue[]; Link?: LinkLike; heading?: string | null; velocity?: boolean }) {
  const loaded = useIssues(!given);
  const config = useFeedbackConfig();
  const issues = given ?? loaded.issues;
  const open = (issues ?? []).filter((i) => i.status !== 'done');
  return (
    <div className="fbk" style={themeStyle(config.theme)}><div className="issuespage">
      {heading && <><div className="lbl">Feedback loop</div><h1>{heading}</h1></>}
      <div className="kpis">
        {PRIORITIES.map((p) => (
          <div className="kpi" key={p}>
            <span className={`tag ${p === 'P0' || p === 'P1' ? 't-clay' : 't-plain'}`}>{p}</span>
            <div className="n">{issues ? open.filter((i) => i.priority === p).length : '–'}</div>
            <div className="f">{PRIORITY[p].means}. {PRIORITY[p].detail}</div>
          </div>
        ))}
      </div>
      {issues && velocity && <IssueVelocity issues={issues} />}
      {issues
        ? <IssueList issues={issues} Link={Link} />
        : loaded.error
          ? <Notice tone="error">{loaded.error}. <button type="button" className="linkish" onClick={loaded.reload}>Try again</button></Notice>
          : <Notice tone="loading">Reading the issues…</Notice>}
    </div></div>
  );
}

/**
 * One issue's page, from `issue` or from the server's detail endpoint. `editable` turns the status
 * into a control that PATCHes the server (put that endpoint behind your auth).
 */
export function IssuePage({ id, issue: given, Link, editable = false }: { id: string; issue?: Issue; Link?: LinkLike; editable?: boolean }) {
  const config = useFeedbackConfig();
  const loaded = useIssue(id, !given);
  const [changed, setChanged] = useState<Issue | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const issue = changed ?? given ?? loaded.issue;
  const onStatusChange = editable
    ? (status: string) => {
      setFailed(null);
      patchIssue(config.endpoints.issue(id), { status })
        .then(setChanged)
        .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)));
    }
    : undefined;
  if (issue) {
    return (
      <>
        {failed && <Notice tone="error">The status did not change: {failed}.</Notice>}
        <IssueDetail issue={issue} Link={Link} onStatusChange={onStatusChange} />
      </>
    );
  }
  if (loaded.error) return <Notice tone="error">Issue {id}: {loaded.error}.</Notice>;
  return <Notice tone="loading">Reading issue {id}…</Notice>;
}

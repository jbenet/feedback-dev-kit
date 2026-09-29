'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFeedbackConfig } from '../config';
import type { Issue } from './types';

type Load<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

function useJson<T>(url: string | null, pick: (json: unknown) => T | null): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(url, { cache: 'no-store', credentials: 'include', signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json().catch(() => null) as { error?: string } | null;
        if (!res.ok) throw new Error(json?.error ?? `The server answered ${res.status}`);
        const got = pick(json);
        if (got === null) throw new Error('The server answered with something that is not an issue');
        setData(got);
        setError(null);
      })
      .catch((err: unknown) => { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
    // `pick` is a pure reader; its identity is not a reason to fetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

const isIssue = (v: unknown): v is Issue => Boolean(v) && typeof v === 'object' && typeof (v as Issue).id === 'string';

/** The issues list from the server's read API: `{ issues: Issue[] }` (or `{ items }`, or a bare array). */
export function useIssues(enabled = true) {
  const { endpoints } = useFeedbackConfig();
  const r = useJson<Issue[]>(enabled ? endpoints.issues : null, (json) => {
    const o = json as { items?: unknown; issues?: unknown } | null;
    const list = Array.isArray(json) ? json : o?.issues ?? o?.items;
    return Array.isArray(list) ? list.filter(isIssue) : null;
  });
  return { issues: r.data, error: r.error, loading: r.loading, reload: r.reload };
}

/** One issue from the server's read API: `{ issue: Issue }` or the issue itself. */
export function useIssue(id: string, enabled = true) {
  const { endpoints } = useFeedbackConfig();
  const r = useJson<Issue>(enabled ? endpoints.issue(id) : null, (json) => {
    const one = (json as { issue?: unknown })?.issue ?? json;
    return isIssue(one) ? one : null;
  });
  return { issue: r.data, error: r.error, loading: r.loading, reload: r.reload };
}

/** Change an issue's status, priority or labels (PATCH). Resolves to the updated issue. */
export async function patchIssue(url: string, patch: { status?: string; priority?: string; labels?: string[] }): Promise<Issue> {
  const res = await fetch(url, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch), credentials: 'include',
  });
  const json = await res.json().catch(() => null) as { issue?: Issue; error?: string } | null;
  if (!res.ok || !json?.issue) throw new Error(json?.error ?? `The server answered ${res.status}`);
  return json.issue;
}

'use client';

import Link from 'next/link';
import { IssuesPage, type Issue } from '@jbenet/feedback-react';

/** The kit's page with Next's Link for rows (a function cannot cross from a server component). */
export function IssuesWithLinks({ issues }: { issues: Issue[] }) {
  return <IssuesPage issues={issues} Link={Link} />;
}

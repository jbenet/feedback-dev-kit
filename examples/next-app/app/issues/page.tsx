import type { Issue } from '@jbenet/feedback-react';
import { IssuesWithLinks } from '@/components/IssuesWithLinks';
import { feedback } from '@/lib/feedback';

export const dynamic = 'force-dynamic';

/**
 * The issues list, read on the server from the store and handed to the kit's page as data. (The
 * detail page does the other thing: the component fetches from the read API itself.)
 */
export default async function Issues() {
  const issues = await feedback().store.list() as Issue[];
  return <IssuesWithLinks issues={issues} />;
}

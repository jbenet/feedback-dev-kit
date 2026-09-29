import { cookies } from 'next/headers';
import type { Issue } from '@jbenet/feedback-react';
import { IssuesWithLinks } from '@/components/IssuesWithLinks';
import { feedback } from '@/lib/feedback';
import { DEMO_USER_COOKIE, demoUser } from '@/lib/users';

export const dynamic = 'force-dynamic';

/**
 * The issues list, read on the server from the store and handed to the kit's page as data. (The
 * detail page does the other thing: the component fetches from the read API itself.) Like the
 * API, it is for signed-in people only.
 */
export default async function Issues() {
  if (!demoUser((await cookies()).get(DEMO_USER_COOKIE)?.value)) {
    return (
      <>
        <div className="kicker">Feedback loop</div>
        <h1>Issues</h1>
        <p className="lede" role="status">Sign in to see issues: pick a person under <b>Sign in as</b> in the rail.</p>
      </>
    );
  }
  const issues = await feedback().store.list() as Issue[];
  return <IssuesWithLinks issues={issues} />;
}

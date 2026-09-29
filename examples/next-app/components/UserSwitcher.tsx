'use client';

import { useRouter } from 'next/navigation';
import { DEMO_USER_COOKIE, DEMO_USERS } from '@/lib/users';

/**
 * The demo's "sign in as". Not authentication: it sets a cookie the server reads to name the
 * reporter and to let you see issues. The report body never names anyone.
 */
export function UserSwitcher({ current }: { current: string | null }) {
  const router = useRouter();
  const set = (handle: string | null) => {
    document.cookie = handle
      ? `${DEMO_USER_COOKIE}=${encodeURIComponent(handle)}; path=/; samesite=lax`
      : `${DEMO_USER_COOKIE}=; path=/; max-age=0; samesite=lax`;
    router.refresh();
  };
  return (
    <div className="who">
      <label className="lbl" htmlFor="demo-user">{current ? 'Signed in as' : 'Sign in as'}</label>
      <div className="whorow">
        <select id="demo-user" value={current ?? ''} onChange={(e) => set(e.target.value || null)}>
          {!current && <option value="">Nobody (signed out)</option>}
          {DEMO_USERS.map((u) => <option key={u.handle} value={u.handle}>{u.name}</option>)}
        </select>
        {current && <button type="button" className="signout" onClick={() => set(null)}>Sign out</button>}
      </div>
    </div>
  );
}

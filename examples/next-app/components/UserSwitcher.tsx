'use client';

import { useRouter } from 'next/navigation';
import { DEMO_USER_COOKIE, DEMO_USERS } from '@/lib/users';

/** The demo has no auth: pick who you are. The server reads this cookie; the report body never names anyone. */
export function UserSwitcher({ current }: { current: string }) {
  const router = useRouter();
  return (
    <label className="who">
      <span className="lbl">You are</span>
      <select
        value={current}
        onChange={(e) => {
          document.cookie = `${DEMO_USER_COOKIE}=${encodeURIComponent(e.target.value)}; path=/; samesite=lax`;
          router.refresh();
        }}
      >
        {DEMO_USERS.map((u) => <option key={u.handle} value={u.handle}>{u.name}</option>)}
      </select>
    </label>
  );
}

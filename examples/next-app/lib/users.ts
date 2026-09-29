/**
 * The example's stand-in for auth: invented people, and a cookie that says which of them you
 * signed in as. It is NOT authentication — anyone can set the cookie. A real app resolves the
 * reporter and authorizes the issue reads from its own session (see lib/feedback.ts).
 */
export const DEMO_USER_COOKIE = 'demo_user';

export const DEMO_USERS = [
  { handle: 'robin', name: 'Robin Vega' },
  { handle: 'sam', name: 'Sam Okafor' },
] as const;

export type DemoUser = (typeof DEMO_USERS)[number];

/** The demo user a handle names, or null: nobody is signed in unless the cookie names one of them. */
export const demoUser = (handle: string | null | undefined): DemoUser | null =>
  DEMO_USERS.find((u) => u.handle === handle) ?? null;

/** The signed-in demo user, from a request's Cookie header. */
export function userFromCookieHeader(cookie: string | null): DemoUser | null {
  const value = new RegExp(`(?:^|;\\s*)${DEMO_USER_COOKIE}=([^;]+)`).exec(cookie ?? '')?.[1];
  if (!value) return null;
  try { return demoUser(decodeURIComponent(value)); } catch { return null; }
}

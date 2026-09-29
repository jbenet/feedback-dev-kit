/** Invented people for the demo's user switcher. There is no auth in the example. */
export const DEMO_USER_COOKIE = 'demo_user';

export const DEMO_USERS = [
  { handle: 'robin', name: 'Robin Vega' },
  { handle: 'sam', name: 'Sam Okafor' },
] as const;

export const demoUser = (handle: string | null | undefined) =>
  DEMO_USERS.find((u) => u.handle === handle) ?? DEMO_USERS[0];

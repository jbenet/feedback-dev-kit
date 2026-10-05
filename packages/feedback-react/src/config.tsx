'use client';

import { cleanUrl, SECRET_KEY } from './safe-urls';
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';

/** The keys that open the feedback box. `code` is the physical key (KeyboardEvent.code). */
export interface FeedbackShortcut {
  code: string;
  alt?: boolean;
  shift?: boolean;
  /** ⌘ on Apple devices, Ctrl elsewhere. */
  mod?: boolean;
}

/** Where the client talks to the server. Every URL is relative to `base` unless absolute. */
export interface FeedbackEndpoints {
  /** POST a report; GET `?clientId=` for where a journaled one stands. */
  submit: string;
  /** GET the issues list: `{ issues: Issue[] }` (`{ items }` is read too). */
  issues: string;
  /** GET one issue: `{ issue: Issue }`; PATCH it with `{ status?, priority?, labels? }`. */
  issue: (id: string) => string;
  /**
   * An attachment filed with an issue, by its path relative to the issues store
   * (`attachments/0007-screenshot.png`). Absolute URLs (a GitHub store's) pass through untouched.
   */
  attachment: (path: string) => string;
}

export interface FeedbackConfig {
  /** Prefix for every endpoint, e.g. `https://feedback.example.com`. Default: same origin. */
  base?: string;
  endpoints?: Partial<FeedbackEndpoints>;
  /**
   * Who is filing, shown in the box ("Filing as …"). Display only: the server resolves the
   * reporter from the session and never trusts a name in the request body.
   */
  userLabel?: string;
  /** Default Alt+F (Option+F on a Mac). */
  shortcut?: FeedbackShortcut;
  /** Prefix for localStorage keys and IndexedDB names, so two apps on one origin keep apart. */
  storagePrefix?: string;
  /** Where a filed issue number links to. Default `/issues/<id>`. */
  issueHref?: (id: string) => string;
  /** CSS variable overrides, e.g. `{ '--fbk-accent': '#1E8F5E' }`. Applied to every root the kit draws. */
  theme?: Record<string, string>;
  /** One sentence under the screenshots saying where they go. */
  destinationNote?: string;
  /**
   * Origins whose images an issue may show besides this app's own attachments, e.g.
   * `https://feedback-cdn.example.com` for a store that keeps pictures there. Issues are written by
   * reporters, so any other absolute image URL is not loaded (it would tell its owner who read the
   * issue, and when). Default: none.
   */
  trustedImageOrigins?: string[];
  /**
   * The page the reporter is on. Pass your router's pathname and search so a client-side
   * navigation with the box open is seen; without it the kit reads `window.location` each render.
   */
  pathname?: string;
  search?: string;
}

export interface ResolvedFeedbackConfig {
  endpoints: FeedbackEndpoints;
  userLabel: string | null;
  shortcut: FeedbackShortcut;
  storagePrefix: string;
  issueHref: (id: string) => string;
  theme: Record<string, string>;
  destinationNote: string;
  trustedImageOrigins: string[];
  pathname: string | null;
  search: string | null;
}

export const DEFAULT_SHORTCUT: FeedbackShortcut = { code: 'KeyF', alt: true };

const join = (base: string, path: string) => (/^https?:\/\//.test(path) ? path : `${base.replace(/\/$/, '')}${path}`);

export function resolveConfig(c: FeedbackConfig = {}): ResolvedFeedbackConfig {
  const base = c.base ?? '';
  const e = c.endpoints ?? {};
  return {
    endpoints: {
      submit: join(base, e.submit ?? '/api/feedback'),
      issues: join(base, e.issues ?? '/api/issues'),
      issue: (id) => join(base, e.issue ? e.issue(id) : `/api/issues/${encodeURIComponent(id)}`),
      attachment: (path) => (/^(https?:|data:|blob:)/.test(path) ? path : join(base, e.attachment
        ? e.attachment(path)
        : `/api/issues/${(path.startsWith('attachments/') ? path : `attachments/${path}`).split('/').map(encodeURIComponent).join('/')}`)),
    },
    userLabel: c.userLabel ?? null,
    shortcut: c.shortcut ?? DEFAULT_SHORTCUT,
    storagePrefix: c.storagePrefix ?? 'feedbackkit',
    issueHref: c.issueHref ?? ((id) => `/issues/${encodeURIComponent(id)}`),
    theme: c.theme ?? {},
    destinationNote: c.destinationNote ?? 'Filed with the issue on the server.',
    trustedImageOrigins: c.trustedImageOrigins ?? [],
    pathname: c.pathname ?? null,
    search: c.search ?? null,
  };
}

const Ctx = createContext<ResolvedFeedbackConfig>(resolveConfig());

/**
 * Configuration for every feedback component below it. Optional: without it the components use
 * the defaults (same-origin `/api/feedback`, Alt+F, the PL LabOS tools look).
 */
export function FeedbackProvider({ children, ...config }: FeedbackConfig & { children: ReactNode }) {
  const {
    base, endpoints, userLabel, shortcut, storagePrefix, issueHref, theme, destinationNote, pathname, search,
  } = config;
  const value = useMemo(
    () => resolveConfig({ base, endpoints, userLabel, shortcut, storagePrefix, issueHref, theme, destinationNote, pathname, search }),
    // Endpoint and href functions are usually inline; their identity is not a reason to rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, userLabel, storagePrefix, destinationNote, pathname, search,
      JSON.stringify(shortcut), JSON.stringify(theme), JSON.stringify(endpoints && Object.keys(endpoints))],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useFeedbackConfig = () => useContext(Ctx);

/** The theme overrides as a style object, for a root the kit draws (portalled roots included). */
export const themeStyle = (theme: Record<string, string>): CSSProperties | undefined =>
  (Object.keys(theme).length ? (theme as CSSProperties) : undefined);

/** The page the reporter is on: the router's, when given, else the address bar's. */
export function currentLocation(c: ResolvedFeedbackConfig): { path: string; filters: Record<string, string>; url?: string } {
  const hasWindow = typeof window !== 'undefined';
  const path = c.pathname ?? (hasWindow ? window.location.pathname : '/');
  const search = c.search ?? (hasWindow ? window.location.search : '');
  return {
    path,
    filters: Object.fromEntries([...new URLSearchParams(search).entries()].map(([k, v]) => [k, SECRET_KEY.test(k) ? '[removed]' : v])),
    url: hasWindow ? cleanUrl(window.location.href) : undefined,
  };
}

/** The original clay-and-paper palette, as a re-skin example: pass as `theme`. */
export const CLAY_THEME: Record<string, string> = {
  '--fbk-ground': '#F5F3EE', '--fbk-ink': '#1A1917', '--fbk-muted': '#5E5A52', '--fbk-line': '#E4E0D6',
  '--fbk-rail': '#1A1917', '--fbk-rail-ink': '#EFEBE2', '--fbk-rail-muted': '#9C968A', '--fbk-rail-line': '#332F2A',
  '--fbk-rail-hover': '#2C2823', '--fbk-rail-raise': '#211E1A', '--fbk-rail-edge': '#443E36',
  '--fbk-rail-soft': '#252119', '--fbk-rail-text': '#C6C0B4', '--fbk-hair': '#F0EDE5', '--fbk-label': '#46423B',
  '--fbk-accent': '#BF4A16', '--fbk-accent-soft': '#FCF6F2', '--fbk-accent-line': '#E4D3C6',
  '--fbk-accent-wash': '#FBF9F4', '--fbk-accent-halo': '#F6E4DA',
};

/** The default PLC green values, spelled out (the default theme already uses them). */
export const GREEN_THEME: Record<string, string> = {
  '--fbk-ground': '#F1F4F0', '--fbk-ink': '#16201B', '--fbk-muted': '#54605A', '--fbk-line': '#DAE3DC',
  '--fbk-rail': '#11251D', '--fbk-rail-ink': '#E6F0E9', '--fbk-rail-muted': '#8FA298', '--fbk-rail-line': '#1F3B30',
  '--fbk-rail-hover': '#1B3427', '--fbk-rail-raise': '#162C22', '--fbk-rail-edge': '#2E5040',
  '--fbk-rail-soft': '#17301F', '--fbk-rail-text': '#BCCDC2', '--fbk-hair': '#EAF0EA', '--fbk-label': '#3A4740',
  '--fbk-accent': '#1E8F5E', '--fbk-accent-soft': '#EFF8F3', '--fbk-accent-line': '#BFE0CE',
  '--fbk-accent-wash': '#F4F9F5', '--fbk-accent-halo': '#D8EEE2',
};

export { safeAttachmentUrl, safeLinkHref } from './safe-urls';

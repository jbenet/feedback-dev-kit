import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
// Fonts self-hosted, same origin: the automatic screenshot embeds only fonts it can read, and a
// cross-origin stylesheet (Google Fonts) leaves the picture in fallback fonts, re-wrapped.
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@jbenet/feedback-react/styles.css';
import './app.css';
import { FeedbackButton, FeedbackStatus, KeyboardShortcuts, VIEWPORT_BOOT } from '@jbenet/feedback-react';
import { Providers } from '@/components/Providers';
import { Nav } from '@/components/Nav';
import { UserSwitcher } from '@/components/UserSwitcher';
import { DEMO_USER_COOKIE, demoUser } from '@/lib/users';

export const metadata: Metadata = { title: 'feedback-kit example', description: 'The feedback box from Capital OS, in a small Next.js app.' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = demoUser((await cookies()).get(DEMO_USER_COOKIE)?.value);
  return (
    <html lang="en">
      <head>
        {/* The window's real height, before first paint (iPad Safari's 100dvh is taller than the page). */}
        <script dangerouslySetInnerHTML={{ __html: VIEWPORT_BOOT }} />
      </head>
      <body>
        <Providers userLabel={user.name}>
          <div className="app">
            <nav className="rail" aria-label="Main">
              <div className="brand"><span className="mark">O</span><b>Orchard Street</b></div>
              <Nav />
              <div className="railfoot">
                <FeedbackStatus />
                <FeedbackButton variant="rail" />
                <UserSwitcher current={user.handle} />
              </div>
            </nav>
            <main className="main">{children}</main>
          </div>
          <KeyboardShortcuts />
        </Providers>
      </body>
    </html>
  );
}

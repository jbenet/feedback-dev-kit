'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { FeedbackProvider } from '@jbenet/feedback-react';

/**
 * The kit's configuration for the whole app. The pathname comes from the router so a client-side
 * navigation with the box open is seen; the query string is read from the address bar.
 */
export function Providers({ userLabel, children }: { userLabel: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <FeedbackProvider
      pathname={pathname}
      userLabel={userLabel}
      storagePrefix="fbk-example"
      destinationNote="Filed with the issue as a PNG, in the example's .data/issues folder."
    >
      {children}
    </FeedbackProvider>
  );
}

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { FeedbackButton, FeedbackProvider, FeedbackStatus, IssuePage, IssuesPage, KeyboardShortcuts } from '@jbenet/feedback-react';

/**
 * A plain React app with no router library: the path lives in state and links push history. Any
 * router works the same way: give FeedbackProvider the current pathname, and the issues pages your
 * router's Link (or nothing, for plain <a> links).
 */
export function App() {
  const pathname = usePathname();
  const issue = /^\/issues\/([^/]+)$/.exec(pathname)?.[1];
  return (
    <FeedbackProvider pathname={pathname} storagePrefix="fbk-vite-example" destinationNote="Filed with the issue as a PNG, in the example's .data/issues folder.">
      <div className="shell">
        <nav>
          <strong>Vite example</strong>
          <Link href="/">Home</Link>
          <Link href="/issues">Issues</Link>
          <span className="spacer" />
          <FeedbackStatus />
          <FeedbackButton variant="rail" />
        </nav>
        <main>
          {issue ? <IssuePage id={decodeURIComponent(issue)} Link={Link} editable />
            : pathname === '/issues' ? <IssuesPage Link={Link} />
            : <Home />}
        </main>
      </div>
      <KeyboardShortcuts />
    </FeedbackProvider>
  );
}

function Home() {
  return (
    <article>
      <h1>No Next.js here</h1>
      <p>
        This page is React 19 built by Vite, served by <code>node:http</code>. The feedback box, its
        screenshots and the issues pages are the same as in the Next.js example.
      </p>
      <p>Press <kbd>Alt+F</kbd> (<kbd>Option+F</kbd> on a Mac) or the button in the bar, describe something, and file it.</p>
    </article>
  );
}

function usePathname() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener('app:navigate', update);
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('app:navigate', update); };
  }, []);
  return path;
}

function Link({ href, className, children }: { href: string; className?: string; children?: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (new URL(href, window.location.href).origin !== window.location.origin) return;
    e.preventDefault();
    window.history.pushState(null, '', href);
    window.dispatchEvent(new Event('app:navigate'));
    window.scrollTo(0, 0);
  };
  return <a href={href} className={className} onClick={onClick}>{children}</a>;
}

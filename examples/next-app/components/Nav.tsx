'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Orders' },
  { href: '/reports', label: 'Reports' },
  { href: '/settings', label: 'Settings' },
  { href: '/issues', label: 'Issues' },
];

export function Nav() {
  const path = usePathname();
  return (
    <ul className="nav">
      {LINKS.map((l) => {
        const on = l.href === '/' ? path === '/' : path.startsWith(l.href);
        return <li key={l.href}><Link href={l.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>{l.label}</Link></li>;
      })}
    </ul>
  );
}

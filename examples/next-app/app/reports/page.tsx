import Link from 'next/link';

/** Reports — a long page with filters in the address bar, so the report captures them and a scrolled capture is exercised. */
const REGIONS = ['north', 'harbor', 'hills'] as const;
const PRODUCTS = ['Sourdough', 'Rye', 'Baguette', 'Croissant', 'Seeded loaf', 'Rolls', 'Focaccia', 'Brioche'];

export default async function Reports({ searchParams }: { searchParams: Promise<{ region?: string }> }) {
  const { region = 'north' } = await searchParams;
  const seed = REGIONS.indexOf(region as (typeof REGIONS)[number]) + 2;
  const rows = Array.from({ length: 48 }, (_, i) => ({
    week: `W${String(i + 1).padStart(2, '0')}`,
    product: PRODUCTS[(i * seed) % PRODUCTS.length]!,
    units: 120 + ((i * 37 * seed) % 400),
    returns: (i * seed) % 7,
  }));
  return (
    <>
      <div className="kicker">Weekly · invented data</div>
      <h1>Reports</h1>
      <p className="lede">Units sold per week. The region filter lives in the address bar; a report filed here records it.</p>
      <div className="chips">
        {REGIONS.map((r) => <Link key={r} href={`/reports?region=${r}`} className={r === region ? 'on' : ''}>{r}</Link>)}
      </div>
      <section className="panel">
        <h2>By week · {region}</h2>
        <table className="grid">
          <thead><tr><th>Week</th><th>Product</th><th>Units</th><th>Returns</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.week}><td>{r.week}</td><td>{r.product}</td><td>{r.units}</td><td>{r.returns}</td></tr>)}</tbody>
        </table>
      </section>
    </>
  );
}

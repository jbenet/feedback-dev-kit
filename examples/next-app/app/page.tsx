/** Orders — a demo page with invented data, something to file feedback about. */
const ORDERS = [
  { id: 'A-1041', customer: 'Juniper Café', items: 'Sourdough ×12, rye ×6', due: '07:30', state: 'Baking' },
  { id: 'A-1042', customer: 'Harbor Deli', items: 'Baguette ×40', due: '08:00', state: 'Proofing' },
  { id: 'A-1043', customer: 'Maple Row School', items: 'Rolls ×180', due: '10:15', state: 'Queued' },
  { id: 'A-1044', customer: 'Tern & Finch', items: 'Croissant ×60, pain au chocolat ×30', due: '06:45', state: 'Out for delivery' },
  { id: 'A-1045', customer: 'Lindqvist Market', items: 'Seeded loaf ×24', due: '09:00', state: 'Queued' },
];

export default function Orders() {
  return (
    <>
      <div className="kicker">Today · invented data</div>
      <h1>Orders</h1>
      <p className="lede">
        A demo page. Press <b>Feedback</b> in the rail, or <kbd>Alt</kbd>+<kbd>F</kbd> (Option+F on a Mac),
        to report something about it. The box takes a screenshot of this page on its own.
      </p>
      <div className="tiles">
        <div className="tile"><span className="kicker">Orders</span><div className="n">27</div><div className="f">5 due before 09:00</div></div>
        <div className="tile"><span className="kicker">Loaves</span><div className="n">1,284</div><div className="f">Across three ovens</div></div>
        <div className="tile"><span className="kicker">Late</span><div className="n">1</div><div className="f">Harbor Deli, 12 min</div></div>
      </div>
      <section className="panel">
        <h2>Due this morning</h2>
        <table className="grid">
          <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Due</th><th>State</th></tr></thead>
          <tbody>
            {ORDERS.map((o) => (
              <tr key={o.id}><td>{o.id}</td><td>{o.customer}</td><td>{o.items}</td><td>{o.due}</td><td><span className="pill">{o.state}</span></td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

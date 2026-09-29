/** Settings — a form, for feedback about controls. Nothing here saves. */
export default function Settings() {
  return (
    <>
      <div className="kicker">Bakery</div>
      <h1>Settings</h1>
      <p className="lede">A form that does nothing, to have form controls on screen.</p>
      <form className="form">
        <label>Bakery name<input type="text" defaultValue="Orchard Street" /></label>
        <label>First bake<select defaultValue="04:30"><option>04:00</option><option>04:30</option><option>05:00</option></select></label>
        <label>Delivery radius (km)<input type="number" defaultValue={12} /></label>
      </form>
    </>
  );
}

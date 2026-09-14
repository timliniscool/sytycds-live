export default function AdminSurface() {
  return (
    <main className="surface surface--admin" aria-labelledby="admin-title">
      <header>
        <p>SYTYCDS / show control</p>
        <h1 id="admin-title">Operator console</h1>
      </header>
      <section aria-label="Console status">
        <p>Control surface is loading its live show connection.</p>
      </section>
    </main>
  );
}

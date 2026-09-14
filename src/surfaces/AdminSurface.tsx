import { useEffect, useState, type FormEvent } from "react";

type AuthenticationState = "checking" | "signed-out" | "signed-in" | "failed";

export default function AdminSurface() {
  const [authentication, setAuthentication] =
    useState<AuthenticationState>("checking");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    void fetch("/api/admin/session", { credentials: "same-origin" })
      .then(async (response) =>
        response.ok
          ? (response.json() as Promise<{ authenticated: boolean }>)
          : null,
      )
      .then((result) =>
        setAuthentication(result?.authenticated ? "signed-in" : "signed-out"),
      )
      .catch(() => setAuthentication("failed"));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    setSecret("");
    setAuthentication(response.ok ? "signed-in" : "signed-out");
  }

  if (authentication !== "signed-in") {
    return (
      <main
        className="surface surface--admin"
        aria-labelledby="admin-login-title"
      >
        <header>
          <p>SYTYCDS / show control</p>
          <h1 id="admin-login-title">Operator sign-in</h1>
        </header>
        {authentication === "checking" ? (
          <p>Checking operator session…</p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="admin-secret">Show-control secret</label>
            <input
              id="admin-secret"
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
            />
            <button type="submit">Sign in</button>
            {authentication === "failed" && (
              <p>Unable to verify this session.</p>
            )}
          </form>
        )}
      </main>
    );
  }

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

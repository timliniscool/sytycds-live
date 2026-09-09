import { DurableObject } from "cloudflare:workers";

export class ShowCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO runtime_metadata (key, value) VALUES (?, ?)",
      "schema_version",
      "0",
    );
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);

    if (request.method !== "GET" || url.pathname !== "/health") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM runtime_metadata WHERE key = ?",
        "schema_version",
      )
      .one();

    return Response.json({
      ok: true,
      storage: "SQLite",
      schemaVersion: Number(row.value),
    });
  }
}

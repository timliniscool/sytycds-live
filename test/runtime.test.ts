import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("runtime baseline", () => {
  it("binds one SQLite-backed show coordinator", async () => {
    const id = env.SHOW_COORDINATOR.idFromName("primary");
    const stub = env.SHOW_COORDINATOR.get(id);
    const response = await stub.fetch("https://show.internal/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      storage: "SQLite",
      schemaVersion: 0,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });
  });
});

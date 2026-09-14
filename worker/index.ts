export { ShowCoordinator } from "./show-coordinator";

interface CoordinatorHealth {
  ok: true;
  storage: string;
  schemaVersion: number;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      const id = env.SHOW_COORDINATOR.idFromName("primary");
      const response = await env.SHOW_COORDINATOR.get(id).fetch(
        "https://show.internal/health",
      );

      if (!response.ok) {
        return Response.json(
          { ok: false, error: "Coordinator unavailable" },
          { status: 503 },
        );
      }

      const coordinator = (await response.json()) as CoordinatorHealth;
      return Response.json({ ok: true, coordinator });
    }

    if (
      url.pathname === "/api/ws" ||
      url.pathname.startsWith("/api/admin/") ||
      url.pathname === "/api/vote" ||
      url.pathname === "/api/vote/status"
    ) {
      const id = env.SHOW_COORDINATOR.idFromName("primary");
      return env.SHOW_COORDINATOR.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

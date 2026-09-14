export { ShowCoordinator } from "./show-coordinator";

interface CoordinatorHealth {
  ok: true;
  storage: string;
  schemaVersion: number;
}

/**
 * API responses are never cacheable and never sniffable. WebSocket upgrades
 * (status 101) are returned untouched because their headers belong to the
 * handshake. Static assets get their headers from `public/_headers`.
 */
function withApiHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  // Media bytes are immutable per asset version and carry their own policy.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
        return withApiHeaders(
          Response.json(
            { ok: false, error: "Coordinator unavailable" },
            { status: 503 },
          ),
        );
      }

      const coordinator = (await response.json()) as CoordinatorHealth;
      return withApiHeaders(Response.json({ ok: true, coordinator }));
    }

    if (
      url.pathname === "/api/ws" ||
      url.pathname.startsWith("/api/admin/") ||
      url.pathname === "/api/vote" ||
      url.pathname === "/api/vote/status" ||
      url.pathname.startsWith("/api/media/")
    ) {
      const id = env.SHOW_COORDINATOR.idFromName("primary");
      return withApiHeaders(await env.SHOW_COORDINATOR.get(id).fetch(request));
    }

    return withApiHeaders(
      Response.json({ error: "Not found" }, { status: 404 }),
    );
  },
} satisfies ExportedHandler<Env>;

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";

describe("hibernatable coordinator sockets", () => {
  it("restores only compact role metadata after object eviction", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("socket-hibernation"),
    );
    const response = await stub.fetch(
      new Request("https://show.internal/api/ws", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    const client = response.webSocket;
    expect(client).not.toBeNull();
    client?.accept();
    // The hello is processed asynchronously; the coordinator answers it with
    // either a snapshot or a protocol error, and only then is the role fixed.
    const answered = new Promise<void>((resolve) => {
      client?.addEventListener("message", () => resolve(), { once: true });
    });
    client?.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      }),
    );
    await answered;

    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      expect(socket?.deserializeAttachment()).toMatchObject({
        phase: "ready",
        role: { kind: "audience" },
        protocolVersion: PROTOCOL_VERSION,
      });
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
      expect(state.getWebSockets()[0]?.deserializeAttachment()).toMatchObject({
        phase: "ready",
        role: { kind: "audience" },
      });
    });
    client?.close();
  });
});

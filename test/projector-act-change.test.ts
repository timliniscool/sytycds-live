import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import type { ServerMessage } from "../shared/protocol";
import { createAdminSession } from "../worker/admin-auth";
import {
  generateProjectorPairingCode,
  pairProjector,
} from "../worker/projector-pairing";
import { PRIMARY_SHOW_ID } from "../worker/show-state";

const now = "2026-09-16T00:00:00.000Z";

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (id, title, display_mode, audience_vote_state, result_reveal_state,
       active_act_id, revision, created_at, updated_at)
     VALUES (?, 'Show', 'LOBBY', 'CLOSED', 'HIDDEN', NULL, 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  ["act-1", "act-2"].forEach((id, order) => {
    sql.exec(
      `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name,
         act_type, public_description, internal_notes, created_at, updated_at)
       VALUES (?, ?, ?, 'P', 'Y', ?, 'Music', '', '', ?, ?)`,
      id,
      PRIMARY_SHOW_ID,
      order,
      id,
      now,
      now,
    );
    // Each act owns one cue, so a stale cue list is observable.
    sql.exec(
      `INSERT INTO cues (id, show_id, act_id, position, operator_label, internal_note,
         origin, operations_json, visual_kind, visual_source_key, visual_title,
         audio_kind, audio_source_key, duration_ms, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, '', 'MANUAL', ?, 'TITLE_CARD', NULL, ?, NULL, NULL, NULL, ?, ?)`,
      `cue-${id}`,
      PRIMARY_SHOW_ID,
      id,
      `Cue for ${id}`,
      JSON.stringify([
        {
          kind: "visual",
          visual: { kind: "TITLE_CARD", sourceKey: null, title: id },
        },
      ]),
      id,
      now,
      now,
    );
  });
}

class Socket {
  readonly received: ServerMessage[] = [];
  private waiters: {
    type: string;
    resolve: (message: ServerMessage) => void;
  }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.received.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.type !== message.type) return true;
        waiter.resolve(message);
        return false;
      });
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  next(type: ServerMessage["type"], timeoutMs = 3_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No ${type} within ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiters.push({
        type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
}

async function open(
  stub: DurableObjectStub,
  hello: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Socket> {
  const response = await stub.fetch(
    new Request("https://show.test/api/ws", {
      headers: { Upgrade: "websocket", ...headers },
    }),
  );
  if (!response.webSocket) throw new Error("upgrade failed");
  const socket = new Socket(response.webSocket);
  const snapshot = socket.next("snapshot");
  socket.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, ...hello });
  await snapshot;
  return socket;
}

describe("projector state across act changes", () => {
  it("receives the new act's cue stack the moment the act changes", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("projector-act-change"),
    );
    await stub.fetch("https://show.internal/health");
    let adminCookie = "";
    let projectorCookie = "";
    await runInDurableObject(stub, async (_instance, state) => {
      seed(state.storage.sql);
      const login = await createAdminSession(
        state.storage,
        new Request("https://show.test/api/admin/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://show.test",
          },
          body: JSON.stringify({ secret: "s" }),
        }),
        "s",
        PRIMARY_SHOW_ID,
      );
      adminCookie = login.setCookie?.split(";")[0] ?? "";
      const { code } = await generateProjectorPairingCode(
        state.storage,
        PRIMARY_SHOW_ID,
      );
      const paired = await pairProjector(
        state.storage,
        new Request("https://show.test/api/projector/pair", {
          method: "POST",
          headers: { Origin: "https://show.test" },
        }),
        PRIMARY_SHOW_ID,
        code,
      );
      if (!paired.ok) throw new Error(paired.error);
      projectorCookie = paired.setCookie.split(";")[0] ?? "";
    });

    const admin = await open(
      stub,
      { requestedRole: "admin" },
      { Cookie: adminCookie, Origin: "https://show.test" },
    );
    const projector = await open(
      stub,
      { requestedRole: "projector" },
      { Cookie: projectorCookie },
    );

    const select = (
      actId: string,
      commandId: string,
      expectedRevision: number,
    ) => {
      admin.send({
        type: "admin_command",
        protocolVersion: PROTOCOL_VERSION,
        command: {
          type: "SELECT_ACT",
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          expectedRevision,
          actId,
        },
      });
      return admin.next("command_ack");
    };

    // First act: the projector learns act-1 and its cue.
    const first = projector.next("snapshot");
    await select("act-1", "select-1", 0);
    const afterFirst = await first;
    expect(afterFirst).toMatchObject({
      projection: {
        role: "projector",
        show: { activeActId: "act-1" },
        activeCues: [{ id: "cue-act-1" }],
      },
    });

    // Second act: the very next message about the act carries act-2's cues, so
    // a PREPARE or GO issued straight after the change can find them. A patch
    // with only the act would have left cue-act-1 in place.
    const second = projector.next("snapshot");
    await select("act-2", "select-2", 1);
    const afterSecond = await second;
    expect(afterSecond).toMatchObject({
      projection: {
        role: "projector",
        show: { activeActId: "act-2" },
        activeCues: [{ id: "cue-act-2" }],
      },
    });
    expect(
      afterSecond.type === "snapshot" &&
        afterSecond.projection.role === "projector" &&
        afterSecond.projection.activeCues.map((cue) => cue.id),
    ).toEqual(["cue-act-2"]);
  });
});

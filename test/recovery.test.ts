import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../shared/domain";
import type { ServerMessage } from "../shared/protocol";
import { createAdminSession } from "../worker/admin-auth";
import { PRIMARY_SHOW_ID } from "../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (id, title, display_mode, audience_vote_state, result_reveal_state,
       active_act_id, revision, created_at, updated_at)
     VALUES (?, 'Show', 'LOBBY', 'CLOSED', 'HIDDEN', NULL, 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  ["act-1", "act-2"].forEach((id, order) =>
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
    ),
  );
}

/** A tiny test client: collects parsed server messages and awaits by type. */
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

describe("failure recovery over real coordinator sockets", () => {
  it("absorbs replayed commands, resnapshots reconnecting clients, and survives eviction", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("recovery-sockets"),
    );
    await stub.fetch("https://show.internal/health");
    let cookie = "";
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
      cookie = login.setCookie?.split(";")[0] ?? "";
    });
    const admin = await open(
      stub,
      { requestedRole: "admin" },
      { Cookie: cookie, Origin: "https://show.test" },
    );
    const audience = await open(stub, { requestedRole: "audience" });

    // The same command delivered twice changes state once and yields the
    // same acknowledgement both times; the audience sees one patch.
    const command = {
      type: "SELECT_ACT",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "select-once",
      expectedRevision: 0,
      actId: "act-1",
    };
    const patch = audience.next("state_patch");
    admin.send({
      type: "admin_command",
      protocolVersion: PROTOCOL_VERSION,
      command,
    });
    const firstAck = await admin.next("command_ack");
    admin.send({
      type: "admin_command",
      protocolVersion: PROTOCOL_VERSION,
      command,
    });
    const secondAck = await admin.next("command_ack");
    expect(firstAck).toMatchObject({
      acknowledgement: { status: "accepted", revision: 1 },
    });
    expect(
      secondAck.type === "command_ack" && secondAck.acknowledgement,
    ).toEqual(firstAck.type === "command_ack" && firstAck.acknowledgement);
    await patch;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      audience.received.filter((message) => message.type === "state_patch"),
    ).toHaveLength(1);

    // A stale command is refused without touching state.
    admin.send({
      type: "admin_command",
      protocolVersion: PROTOCOL_VERSION,
      command: { ...command, commandId: "stale", actId: "act-2" },
    });
    expect(await admin.next("command_ack")).toMatchObject({
      acknowledgement: { status: "stale", revision: 1 },
    });

    // A phone that drops and reconnects gets the authoritative snapshot.
    audience.ws.close(1000, "wifi");
    const again = await open(stub, { requestedRole: "audience" });
    const snapshot = again.received.find((m) => m.type === "snapshot");
    expect(snapshot).toMatchObject({
      revision: 1,
      projection: { role: "audience", show: { activeActId: "act-1" } },
    });

    // An explicit resync always answers with a snapshot, even when nothing
    // was missed, so a client can prove its link is alive.
    const resync = again.next("snapshot");
    again.send({
      type: "resync_request",
      protocolVersion: PROTOCOL_VERSION,
      lastRevision: 1,
    });
    expect(await resync).toMatchObject({ revision: 1 });

    admin.ws.close(1000, "done");
    again.ws.close();
  }, 20_000);

  it("locks the first of two simultaneous judge submissions and reports the other as locked", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("recovery-judges"),
    );
    await stub.fetch("https://show.internal/health");
    const token = "judge-token-recovery-test-0000000000000000000";
    await runInDurableObject(stub, async (_instance, state) => {
      seed(state.storage.sql);
      state.storage.sql.exec(
        "UPDATE shows SET active_act_id = 'act-1' WHERE id = ?",
        PRIMARY_SHOW_ID,
      );
      state.storage.sql.exec(
        `INSERT INTO judges (id, show_id, slot, display_name, token_hash, created_at, revoked_at)
         VALUES ('judge-1', ?, 1, 'J', ?, ?, NULL)`,
        PRIMARY_SHOW_ID,
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO show_runtime (show_id, global_judge_permission, updated_at) VALUES (?, 'OPEN', ?)`,
        PRIMARY_SHOW_ID,
        now,
      );
    });
    const judge = await open(stub, {
      requestedRole: "judge",
      credential: token,
    });
    const updates = Promise.all([
      judge.next("judge_submission_update"),
      new Promise<ServerMessage>((resolve) => {
        let seen = 0;
        judge.ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === "judge_submission_update" && ++seen === 2)
            resolve(message);
        });
      }),
    ]);
    judge.send({
      type: "judge_submit",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "first",
      input: { raw: "8" },
    });
    judge.send({
      type: "judge_submit",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "second",
      input: { raw: "9" },
    });
    const [first, second] = await updates;
    expect(first).toMatchObject({ accepted: true, locked: true });
    expect(second).toMatchObject({ accepted: false, locked: true });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ raw_input: string }>(
            "SELECT raw_input FROM show_judge_submissions WHERE show_id = ? AND judge_id = 'judge-1'",
            PRIMARY_SHOW_ID,
          )
          .toArray(),
      ).toEqual([{ raw_input: "8" }]);
    });
    judge.ws.close();
  }, 20_000);
});

/**
 * Load and chaos harness. Everything here drives the real coordinator through
 * its public HTTP and WebSocket surfaces inside the Workers runtime, so the
 * numbers describe the actual vote path, broadcasts and payloads, not a mock.
 * Run with `npm run test:load`; the metrics print as a table per scenario.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type AudienceScore } from "../../shared/domain";
import type { ServerMessage } from "../../shared/protocol";
import { AUDIENCE_WEIGHTS } from "../../shared/scoring";
import {
  REACTION_INTERVAL_MS,
  REACTION_TARGET_REPORTERS,
  reactionTrafficEstimate,
} from "../../shared/reactions";
import { createAdminSession } from "../../worker/admin-auth";
import { PRIMARY_SHOW_ID, executeAdminCommand } from "../../worker/show-state";

const now = "2026-09-14T00:00:00.000Z";
const ORIGIN = "https://show.test";

function seed(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO shows (id, title, display_mode, audience_vote_state, result_reveal_state,
       active_act_id, revision, created_at, updated_at)
     VALUES (?, 'Load show', 'PERFORMANCE', 'CLOSED', 'HIDDEN', 'act-1', 0, ?, ?)`,
    PRIMARY_SHOW_ID,
    now,
    now,
  );
  ["act-1", "act-2", "act-3"].forEach((id, order) =>
    sql.exec(
      `INSERT INTO acts (id, show_id, order_index, performer_name, school_year, act_name,
         act_type, public_description, internal_notes, created_at, updated_at)
       VALUES (?, ?, ?, 'Performer', 'Year 10', ?, 'Music', 'A public description of sensible length.', '', ?, ?)`,
      id,
      PRIMARY_SHOW_ID,
      order,
      id,
      now,
      now,
    ),
  );
  [1, 2, 3, 4].forEach((slot) =>
    sql.exec(
      `INSERT INTO judges (id, show_id, slot, display_name, token_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      `judge-${slot}`,
      PRIMARY_SHOW_ID,
      slot,
      `Judge ${slot}`,
      new Uint8Array(32).fill(slot).buffer,
      now,
    ),
  );
}

/** 43-char base64url tokens, the exact shape of a real voter cookie. */
function voterToken(index: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index);
  bytes[4] = 0x5a;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** console.table is a no-op in workerd; one line per row keeps the numbers visible. */
function report(
  rows: Record<string, string | number | boolean | null>[],
): void {
  for (const row of rows) {
    console.log(
      "[load] " +
        Object.entries(row)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join("  "),
    );
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  );
}

function summary(label: string, samples: number[]): Record<string, string> {
  return {
    scenario: label,
    n: String(samples.length),
    "p50 ms": percentile(samples, 0.5).toFixed(1),
    "p95 ms": percentile(samples, 0.95).toFixed(1),
    "max ms": Math.max(...samples).toFixed(1),
  };
}

async function vote(
  stub: DurableObjectStub,
  index: number,
  actId: string,
  score: AudienceScore,
): Promise<{ status: number; code: string | null; ms: number }> {
  const started = performance.now();
  const response = await stub.fetch(
    new Request(`${ORIGIN}/api/vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: `sytycds_voter=${voterToken(index)}`,
      },
      body: JSON.stringify({ actId, score }),
    }),
  );
  const body = (await response.json()) as { code?: string };
  return {
    status: response.status,
    code: body.code ?? null,
    ms: performance.now() - started,
  };
}

class Client {
  readonly received: ServerMessage[] = [];
  private waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];
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
  next(
    type: ServerMessage["type"],
    timeoutMs = 10_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No ${type} within ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
  count(type: ServerMessage["type"]): number {
    return this.received.filter((m) => m.type === type).length;
  }
}

async function connect(
  stub: DurableObjectStub,
  hello: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Client> {
  const response = await stub.fetch(
    new Request(`${ORIGIN}/api/ws`, {
      headers: { Upgrade: "websocket", ...headers },
    }),
  );
  if (!response.webSocket) throw new Error("upgrade failed");
  const client = new Client(response.webSocket);
  const snapshot = client.next("snapshot");
  client.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, ...hello });
  await snapshot;
  return client;
}

/** Sends a command the way the console does, so broadcasts really happen. */
async function operate(
  stub: DurableObjectStub,
  admin: Client,
  type: string,
  extras: Record<string, unknown> = {},
): Promise<string> {
  let revision = 0;
  await runInDurableObject(stub, (_instance, state) => {
    revision = state.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM shows WHERE id = ?",
        PRIMARY_SHOW_ID,
      )
      .one().revision;
  });
  const ack = admin.next("command_ack");
  admin.send({
    type: "admin_command",
    protocolVersion: PROTOCOL_VERSION,
    command: {
      type,
      protocolVersion: PROTOCOL_VERSION,
      commandId: crypto.randomUUID().replaceAll("-", ""),
      expectedRevision: revision,
      ...extras,
    },
  });
  const message = await ack;
  return message.type === "command_ack" ? message.acknowledgement.status : "";
}

async function coordinator(name: string): Promise<{
  stub: DurableObjectStub;
  cookie: string;
  command: (type: string, extras?: Record<string, unknown>) => Promise<string>;
}> {
  const stub = env.SHOW_COORDINATOR.get(env.SHOW_COORDINATOR.idFromName(name));
  await stub.fetch("https://show.internal/health");
  let cookie = "";
  await runInDurableObject(stub, async (_instance, state) => {
    seed(state.storage.sql);
    const login = await createAdminSession(
      state.storage,
      new Request(`${ORIGIN}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ secret: "s" }),
      }),
      "s",
      PRIMARY_SHOW_ID,
    );
    cookie = login.setCookie?.split(";")[0] ?? "";
  });
  let counter = 0;
  const command = async (
    type: string,
    extras: Record<string, unknown> = {},
  ) => {
    counter += 1;
    let status = "";
    await runInDurableObject(stub, (_instance, state) => {
      const revision = state.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM shows WHERE id = ?",
          PRIMARY_SHOW_ID,
        )
        .one().revision;
      status = executeAdminCommand(
        state.storage,
        PRIMARY_SHOW_ID,
        { kind: "admin" },
        {
          type,
          protocolVersion: PROTOCOL_VERSION,
          commandId: `load-${counter}`,
          expectedRevision: revision,
          ...extras,
        },
      ).acknowledgement.status;
    });
    return status;
  };
  return { stub, cookie, command };
}

function aggregateRow(state: DurableObjectState, actId: string) {
  return state.storage.sql
    .exec<{
      vote_count: number;
      weighted_sum: number;
      total_weight: number;
      weighted_mean: number;
    }>(
      "SELECT vote_count, weighted_sum, total_weight, weighted_mean FROM audience_aggregates WHERE show_id = ? AND act_id = ?",
      PRIMARY_SHOW_ID,
      actId,
    )
    .toArray()[0];
}

describe("audience vote path under load", () => {
  for (const voters of [100, 500, 1000]) {
    it(`accepts ${voters} distinct votes, rejects replays, and keeps the aggregate exact`, async () => {
      const { stub, command } = await coordinator(`load-votes-${voters}`);
      expect(await command("OPEN_AUDIENCE_VOTING")).toBe("accepted");

      const scores: AudienceScore[] = [];
      const latencies: number[] = [];
      const started = performance.now();
      // Bursts of 50 concurrent requests approximate hundreds of phones
      // submitting inside the same second without serialising the client.
      for (let batch = 0; batch < voters; batch += 50) {
        const results = await Promise.all(
          Array.from({ length: Math.min(50, voters - batch) }, (_, i) => {
            const score = ((batch + i) % 11) as AudienceScore;
            scores.push(score);
            return vote(stub, batch + i, "act-1", score);
          }),
        );
        for (const result of results) {
          expect(result.status).toBe(200);
          latencies.push(result.ms);
        }
      }
      const wall = performance.now() - started;

      const replays = await Promise.all(
        Array.from({ length: 50 }, (_, i) => vote(stub, i, "act-1", 3)),
      );
      expect(
        replays.every((r) => r.status === 409 && r.code === "ALREADY_VOTED"),
      ).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        const row = aggregateRow(state, "act-1");
        const weightedSum = scores.reduce<number>(
          (sum, score) => sum + score * AUDIENCE_WEIGHTS[score],
          0,
        );
        const totalWeight = scores.reduce<number>(
          (sum, score) => sum + AUDIENCE_WEIGHTS[score],
          0,
        );
        expect(row?.vote_count).toBe(voters);
        expect(row?.weighted_sum).toBeCloseTo(weightedSum, 6);
        expect(row?.total_weight).toBeCloseTo(totalWeight, 6);
        expect(row?.weighted_mean).toBeCloseTo(weightedSum / totalWeight, 9);
      });

      report([
        {
          ...summary(`${voters} HTTP votes`, latencies),
          "votes/s": (voters / (wall / 1000)).toFixed(0),
        },
      ]);
    });
  }

  it("keeps the per-vote SQL on primary keys and measures raw transaction cost", async () => {
    const { stub, command } = await coordinator("load-sql-cost");
    expect(await command("OPEN_AUDIENCE_VOTING")).toBe("accepted");
    await runInDurableObject(stub, (_instance, state) => {
      const queries: [string, SqlStorageValue[]][] = [
        [
          "SELECT active_act_id, audience_vote_state, revision FROM shows WHERE id = ?",
          [PRIMARY_SHOW_ID],
        ],
        [
          "SELECT score FROM audience_votes WHERE show_id = ? AND act_id = ? AND voter_id_hash = ?",
          [PRIMARY_SHOW_ID, "act-1", new Uint8Array(32).buffer],
        ],
        [
          "SELECT vote_count FROM audience_aggregates WHERE show_id = ? AND act_id = ?",
          [PRIMARY_SHOW_ID, "act-1"],
        ],
      ];
      const plans = queries.map(([sql, params]) =>
        state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail)
          .join(" | "),
      );
      for (const plan of plans) {
        expect(plan).toMatch(/USING (INDEX|INTEGER PRIMARY KEY)|SEARCH/u);
        expect(plan).not.toMatch(/SCAN/u);
      }
      report(plans.map((plan) => ({ plan })));
    });

    // Direct transaction timing, no HTTP: the coordinator CPU per accepted vote.
    const samples: number[] = [];
    await runInDurableObject(stub, async (_instance, state) => {
      const { submitAudienceVote } =
        await import("../../worker/audience-votes");
      for (let i = 0; i < 1000; i += 1) {
        const hash = new Uint8Array(32);
        new DataView(hash.buffer).setUint32(0, 100_000 + i);
        const started = performance.now();
        const outcome = submitAudienceVote(
          state.storage,
          PRIMARY_SHOW_ID,
          hash.buffer,
          {
            actIdentifier: "act-1",
            score: (i % 11) as AudienceScore,
          },
        );
        samples.push(performance.now() - started);
        expect(outcome.ok).toBe(true);
      }
      expect(aggregateRow(state, "act-1")?.vote_count).toBe(1000);
    });
    report([summary("submitAudienceVote() transaction", samples)]);
    // The hot path is a handful of indexed statements; a growing table must
    // not make it slower. Compare the last hundred with the first hundred.
    const early = percentile(samples.slice(0, 100), 0.5);
    const late = percentile(samples.slice(-100), 0.5);
    expect(late).toBeLessThan(Math.max(early * 4, 2));
  });

  it("closes voting mid-burst and refuses a vote that arrives for a changed act", async () => {
    const { stub, command } = await coordinator("load-close-mid-burst");
    expect(await command("OPEN_AUDIENCE_VOTING")).toBe("accepted");
    const first = Promise.all(
      Array.from({ length: 60 }, (_, i) => vote(stub, i, "act-1", 5)),
    );
    const closed = command("CLOSE_AUDIENCE_VOTING");
    const second = Promise.all(
      Array.from({ length: 60 }, (_, i) => vote(stub, 60 + i, "act-1", 5)),
    );
    const [firstResults, closeStatus, secondResults] = await Promise.all([
      first,
      closed,
      second,
    ]);
    expect(closeStatus).toBe("accepted");
    const all = [...firstResults, ...secondResults];
    const accepted = all.filter((r) => r.status === 200).length;
    const refused = all.filter((r) => r.code === "VOTING_CLOSED").length;
    expect(accepted + refused).toBe(120);
    await runInDurableObject(stub, (_instance, state) => {
      expect(aggregateRow(state, "act-1")?.vote_count ?? 0).toBe(accepted);
    });

    // The operator moves on; a phone still holding act-1 is refused, never
    // counted against act-2.
    expect(await command("SELECT_ACT", { actId: "act-2" })).toBe("accepted");
    expect(await command("OPEN_AUDIENCE_VOTING")).toBe("accepted");
    const stale = await vote(stub, 999, "act-1", 9);
    expect(stale).toMatchObject({ status: 409, code: "WRONG_ACT" });
    const fresh = await vote(stub, 999, "act-2", 9);
    expect(fresh.status).toBe(200);
    report([{ accepted, refused, staleActRefused: stale.code }]);
  });
});

describe("realtime fan-out under load", () => {
  for (const phones of [100, 500, 1_000]) {
    it(`connects ${phones} phones, fans out one state change, and survives a reconnect storm`, async () => {
      const { stub, cookie } = await coordinator(`load-sockets-${phones}`);
      const admin = await connect(
        stub,
        { requestedRole: "admin" },
        { Cookie: cookie, Origin: ORIGIN },
      );

      const connectStarted = performance.now();
      const clients: Client[] = [];
      for (let batch = 0; batch < phones; batch += 50) {
        clients.push(
          ...(await Promise.all(
            Array.from({ length: Math.min(50, phones - batch) }, () =>
              connect(stub, { requestedRole: "audience" }),
            ),
          )),
        );
      }
      const connectMs = performance.now() - connectStarted;
      const snapshotBytes = JSON.stringify(
        clients[0]?.received.find((m) => m.type === "snapshot"),
      ).length;

      // One operator action reaches every phone exactly once.
      const fanoutStarted = performance.now();
      const waits = clients.map((client) => client.next("voting_state_update"));
      expect(await operate(stub, admin, "OPEN_AUDIENCE_VOTING")).toBe(
        "accepted",
      );
      await Promise.all(waits);
      const fanoutMs = performance.now() - fanoutStarted;

      // A vote burst must not broadcast per vote to phones.
      const before = clients.map((client) => client.received.length);
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => vote(stub, i, "act-1", 7)),
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      const audienceExtra = clients.reduce(
        (sum, client, index) =>
          sum + client.received.length - (before[index] ?? 0),
        0,
      );
      expect(audienceExtra).toBe(0);
      const aggregateUpdates = admin.count("aggregate_update");
      expect(aggregateUpdates).toBeGreaterThan(0);
      // Coalesced at 250 ms: a 100-vote burst is a handful of updates.
      expect(aggregateUpdates).toBeLessThanOrEqual(12);

      // Reconnect storm: everyone drops and comes back at once. The operator
      // must see connection counts coalesced, not one per socket.
      const countsBefore = admin.count("connection_count");
      for (const client of clients) client.ws.close(1000, "storm");
      const stormStarted = performance.now();
      const reconnected: Client[] = [];
      for (let batch = 0; batch < phones; batch += 50) {
        reconnected.push(
          ...(await Promise.all(
            Array.from({ length: Math.min(50, phones - batch) }, () =>
              connect(stub, { requestedRole: "audience" }),
            ),
          )),
        );
      }
      const stormMs = performance.now() - stormStarted;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const countMessages = admin.count("connection_count") - countsBefore;
      expect(countMessages).toBeLessThan(phones / 4);
      expect(
        reconnected.every(
          (client) =>
            client.received.find((m) => m.type === "snapshot") !== undefined,
        ),
      ).toBe(true);

      report([
        {
          phones,
          "connect ms": connectMs.toFixed(0),
          "fan-out ms": fanoutMs.toFixed(0),
          "audience snapshot bytes": snapshotBytes,
          "aggregate updates for 100 votes": aggregateUpdates,
          "reconnect storm ms": stormMs.toFixed(0),
          "connection_count msgs": countMessages,
        },
      ]);
      for (const client of reconnected) client.ws.close();
      admin.ws.close();
    });
  }

  it("collapses repeated operator clicks into one accepted change", async () => {
    const { stub, cookie } = await coordinator("load-double-click");
    const admin = await connect(
      stub,
      { requestedRole: "admin" },
      { Cookie: cookie, Origin: ORIGIN },
    );
    const same = {
      type: "SET_DISPLAY_MODE",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "double",
      expectedRevision: 0,
      mode: "SCOREBOARD",
    };
    const acks: Promise<ServerMessage>[] = [];
    for (let i = 0; i < 5; i += 1) {
      acks.push(admin.next("command_ack"));
      admin.send({
        type: "admin_command",
        protocolVersion: PROTOCOL_VERSION,
        command: same,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      admin.send({
        type: "admin_command",
        protocolVersion: PROTOCOL_VERSION,
        command: { ...same, commandId: `distinct-${i}`, mode: "LOBBY" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const results = admin.received.filter((m) => m.type === "command_ack");
    const statuses = results.map((m) =>
      m.type === "command_ack" ? m.acknowledgement.status : "",
    );
    expect(statuses.filter((s) => s === "accepted")).toHaveLength(5);
    expect(statuses.filter((s) => s === "stale")).toHaveLength(5);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ display_mode: string; revision: number }>(
            "SELECT display_mode, revision FROM shows WHERE id = ?",
            PRIMARY_SHOW_ID,
          )
          .one(),
      ).toEqual({ display_mode: "SCOREBOARD", revision: 1 });
    });
    admin.ws.close();
  });

  it("measures role snapshot payloads", async () => {
    const { stub, cookie } = await coordinator("load-payloads");
    const admin = await connect(
      stub,
      { requestedRole: "admin" },
      { Cookie: cookie, Origin: ORIGIN },
    );
    const audience = await connect(stub, { requestedRole: "audience" });
    const size = (client: Client) =>
      JSON.stringify(client.received.find((m) => m.type === "snapshot")).length;
    report([
      { role: "admin", bytes: size(admin) },
      { role: "audience", bytes: size(audience) },
    ]);
    expect(size(audience)).toBeLessThan(2_000);
    admin.ws.close();
    audience.ws.close();
  });
});

describe("three-hour reaction traffic model", () => {
  it("keeps 54 million local taps to 10,800 sampled packets", () => {
    const phones = 1_000;
    const seconds = 3 * 60 * 60;
    const tapsPerPhoneSecond = 5;
    const totalLocalTaps = phones * tapsPerPhoneSecond * seconds;
    const packets = reactionTrafficEstimate(phones, seconds);
    const averagePacketsPerSecond = packets / seconds;
    // Eligible reporters occupy consecutive rotating slots and locally spread
    // themselves across the five-second interval.
    const peakPacketsPerSecond = Math.ceil(
      REACTION_TARGET_REPORTERS / (REACTION_INTERVAL_MS / 1_000),
    );
    const billableTwentyMessageUnits = Math.ceil(packets / 20);
    expect(totalLocalTaps).toBe(54_000_000);
    expect(packets).toBe(10_800);
    expect(averagePacketsPerSecond).toBe(1);
    expect(peakPacketsPerSecond).toBe(1);
    expect(REACTION_INTERVAL_MS).toBe(5_000);
    expect(billableTwentyMessageUnits).toBe(540);
    report([
      {
        scenario: "1000 phones × 5 taps/s × 3h",
        "local taps": totalLocalTaps,
        "packets total": packets,
        "packets/s avg": averagePacketsPerSecond,
        "packets/s peak": peakPacketsPerSecond,
        "20-message units": billableTwentyMessageUnits,
      },
    ]);
  });
});

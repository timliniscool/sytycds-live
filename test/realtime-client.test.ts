import { describe, expect, it, vi } from "vitest";

import {
  commandId,
  PROTOCOL_VERSION,
  showRevision,
  type AudienceShowProjection,
} from "../shared/domain";
import { serialiseServerMessage } from "../shared/protocol";
import {
  RealtimeClient,
  type WebSocketLike,
} from "../src/realtime/RealtimeClient";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.onclose?.({ code } as CloseEvent);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const snapshotProjection: AudienceShowProjection = {
  role: "audience",
  show: {
    title: "Show",
    displayMode: "LOBBY",
    activeActId: null,
    audienceVoteState: "CLOSED",
    revision: showRevision(0),
  },
  activeAct: null,
};

describe("browser realtime client", () => {
  it("accepts snapshots, ignores stale events, and requests resync for gaps", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient({
      url: "ws://example.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      },
      createSocket: () => socket,
    });
    client.connect();
    socket.open();
    expect(socket.sent).toHaveLength(1);
    socket.receive(
      serialiseServerMessage({
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        projection: snapshotProjection,
      }),
    );
    expect(client.getState().connection).toBe("LIVE");

    socket.receive(
      serialiseServerMessage({
        type: "voting_state_update",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        state: "OPEN",
      }),
    );
    expect(client.getState().audienceVoting).toBe("OPEN");
    socket.receive(
      serialiseServerMessage({
        type: "voting_state_update",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(2),
        state: "CLOSED",
      }),
    );
    expect(client.getState().connection).toBe("DEGRADED");
    expect(socket.sent.at(-1)).toContain("resync_request");
    client.destroy();
  });

  it("stops retrying when the coordinator refuses the role credential", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({
      url: "ws://example.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "judge",
        credential: "not-a-real-token",
      },
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    });
    client.connect();
    sockets[0]?.close(1008);
    expect(client.getState().connection).toBe("UNAUTHORISED");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    client.destroy();
    vi.useRealTimers();
  });

  it("keeps projector telemetry and acknowledgements for the operator", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient({
      url: "ws://example.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "admin",
      },
      createSocket: () => socket,
    });
    client.connect();
    socket.open();
    socket.receive(
      serialiseServerMessage({
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        projection: snapshotProjection,
      }),
    );
    socket.receive(
      serialiseServerMessage({
        type: "projector_telemetry",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        status: {
          visual: "PLAYING",
          audio: "PLAYING",
          positionMs: 12_000,
          durationMs: 90_000,
          armed: true,
          black: false,
          error: null,
        },
      }),
    );
    socket.receive(
      serialiseServerMessage({
        type: "projector_acknowledgement",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(1),
        commandId: commandId("cmd-1"),
        succeeded: false,
        detail: "image failed to load",
      }),
    );
    expect(client.getState().projectorTelemetry?.positionMs).toBe(12_000);
    expect(client.getState().lastProjectorAcknowledgement).toMatchObject({
      succeeded: false,
      detail: "image failed to load",
    });
    client.destroy();
  });

  it("advances its own revision while a patched projection keeps the old one", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient({
      url: "ws://example.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      },
      createSocket: () => socket,
    });
    client.connect();
    socket.open();
    socket.receive(
      serialiseServerMessage({
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(0),
        projection: snapshotProjection,
      }),
    );
    socket.receive(
      serialiseServerMessage({
        type: "state_patch",
        protocolVersion: PROTOCOL_VERSION,
        revision: showRevision(1),
        patches: [{ kind: "display", displayMode: "HOLD", blackScreen: false }],
      }),
    );
    // Commands must be stamped from `revision`, never from the snapshot copy,
    // or every command after the first is rejected as stale.
    expect(Number(client.getState().revision)).toBe(1);
    expect(Number(client.getState().projection?.show.revision)).toBe(0);
    client.destroy();
  });

  it("reconnects after being released and mounted again", () => {
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({
      url: "ws://example.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      },
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    client.connect();
    client.destroy();
    client.connect();
    expect(sockets).toHaveLength(2);
    client.destroy();
  });

  it("uses one reconnect timer after a closed socket", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({
      url: "ws://example.test/api/ws",
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        requestedRole: "audience",
      },
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    });
    client.connect();
    sockets[0]?.close();
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
    client.destroy();
    vi.useRealTimers();
  });
});

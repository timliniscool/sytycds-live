import { describe, expect, it, vi } from "vitest";

import {
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

  close(): void {
    this.onclose?.({} as CloseEvent);
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

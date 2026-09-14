import { useSyncExternalStore } from "react";

import {
  PROTOCOL_VERSION,
  type AudienceAggregate,
  type AudienceVoteState,
  type ClientProjection,
  type JudgePermissionState,
  type ShowRevision,
} from "../../shared/domain";
import {
  parseServerMessage,
  type ClientHello,
  type ClientMessage,
  type CommandAcknowledgementMessage,
  type MediaCommandMessage,
  type ServerMessage,
} from "../../shared/protocol";

export type RealtimeConnectionState =
  "CONNECTING" | "LIVE" | "RECONNECTING" | "DEGRADED" | "INCOMPATIBLE";

export interface RealtimeState {
  connection: RealtimeConnectionState;
  revision: ShowRevision | null;
  projection: ClientProjection | null;
  aggregates: ReadonlyMap<string, AudienceAggregate>;
  audienceVoting: AudienceVoteState | null;
  judgePermission: JudgePermissionState | null;
  lastMediaCommand: MediaCommandMessage | null;
  lastCommandAcknowledgement: CommandAcknowledgementMessage | null;
  audienceConnections: number;
  judgeConnections: ReadonlySet<string>;
  lastError: string | null;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeClientOptions {
  url: string;
  hello: ClientHello;
  createSocket?: (url: string) => WebSocketLike;
  random?: () => number;
}

interface SelectorSubscription<Value> {
  selector: (state: RealtimeState) => Value;
  listener: () => void;
  value: Value;
}

const INITIAL_STATE: RealtimeState = {
  connection: "CONNECTING",
  revision: null,
  projection: null,
  aggregates: new Map(),
  audienceVoting: null,
  judgePermission: null,
  lastMediaCommand: null,
  lastCommandAcknowledgement: null,
  audienceConnections: 0,
  judgeConnections: new Set(),
  lastError: null,
};

const OPEN = 1;
const MAX_RETRY_DELAY_MS = 10_000;
const BASE_RETRY_DELAY_MS = 500;
const MAX_SEEN_MESSAGES = 128;

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url);
}

function aggregateMap(
  projection: ClientProjection,
): ReadonlyMap<string, AudienceAggregate> {
  if (projection.role !== "admin") {
    return new Map();
  }
  return new Map(
    projection.audienceAggregates.map((aggregate) => [
      aggregate.actId,
      aggregate,
    ]),
  );
}

function applyPatches(
  projection: ClientProjection,
  message: Extract<ServerMessage, { type: "state_patch" }>,
): ClientProjection {
  let next = projection;
  for (const patch of message.patches) {
    if (patch.kind === "active_act") {
      switch (next.role) {
        case "admin":
          next = {
            ...next,
            show: {
              ...next.show,
              activeActId: patch.activeActId as typeof next.show.activeActId,
            },
          };
          break;
        case "projector":
          next = {
            ...next,
            show: {
              ...next.show,
              activeActId: patch.activeActId as typeof next.show.activeActId,
            },
            activeAct: patch.activeAct,
          };
          break;
        case "audience":
          next = {
            ...next,
            show: {
              ...next.show,
              activeActId: patch.activeActId as typeof next.show.activeActId,
            },
            activeAct: patch.activeAct,
          };
          break;
        case "judge":
          next = {
            ...next,
            show: {
              ...next.show,
              activeActId: patch.activeActId as typeof next.show.activeActId,
            },
            activeAct: patch.activeAct,
          };
          break;
      }
    }
    if (
      patch.kind === "display" &&
      (next.role === "admin" || next.role === "projector")
    ) {
      if (next.role === "admin") {
        next = {
          ...next,
          show: {
            ...next.show,
            displayMode: patch.displayMode as typeof next.show.displayMode,
          },
          runtime: { ...next.runtime, blackScreen: patch.blackScreen },
        };
      } else {
        next = {
          ...next,
          show: {
            ...next.show,
            displayMode: patch.displayMode as typeof next.show.displayMode,
          },
          runtime: { ...next.runtime, blackScreen: patch.blackScreen },
        };
      }
    }
    if (patch.kind === "media" && next.role === "admin") {
      next = {
        ...next,
        runtime: {
          ...next.runtime,
          preparedCueId: patch.preparedCueId,
          activeVisualCueId: patch.activeVisualCueId,
          activeAudioCueId: patch.activeAudioCueId,
          visualTransport:
            patch.visualTransport as typeof next.runtime.visualTransport,
          audioTransport:
            patch.audioTransport as typeof next.runtime.audioTransport,
          blackScreen: patch.blackScreen,
        },
      };
    }
    if (patch.kind === "media" && next.role === "projector") {
      next = {
        ...next,
        runtime: {
          ...next.runtime,
          preparedCueId: patch.preparedCueId,
          activeVisualCueId: patch.activeVisualCueId,
          activeAudioCueId: patch.activeAudioCueId,
          visualTransport:
            patch.visualTransport as typeof next.runtime.visualTransport,
          audioTransport:
            patch.audioTransport as typeof next.runtime.audioTransport,
          blackScreen: patch.blackScreen,
        },
      };
    }
    if (patch.kind === "result_reveal" && next.role === "admin") {
      next = {
        ...next,
        show: { ...next.show, resultRevealState: patch.state },
      };
    }
  }
  return next;
}

/**
 * One page owns one connection. This deliberately small external store exposes
 * selector subscriptions, allowing an aggregate update to skip unrelated UI.
 */
export class RealtimeClient {
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly random: () => number;
  private readonly selectorSubscriptions = new Set<
    SelectorSubscription<unknown>
  >();
  private readonly seenMessages = new Set<string>();
  private socket: WebSocketLike | null = null;
  private retryTimer: number | null = null;
  private retryAttempt = 0;
  private disposed = false;
  private online =
    typeof navigator === "undefined" || navigator.onLine !== false;
  private state: RealtimeState = INITIAL_STATE;
  private readonly onOnline = () => {
    this.online = true;
    this.connect();
  };
  private readonly onOffline = () => {
    this.online = false;
    this.publish({
      ...this.state,
      connection: "DEGRADED",
      lastError: "Browser is offline",
    });
    this.socket?.close(1000, "Browser offline");
  };
  private readonly onVisibilityChange = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      this.connect();
    }
  };

  constructor(private readonly options: RealtimeClientOptions) {
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.random = options.random ?? Math.random;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  connect(): void {
    if (
      this.disposed ||
      !this.online ||
      this.socket ||
      this.state.connection === "INCOMPATIBLE"
    ) {
      return;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.publish({
      ...this.state,
      connection: this.retryAttempt === 0 ? "CONNECTING" : "RECONNECTING",
      lastError: null,
    });
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.disposed) {
        return;
      }
      socket.send(JSON.stringify(this.options.hello));
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === "string") {
        this.handleServerMessage(event.data);
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) {
        this.publish({
          ...this.state,
          connection: "DEGRADED",
          lastError: "WebSocket error",
        });
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (!this.disposed && this.state.connection !== "INCOMPATIBLE") {
        this.scheduleReconnect();
      }
    };
  }

  send(message: ClientMessage): boolean {
    if (
      !this.socket ||
      this.socket.readyState !== OPEN ||
      this.state.connection === "INCOMPATIBLE"
    ) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  requestResync(): void {
    if (this.state.revision === null) {
      return;
    }
    this.send({
      type: "resync_request",
      protocolVersion: PROTOCOL_VERSION,
      lastRevision: this.state.revision,
    });
  }

  getState(): RealtimeState {
    return this.state;
  }

  subscribeSelector<Value>(
    selector: (state: RealtimeState) => Value,
    listener: () => void,
  ): () => void {
    const subscription: SelectorSubscription<Value> = {
      selector,
      listener,
      value: selector(this.state),
    };
    this.selectorSubscriptions.add(
      subscription as SelectorSubscription<unknown>,
    );
    return () =>
      this.selectorSubscriptions.delete(
        subscription as SelectorSubscription<unknown>,
      );
  }

  destroy(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close(1000, "Page closed");
    this.socket = null;
    this.selectorSubscriptions.clear();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private handleServerMessage(payload: string): void {
    const parsed = parseServerMessage(payload);
    if (!parsed.ok) {
      this.publish({
        ...this.state,
        connection: parsed.incompatible ? "INCOMPATIBLE" : "DEGRADED",
        lastError: parsed.reason,
      });
      return;
    }
    const message = parsed.message;
    if (message.type === "force_resync") {
      this.publish({
        ...this.state,
        connection: "DEGRADED",
        lastError: message.reason,
      });
      this.requestResync();
      return;
    }
    if (message.type === "snapshot") {
      if (
        this.state.revision !== null &&
        Number(message.revision) < Number(this.state.revision)
      ) {
        return;
      }
      this.seenMessages.clear();
      this.publish({
        ...this.state,
        connection: "LIVE",
        revision: message.revision,
        projection: message.projection,
        aggregates: aggregateMap(message.projection),
        audienceVoting:
          message.projection.role === "audience"
            ? message.projection.show.audienceVoteState
            : null,
        judgePermission:
          message.projection.role === "judge"
            ? message.projection.permission
            : null,
        lastError: null,
      });
      this.retryAttempt = 0;
      return;
    }

    const currentRevision = this.state.revision;
    if (
      currentRevision !== null &&
      Number(message.revision) < Number(currentRevision)
    ) {
      return;
    }
    if (
      currentRevision !== null &&
      Number(message.revision) > Number(currentRevision) + 1
    ) {
      this.publish({
        ...this.state,
        connection: "DEGRADED",
        lastError: "Revision gap detected",
      });
      this.requestResync();
      return;
    }
    const messageKey = `${message.revision}:${message.type}:${payload}`;
    if (this.seenMessages.has(messageKey)) {
      return;
    }
    this.rememberMessage(messageKey);
    this.applyIncrementalMessage(message);
  }

  private applyIncrementalMessage(
    message: Exclude<ServerMessage, { type: "snapshot" | "force_resync" }>,
  ): void {
    let projection = this.state.projection;
    let aggregates = this.state.aggregates;
    let audienceVoting = this.state.audienceVoting;
    let judgePermission = this.state.judgePermission;
    let lastMediaCommand = this.state.lastMediaCommand;
    let lastCommandAcknowledgement = this.state.lastCommandAcknowledgement;
    let audienceConnections = this.state.audienceConnections;
    let judgeConnections = this.state.judgeConnections;

    switch (message.type) {
      case "state_patch":
        if (projection) {
          projection = applyPatches(projection, message);
        }
        break;
      case "aggregate_update": {
        const nextAggregates = new Map(aggregates);
        nextAggregates.set(message.aggregate.actId, message.aggregate);
        aggregates = nextAggregates;
        break;
      }
      case "voting_state_update":
        audienceVoting = message.state;
        if (projection?.role === "audience") {
          projection = {
            ...projection,
            show: { ...projection.show, audienceVoteState: message.state },
          };
        }
        if (projection?.role === "admin") {
          projection = {
            ...projection,
            show: { ...projection.show, audienceVoteState: message.state },
          };
        }
        break;
      case "judge_permission_update":
        judgePermission = message.state;
        if (projection?.role === "judge") {
          projection = { ...projection, permission: message.state };
        }
        break;
      case "media_command":
        lastMediaCommand = message;
        break;
      case "result_reveal":
        if (projection?.role === "admin") {
          projection = {
            ...projection,
            show: { ...projection.show, resultRevealState: message.state },
          };
        }
        break;
      case "command_ack":
        lastCommandAcknowledgement = message;
        break;
      case "projector_acknowledgement":
        break;
      case "connection_count":
        audienceConnections = message.audience;
        judgeConnections = new Set(message.judgeIds);
        break;
      case "protocol_error":
        break;
    }

    this.publish({
      ...this.state,
      connection: "LIVE",
      revision:
        this.state.revision === null ||
        Number(message.revision) > Number(this.state.revision)
          ? message.revision
          : this.state.revision,
      projection,
      aggregates,
      audienceVoting,
      judgePermission,
      lastMediaCommand,
      lastCommandAcknowledgement,
      audienceConnections,
      judgeConnections,
      lastError: message.type === "protocol_error" ? message.detail : null,
    });
  }

  private scheduleReconnect(): void {
    if (!this.online) {
      this.publish({
        ...this.state,
        connection: "DEGRADED",
        lastError: "Browser is offline",
      });
      return;
    }
    const exponentialDelay = Math.min(
      BASE_RETRY_DELAY_MS * 2 ** this.retryAttempt,
      MAX_RETRY_DELAY_MS,
    );
    const jitter = 0.5 + this.random();
    const delay = Math.round(exponentialDelay * jitter);
    this.retryAttempt += 1;
    this.publish({ ...this.state, connection: "RECONNECTING" });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private rememberMessage(key: string): void {
    this.seenMessages.add(key);
    if (this.seenMessages.size <= MAX_SEEN_MESSAGES) {
      return;
    }
    const oldest = this.seenMessages.values().next().value;
    if (oldest) {
      this.seenMessages.delete(oldest);
    }
  }

  private publish(nextState: RealtimeState): void {
    this.state = nextState;
    for (const subscription of this.selectorSubscriptions) {
      const nextValue = subscription.selector(nextState);
      if (!Object.is(subscription.value, nextValue)) {
        subscription.value = nextValue;
        subscription.listener();
      }
    }
  }
}

export function useRealtimeSelector<Value>(
  client: RealtimeClient,
  selector: (state: RealtimeState) => Value,
): Value {
  return useSyncExternalStore(
    (listener) => client.subscribeSelector(selector, listener),
    () => selector(client.getState()),
    () => selector(client.getState()),
  );
}

export function showWebSocketUrl(location: Location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/ws`;
}

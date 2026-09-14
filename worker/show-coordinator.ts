import { DurableObject } from "cloudflare:workers";

import type { AdminCommand } from "../shared/admin-command";
import {
  PROTOCOL_VERSION,
  showRevision,
  type ConnectionRole,
  type JudgeId,
} from "../shared/domain";
import {
  parseClientMessage,
  serialiseServerMessage,
  type ClientHello,
  type ServerMessage,
} from "../shared/protocol";
import { isRecord } from "../shared/trust";
import { initialiseSchema, readSchemaVersion } from "./schema";
import { authenticateSocketRole } from "./socket-auth";
import {
  executeAdminCommand,
  PRIMARY_SHOW_ID,
  projectShowState,
  type StateChange,
} from "./show-state";

interface CoordinatorHealth {
  ok: true;
  storage: string;
  schemaVersion: number;
}

interface AwaitingHelloAttachment {
  phase: "awaiting_hello";
}

interface ReadyAttachment {
  phase: "ready";
  role: ConnectionRole;
  protocolVersion: typeof PROTOCOL_VERSION;
}

type SocketAttachment = AwaitingHelloAttachment | ReadyAttachment;

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (
    !isRecord(value) ||
    (value.phase !== "awaiting_hello" && value.phase !== "ready")
  ) {
    return false;
  }
  if (value.phase === "awaiting_hello") {
    return true;
  }
  if (
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isRecord(value.role) ||
    typeof value.role.kind !== "string"
  ) {
    return false;
  }
  if (value.role.kind === "judge") {
    return typeof value.role.judgeId === "string";
  }
  return (
    value.role.kind === "admin" ||
    value.role.kind === "projector" ||
    value.role.kind === "audience"
  );
}

export class ShowCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initialiseSchema(ctx.storage);
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const health: CoordinatorHealth = {
        ok: true,
        storage: "SQLite",
        schemaVersion: readSchemaVersion(this.ctx.storage.sql),
      };
      return Response.json(health);
    }
    if (request.method === "GET" && url.pathname === "/api/ws") {
      return this.upgradeWebSocket(request);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private upgradeWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "WebSocket upgrade required" },
        { status: 426 },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      phase: "awaiting_hello",
    } satisfies AwaitingHelloAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    payload: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = this.socketAttachment(ws);
    if (!attachment) {
      ws.close(1011, "Invalid socket metadata");
      return;
    }

    const parsed = parseClientMessage(payload);
    if (!parsed.ok) {
      this.sendProtocolError(ws, "invalid_message", parsed.reason);
      return;
    }

    if (attachment.phase === "awaiting_hello") {
      if (parsed.message.type !== "hello") {
        this.sendProtocolError(
          ws,
          "unauthorised",
          "Send hello before other messages",
        );
        return;
      }
      await this.handleHello(ws, parsed.message);
      return;
    }

    if (parsed.message.type === "hello") {
      this.sendProtocolError(
        ws,
        "invalid_message",
        "Connection role is already established",
      );
      return;
    }

    if (parsed.message.type === "resync_request") {
      this.sendSnapshot(ws, attachment.role);
      return;
    }

    if (parsed.message.type === "admin_command") {
      this.handleAdminCommand(ws, attachment.role, parsed.message.command);
      return;
    }

    if (parsed.message.type === "projector_ack") {
      if (attachment.role.kind !== "projector") {
        this.sendProtocolError(
          ws,
          "unauthorised",
          "Only a projector may acknowledge media",
        );
        return;
      }
      this.broadcastAdmin({
        type: "projector_acknowledgement",
        protocolVersion: PROTOCOL_VERSION,
        revision: this.currentRevision(),
        commandId: parsed.message.commandId,
        succeeded: parsed.message.succeeded,
        ...(parsed.message.detail ? { detail: parsed.message.detail } : {}),
      });
      return;
    }

    this.sendProtocolError(
      ws,
      "unsupported_action",
      "Audience voting and judge submission are not enabled in this release",
    );
  }

  webSocketClose(): void {
    // Hibernation-safe connections are discovered from attachments; no memory cleanup is required.
  }

  private async handleHello(ws: WebSocket, hello: ClientHello): Promise<void> {
    const role = await authenticateSocketRole(
      this.env,
      this.ctx.storage.sql,
      PRIMARY_SHOW_ID,
      hello,
    );
    if (!role) {
      this.sendProtocolError(
        ws,
        "unauthorised",
        "Role credential was not accepted",
      );
      ws.close(1008, "Unauthorised");
      return;
    }

    ws.serializeAttachment({
      phase: "ready",
      role,
      protocolVersion: PROTOCOL_VERSION,
    } satisfies ReadyAttachment);
    this.sendSnapshot(ws, role);
  }

  private handleAdminCommand(
    ws: WebSocket,
    role: ConnectionRole,
    command: AdminCommand,
  ): void {
    const execution = executeAdminCommand(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      role,
      command,
    );
    this.sendOne(ws, {
      type: "command_ack",
      protocolVersion: PROTOCOL_VERSION,
      revision: execution.acknowledgement.revision,
      acknowledgement: execution.acknowledgement,
    });
    if (execution.acknowledgement.status === "accepted") {
      this.broadcastChanges(execution.changes, command);
    }
  }

  private broadcastChanges(
    changes: readonly StateChange[],
    command: AdminCommand,
  ): void {
    const audience = projectShowState(this.ctx.storage, PRIMARY_SHOW_ID, {
      kind: "audience",
    });
    if (!audience || audience.role !== "audience") {
      return;
    }
    const revision = audience.show.revision;

    if (changes.includes("act")) {
      const message: ServerMessage = {
        type: "state_patch",
        protocolVersion: PROTOCOL_VERSION,
        revision,
        patches: [
          {
            kind: "active_act",
            activeActId: audience.show.activeActId,
            activeAct: audience.activeAct,
          },
        ],
      };
      this.broadcastAdmin(message);
      this.broadcastProjector(message);
      this.broadcastAudience(message);
      this.broadcastJudges(message);
    }

    const projector = projectShowState(this.ctx.storage, PRIMARY_SHOW_ID, {
      kind: "projector",
    });
    if (projector && projector.role === "projector") {
      if (changes.includes("display")) {
        const message: ServerMessage = {
          type: "state_patch",
          protocolVersion: PROTOCOL_VERSION,
          revision,
          patches: [
            {
              kind: "display",
              displayMode: projector.show.displayMode,
              blackScreen: projector.runtime.blackScreen,
            },
          ],
        };
        this.broadcastAdmin(message);
        this.broadcastProjector(message);
      }
      if (changes.includes("media")) {
        const mediaPatch: ServerMessage = {
          type: "state_patch",
          protocolVersion: PROTOCOL_VERSION,
          revision,
          patches: [
            {
              kind: "media",
              preparedCueId: projector.runtime.preparedCueId,
              activeVisualCueId: projector.runtime.activeVisualCueId,
              activeAudioCueId: projector.runtime.activeAudioCueId,
              visualTransport: projector.runtime.visualTransport,
              audioTransport: projector.runtime.audioTransport,
              blackScreen: projector.runtime.blackScreen,
            },
          ],
        };
        this.broadcastAdmin(mediaPatch);
        this.broadcastProjector(mediaPatch);
        const action = this.mediaAction(command);
        if (action) {
          this.broadcastProjector({
            type: "media_command",
            protocolVersion: PROTOCOL_VERSION,
            revision,
            commandId: command.commandId,
            action,
            cueId: projector.runtime.preparedCueId,
          });
        }
      }
    }

    if (changes.includes("audience_voting")) {
      const message: ServerMessage = {
        type: "voting_state_update",
        protocolVersion: PROTOCOL_VERSION,
        revision,
        state: audience.show.audienceVoteState,
      };
      this.broadcastAdmin(message);
      this.broadcastAudience(message);
    }
    if (changes.includes("result_reveal")) {
      const message: ServerMessage = {
        type: "result_reveal",
        protocolVersion: PROTOCOL_VERSION,
        revision,
        state: this.currentResultRevealState(),
      };
      this.broadcastAdmin(message);
      this.broadcastProjector(message);
      this.broadcastAudience(message);
      this.broadcastJudges(message);
    }
    if (changes.includes("judge_permission")) {
      this.broadcastJudgePermissionUpdates(revision);
    }
  }

  private mediaAction(
    command: AdminCommand,
  ): "prepare" | "play" | "pause" | "stop" | "replay" | "black" | null {
    switch (command.type) {
      case "PREPARE_CUE":
        return "prepare";
      case "PLAY_CUE":
        return "play";
      case "PAUSE_MEDIA":
        return "pause";
      case "STOP_MEDIA":
        return "stop";
      case "REPLAY_MEDIA":
        return "replay";
      case "BLACK_SCREEN":
        return "black";
      default:
        return null;
    }
  }

  private broadcastJudgePermissionUpdates(
    revision: ReturnType<typeof showRevision>,
  ): void {
    const judgesSent = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (
        !attachment ||
        attachment.phase !== "ready" ||
        attachment.role.kind !== "judge"
      ) {
        continue;
      }
      if (judgesSent.has(attachment.role.judgeId)) {
        continue;
      }
      judgesSent.add(attachment.role.judgeId);
      const projection = projectShowState(
        this.ctx.storage,
        PRIMARY_SHOW_ID,
        attachment.role,
      );
      if (projection && projection.role === "judge") {
        this.sendJudge(attachment.role.judgeId, {
          type: "judge_permission_update",
          protocolVersion: PROTOCOL_VERSION,
          revision,
          state: projection.permission,
        });
      }
    }
  }

  private sendSnapshot(ws: WebSocket, role: ConnectionRole): void {
    const projection = projectShowState(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      role,
    );
    if (!projection) {
      this.sendProtocolError(ws, "unauthorised", "Show or role is unavailable");
      return;
    }
    this.sendOne(ws, {
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      revision: projection.show.revision,
      projection,
    });
  }

  private currentRevision(): ReturnType<typeof showRevision> {
    const row = this.ctx.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM shows WHERE id = ?",
        PRIMARY_SHOW_ID,
      )
      .toArray()[0];
    return showRevision(row?.revision ?? 0);
  }

  private currentResultRevealState(): "HIDDEN" | "REVEALED" {
    const row = this.ctx.storage.sql
      .exec<{ result_reveal_state: string }>(
        "SELECT result_reveal_state FROM shows WHERE id = ?",
        PRIMARY_SHOW_ID,
      )
      .toArray()[0];
    return row?.result_reveal_state === "REVEALED" ? "REVEALED" : "HIDDEN";
  }

  private socketAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment: unknown = ws.deserializeAttachment();
    return isSocketAttachment(attachment) ? attachment : null;
  }

  private sendProtocolError(
    ws: WebSocket,
    code:
      | "invalid_message"
      | "unauthorised"
      | "incompatible_protocol"
      | "unsupported_action",
    detail: string,
  ): void {
    this.sendOne(ws, {
      type: "protocol_error",
      protocolVersion: PROTOCOL_VERSION,
      revision: this.currentRevision(),
      code,
      detail,
    });
  }

  private sendOne(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(serialiseServerMessage(message));
    } catch {
      ws.close(1011, "Unable to deliver message");
    }
  }

  private broadcastAdmin(message: ServerMessage): void {
    this.broadcastRole("admin", message);
  }

  private broadcastProjector(message: ServerMessage): void {
    this.broadcastRole("projector", message);
  }

  private broadcastAudience(message: ServerMessage): void {
    this.broadcastRole("audience", message);
  }

  private broadcastJudges(message: ServerMessage): void {
    this.broadcastRole("judge", message);
  }

  private sendJudge(judgeIdentifier: JudgeId, message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (
        attachment?.phase === "ready" &&
        attachment.role.kind === "judge" &&
        attachment.role.judgeId === judgeIdentifier
      ) {
        this.sendOne(ws, message);
      }
    }
  }

  private broadcastRole(
    targetRole: ConnectionRole["kind"],
    message: ServerMessage,
  ): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (
        attachment?.phase === "ready" &&
        attachment.role.kind === targetRole
      ) {
        this.sendOne(ws, message);
      }
    }
  }
}

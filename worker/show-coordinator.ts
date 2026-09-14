import { DurableObject } from "cloudflare:workers";

import type { AdminCommand } from "../shared/admin-command";
import {
  PROTOCOL_VERSION,
  showRevision,
  type AudienceAggregate,
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
import {
  configuredAdminSecret,
  createAdminSession,
  destroyAdminSession,
  isAdminSessionHashActive,
  readAdminSession,
} from "./admin-auth";
import {
  hasAudienceVote,
  parseAudienceVoteRequest,
  resolveVoterIdentity,
  submitAudienceVote,
} from "./audience-votes";
import {
  createJudges,
  listJudges,
  revokeJudge,
  rotateJudgeToken,
} from "./judge-lifecycle";
import { hasSameOrigin } from "./security";
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
  adminSessionHash: ArrayBuffer | null;
}

interface ReadyAttachment {
  phase: "ready";
  role: ConnectionRole;
  protocolVersion: typeof PROTOCOL_VERSION;
  adminSessionHash: ArrayBuffer | null;
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
    return (
      value.adminSessionHash === null ||
      value.adminSessionHash instanceof ArrayBuffer
    );
  }
  if (
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isRecord(value.role) ||
    typeof value.role.kind !== "string"
  ) {
    return false;
  }
  if (value.role.kind === "judge") {
    return (
      typeof value.role.judgeId === "string" &&
      (value.adminSessionHash === null ||
        value.adminSessionHash instanceof ArrayBuffer)
    );
  }
  return (
    (value.adminSessionHash === null ||
      value.adminSessionHash instanceof ArrayBuffer) &&
    (value.role.kind === "admin" ||
      value.role.kind === "projector" ||
      value.role.kind === "audience")
  );
}

export class ShowCoordinator extends DurableObject<Env> {
  private aggregateFlushTimer: number | null = null;
  private readonly pendingAggregateUpdates = new Map<
    string,
    Extract<ServerMessage, { type: "aggregate_update" }>
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initialiseSchema(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
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
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      return this.handleAdminLogin(request);
    }
    if (url.pathname === "/api/admin/session" && request.method === "GET") {
      return this.handleAdminSession(request);
    }
    if (url.pathname === "/api/admin/logout" && request.method === "POST") {
      return this.handleAdminLogout(request);
    }
    if (url.pathname === "/api/admin/command" && request.method === "POST") {
      return this.handleAdminHttpCommand(request);
    }
    if (url.pathname === "/api/admin/judges" && request.method === "GET") {
      return this.handleListJudges(request);
    }
    if (
      url.pathname === "/api/admin/judges/initialize" &&
      request.method === "POST"
    ) {
      return this.handleCreateJudges(request);
    }
    const judgeActionMatch =
      /^\/api\/admin\/judges\/([A-Za-z0-9_-]{1,128})\/(rotate|revoke)$/u.exec(
        url.pathname,
      );
    if (judgeActionMatch && request.method === "POST") {
      const judgeId = judgeActionMatch[1] ?? "";
      return judgeActionMatch[2] === "rotate"
        ? this.handleRotateJudge(request, judgeId)
        : this.handleRevokeJudge(request, judgeId);
    }
    if (url.pathname === "/api/vote/status" && request.method === "GET") {
      return this.handleVoteStatus(request, url);
    }
    if (url.pathname === "/api/vote" && request.method === "POST") {
      return this.handleAudienceVote(request);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async authenticatedAdmin(
    request: Request,
    mutation: boolean,
  ): Promise<ArrayBuffer | null> {
    if (mutation && !hasSameOrigin(request)) {
      return null;
    }
    const session = hasSameOrigin(request)
      ? await readAdminSession(this.ctx.storage.sql, request)
      : null;
    return session?.tokenHash ?? null;
  }

  private async handleAdminLogin(request: Request): Promise<Response> {
    const secret = configuredAdminSecret(this.env);
    if (!secret) {
      return Response.json({ authenticated: false }, { status: 503 });
    }
    const result = await createAdminSession(this.ctx.storage, request, secret);
    return Response.json(
      { authenticated: result.ok },
      {
        status: result.status,
        ...(result.setCookie
          ? { headers: { "Set-Cookie": result.setCookie } }
          : {}),
      },
    );
  }

  private async handleAdminSession(request: Request): Promise<Response> {
    const session = await this.authenticatedAdmin(request, false);
    return Response.json({ authenticated: session !== null });
  }

  private async handleAdminLogout(request: Request): Promise<Response> {
    if (!hasSameOrigin(request)) {
      return Response.json({ authenticated: false }, { status: 403 });
    }
    const cookie = await destroyAdminSession(this.ctx.storage, request);
    return Response.json(
      { authenticated: false },
      { headers: { "Set-Cookie": cookie } },
    );
  }

  private async handleAdminHttpCommand(request: Request): Promise<Response> {
    const session = await this.authenticatedAdmin(request, true);
    if (!session) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    let command: unknown;
    try {
      command = await request.json();
    } catch {
      return Response.json({ error: "Invalid command" }, { status: 400 });
    }
    const execution = executeAdminCommand(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      { kind: "admin" },
      command,
    );
    if (execution.acknowledgement.status === "accepted") {
      const parsed = parseClientMessage(
        JSON.stringify({
          type: "admin_command",
          protocolVersion: PROTOCOL_VERSION,
          command,
        }),
      );
      if (parsed.ok && parsed.message.type === "admin_command") {
        this.broadcastChanges(execution.changes, parsed.message.command);
      }
    }
    return Response.json(execution.acknowledgement);
  }

  private async handleListJudges(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, false))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    return Response.json({
      judges: listJudges(this.ctx.storage.sql, PRIMARY_SHOW_ID),
    });
  }

  private async handleCreateJudges(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    const labels =
      isRecord(body) &&
      Array.isArray(body.labels) &&
      body.labels.every((label) => typeof label === "string")
        ? body.labels
        : null;
    if (!labels) {
      return Response.json({ error: "Bad request" }, { status: 400 });
    }
    const issued = await createJudges(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      labels,
    );
    if (!issued) {
      return Response.json(
        { error: "Unable to create judges" },
        { status: 409 },
      );
    }
    const origin = new URL(request.url).origin;
    return Response.json({
      judges: issued.map((judge) => ({
        judgeId: judge.judgeId,
        slot: judge.slot,
        displayName: judge.displayName,
        link: `${origin}/judge/${judge.token}`,
      })),
    });
  }

  private async handleRotateJudge(
    request: Request,
    requestedJudgeId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    const issued = await rotateJudgeToken(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      requestedJudgeId,
    );
    if (!issued) {
      return Response.json({ error: "Judge not found" }, { status: 404 });
    }
    return Response.json({
      judgeId: issued.judgeId,
      slot: issued.slot,
      displayName: issued.displayName,
      link: `${new URL(request.url).origin}/judge/${issued.token}`,
    });
  }

  private async handleRevokeJudge(
    request: Request,
    requestedJudgeId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    if (!revokeJudge(this.ctx.storage, PRIMARY_SHOW_ID, requestedJudgeId)) {
      return Response.json(
        { error: "Active judge not found" },
        { status: 404 },
      );
    }
    return Response.json({ judgeId: requestedJudgeId, active: false });
  }

  private async handleVoteStatus(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const actIdentifier = url.searchParams.get("actId");
    if (!actIdentifier || !/^[A-Za-z0-9_-]{1,128}$/u.test(actIdentifier)) {
      return Response.json({ locked: false }, { status: 400 });
    }
    const identity = await resolveVoterIdentity(request);
    const response = Response.json({
      locked: hasAudienceVote(
        this.ctx.storage.sql,
        PRIMARY_SHOW_ID,
        actIdentifier,
        identity.hash,
      ),
    });
    if (identity.setCookie) {
      response.headers.set("Set-Cookie", identity.setCookie);
    }
    return response;
  }

  private async handleAudienceVote(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
    }
    const parsed = parseAudienceVoteRequest(body);
    if (!parsed.ok) {
      return Response.json({ code: parsed.code }, { status: 400 });
    }
    const identity = await resolveVoterIdentity(request);
    const outcome = submitAudienceVote(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      identity.hash,
      parsed,
    );
    const response = Response.json(
      outcome.ok ? { accepted: true, locked: true } : { code: outcome.code },
      {
        status: outcome.ok
          ? 200
          : outcome.code === "INVALID_SCORE" || outcome.code === "BAD_REQUEST"
            ? 400
            : 409,
      },
    );
    if (identity.setCookie) {
      response.headers.set("Set-Cookie", identity.setCookie);
    }
    if (outcome.ok) {
      this.queueAggregateUpdate(outcome.revision, outcome.aggregate);
    }
    return response;
  }

  private queueAggregateUpdate(
    revision: ReturnType<typeof showRevision>,
    aggregate: AudienceAggregate,
  ): void {
    this.pendingAggregateUpdates.set(aggregate.actId, {
      type: "aggregate_update",
      protocolVersion: PROTOCOL_VERSION,
      revision,
      aggregate,
    });
    if (this.aggregateFlushTimer !== null) {
      return;
    }
    this.aggregateFlushTimer = setTimeout(() => {
      this.aggregateFlushTimer = null;
      for (const update of this.pendingAggregateUpdates.values()) {
        this.broadcastAdmin(update);
        this.broadcastProjector(update);
      }
      this.pendingAggregateUpdates.clear();
    }, 250);
  }

  private async upgradeWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "WebSocket upgrade required" },
        { status: 426 },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const session = hasSameOrigin(request)
      ? await readAdminSession(this.ctx.storage.sql, request)
      : null;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      phase: "awaiting_hello",
      adminSessionHash: session?.tokenHash ?? null,
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
      await this.handleHello(ws, parsed.message, attachment);
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
      if (
        attachment.role.kind !== "admin" ||
        !attachment.adminSessionHash ||
        !isAdminSessionHashActive(
          this.ctx.storage.sql,
          attachment.adminSessionHash,
        )
      ) {
        this.sendProtocolError(ws, "unauthorised", "Admin session expired");
        return;
      }
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

  private async handleHello(
    ws: WebSocket,
    hello: ClientHello,
    attachment: AwaitingHelloAttachment,
  ): Promise<void> {
    const role = await authenticateSocketRole(
      this.env,
      this.ctx.storage.sql,
      PRIMARY_SHOW_ID,
      hello,
      attachment.adminSessionHash,
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
      adminSessionHash: attachment.adminSessionHash,
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

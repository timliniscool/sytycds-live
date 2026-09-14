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
  audienceVoteScore,
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
import { submitJudgeScore } from "./judge-submissions";
import {
  createAct,
  deleteAct,
  editAct,
  parseActInput,
  replaceActOrder,
} from "./acts";
import {
  createCue,
  deleteCue,
  duplicateCue,
  editCue,
  parseCueInput,
  replaceCueOrder,
} from "./cues";
import {
  deleteMediaAsset,
  listMediaAssets,
  serveMediaAsset,
  uploadMediaAsset,
} from "./media-assets";
import { listAuditEvents, recordAuditEvent } from "./audit";
import { preflightAssetRequests, runServerPreflight } from "./preflight";
import { configuredPublicOrigin } from "./public-origin";
import { hasSameOrigin } from "./security";
import { initialiseSchema, readSchemaVersion } from "./schema";
import { parseShowInput, upsertShow } from "./show-config";
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
  private connectionCountTimer: number | null = null;
  /** Last projector media error seen, so the log records changes, not repeats. */
  private lastProjectorError: string | null = null;
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
    if (url.pathname === "/api/admin/preflight" && request.method === "GET") {
      return this.handlePreflight(request, url);
    }
    if (url.pathname === "/api/admin/history" && request.method === "GET") {
      return this.handleHistory(request, url);
    }
    if (url.pathname === "/api/admin/show" && request.method === "PUT") {
      return this.handleUpsertShow(request);
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
    if (url.pathname === "/api/admin/acts" && request.method === "POST")
      return this.handleCreateAct(request);
    if (url.pathname === "/api/admin/acts/reorder" && request.method === "POST")
      return this.handleReorderActs(request);
    const actMatch = /^\/api\/admin\/acts\/([A-Za-z0-9_-]{1,128})$/u.exec(
      url.pathname,
    );
    if (actMatch && request.method === "PATCH")
      return this.handleEditAct(request, actMatch[1] ?? "");
    if (actMatch && request.method === "DELETE")
      return this.handleDeleteAct(request, actMatch[1] ?? "");
    if (url.pathname === "/api/admin/cues" && request.method === "POST")
      return this.handleCreateCue(request);
    if (url.pathname === "/api/admin/cues/reorder" && request.method === "POST")
      return this.handleReorderCues(request);
    const cueMatch =
      /^\/api\/admin\/cues\/([A-Za-z0-9_-]{1,128})(?:\/(duplicate))?$/u.exec(
        url.pathname,
      );
    if (cueMatch && cueMatch[2] === "duplicate" && request.method === "POST")
      return this.handleDuplicateCue(request, cueMatch[1] ?? "");
    if (cueMatch && !cueMatch[2] && request.method === "PATCH")
      return this.handleEditCue(request, cueMatch[1] ?? "");
    if (cueMatch && !cueMatch[2] && request.method === "DELETE")
      return this.handleDeleteCue(request, cueMatch[1] ?? "");
    if (url.pathname === "/api/admin/media" && request.method === "GET")
      return this.handleListMedia(request);
    if (url.pathname === "/api/admin/media" && request.method === "POST")
      return this.handleUploadMedia(request, url);
    const mediaMatch =
      /^\/api\/(?:admin\/)?media\/([A-Za-z0-9_-]{1,128})$/u.exec(url.pathname);
    if (mediaMatch && request.method === "GET")
      return serveMediaAsset(
        this.ctx.storage.sql,
        this.env.MEDIA,
        PRIMARY_SHOW_ID,
        mediaMatch[1] ?? "",
        request,
      );
    if (
      mediaMatch &&
      url.pathname.startsWith("/api/admin/") &&
      request.method === "DELETE"
    )
      return this.handleDeleteMedia(request, mediaMatch[1] ?? "");
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
    const result = await createAdminSession(
      this.ctx.storage,
      request,
      secret,
      PRIMARY_SHOW_ID,
    );
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

  /** Role projections always carry the deployment's canonical public origin. */
  private project(role: ConnectionRole) {
    return projectShowState(this.ctx.storage, PRIMARY_SHOW_ID, role, {
      publicOrigin: configuredPublicOrigin(this.env),
    });
  }

  private socketInventory() {
    let projectors = 0;
    const projectorProtocolVersions: number[] = [];
    const connectedJudgeIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (attachment?.phase !== "ready") continue;
      if (attachment.role.kind === "projector") {
        projectors += 1;
        projectorProtocolVersions.push(attachment.protocolVersion);
      }
      if (attachment.role.kind === "judge")
        connectedJudgeIds.add(attachment.role.judgeId);
    }
    return { projectors, projectorProtocolVersions, connectedJudgeIds };
  }

  private async handlePreflight(request: Request, url: URL): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, false))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    const only = url.searchParams.get("only");
    const items = await runServerPreflight({
      sql: this.ctx.storage.sql,
      bucket: this.env.MEDIA,
      env: this.env,
      showIdentifier: PRIMARY_SHOW_ID,
      sockets: this.socketInventory(),
      only: only && /^[a-z_]{1,40}$/u.test(only) ? only : undefined,
    });
    return Response.json({ items });
  }

  /** Provisioning: the first call creates the show, later calls rename it. */
  private async handleUpsertShow(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    const input = parseShowInput(await this.adminBody(request));
    if (!input) {
      return Response.json(
        { error: "A title of up to 120 characters is required" },
        { status: 400 },
      );
    }
    const result = upsertShow(this.ctx.storage, PRIMARY_SHOW_ID, input);
    recordAuditEvent(this.ctx.storage.sql, PRIMARY_SHOW_ID, {
      type: result.created ? "show.created" : "show.renamed",
      actor: "admin",
      data: { title: input.title },
    });
    // Every role's projection changes shape when the show appears or is
    // renamed, including sockets that were told the show was unavailable.
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    this.broadcastSnapshots("audience");
    this.broadcastSnapshots("judge");
    return Response.json(result, { status: result.created ? 201 : 200 });
  }

  private async handleHistory(request: Request, url: URL): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, false))) {
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    }
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return Response.json(
      listAuditEvents(
        this.ctx.storage.sql,
        PRIMARY_SHOW_ID,
        Number.isSafeInteger(before) && before > 0 ? before : null,
        Number.isSafeInteger(limit) ? limit : 50,
      ),
    );
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

  /**
   * Also the audience onboarding call: a first visit with no act yet still
   * establishes the anonymous voter cookie, so the identity exists before the
   * first vote is ever attempted.
   */
  private async handleVoteStatus(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const actIdentifier = url.searchParams.get("actId");
    if (actIdentifier && !/^[A-Za-z0-9_-]{1,128}$/u.test(actIdentifier)) {
      return Response.json({ locked: false }, { status: 400 });
    }
    const identity = await resolveVoterIdentity(request);
    const score = actIdentifier
      ? audienceVoteScore(
          this.ctx.storage.sql,
          PRIMARY_SHOW_ID,
          actIdentifier,
          identity.hash,
        )
      : null;
    const response = Response.json({ locked: score !== null, score });
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
      outcome.ok
        ? { accepted: true, locked: true, score: parsed.score }
        : { code: outcome.code },
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

  private async adminBody(request: Request): Promise<unknown | null> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  private async handleCreateAct(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const input = parseActInput(await this.adminBody(request));
    if (!input)
      return Response.json({ error: "Invalid act fields" }, { status: 400 });
    const act = createAct(this.ctx.storage, PRIMARY_SHOW_ID, input);
    if (!act)
      return Response.json({ error: "Show unavailable" }, { status: 409 });
    this.broadcastSnapshots("admin");
    return Response.json({ act }, { status: 201 });
  }

  private async handleEditAct(
    request: Request,
    requestedId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const input = parseActInput(await this.adminBody(request));
    if (!input)
      return Response.json({ error: "Invalid act fields" }, { status: 400 });
    if (!editAct(this.ctx.storage, PRIMARY_SHOW_ID, requestedId, input))
      return Response.json({ error: "Act not found" }, { status: 404 });
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    this.broadcastSnapshots("audience");
    this.broadcastSnapshots("judge");
    return Response.json({ updated: true });
  }

  private async handleDeleteAct(
    request: Request,
    requestedId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const result = deleteAct(this.ctx.storage, PRIMARY_SHOW_ID, requestedId);
    if (result !== "deleted")
      return Response.json(
        { error: result },
        { status: result === "not_found" ? 404 : 409 },
      );
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    this.broadcastSnapshots("audience");
    this.broadcastSnapshots("judge");
    return Response.json({ deleted: true });
  }

  private async handleReorderActs(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const body = await this.adminBody(request);
    const ids =
      isRecord(body) &&
      Array.isArray(body.ids) &&
      body.ids.every((id) => typeof id === "string")
        ? body.ids
        : null;
    if (!ids || !replaceActOrder(this.ctx.storage, PRIMARY_SHOW_ID, ids))
      return Response.json(
        { error: "Invalid complete order" },
        { status: 400 },
      );
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    this.broadcastSnapshots("audience");
    this.broadcastSnapshots("judge");
    return Response.json({ reordered: true });
  }

  private async handleCreateCue(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const body = await this.adminBody(request);
    const input = parseCueInput(body);
    const actIdentifier =
      isRecord(body) && typeof body.actId === "string" ? body.actId : null;
    if (!input || !actIdentifier)
      return Response.json({ error: "Invalid cue" }, { status: 400 });
    const id = createCue(
      this.ctx.storage,
      PRIMARY_SHOW_ID,
      actIdentifier,
      input,
    );
    if (!id)
      return Response.json(
        { error: "Act or asset not found" },
        { status: 409 },
      );
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    return Response.json({ cueId: id }, { status: 201 });
  }

  private async handleEditCue(
    request: Request,
    requestedId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const input = parseCueInput(await this.adminBody(request));
    if (
      !input ||
      !editCue(this.ctx.storage, PRIMARY_SHOW_ID, requestedId, input)
    )
      return Response.json(
        { error: "Cue or asset not found" },
        { status: 404 },
      );
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    return Response.json({ updated: true });
  }

  private async handleDuplicateCue(
    request: Request,
    requestedId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const id = duplicateCue(this.ctx.storage, PRIMARY_SHOW_ID, requestedId);
    if (!id) return Response.json({ error: "Cue not found" }, { status: 404 });
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    return Response.json({ cueId: id }, { status: 201 });
  }

  private async handleDeleteCue(
    request: Request,
    requestedId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    if (!deleteCue(this.ctx.storage, PRIMARY_SHOW_ID, requestedId))
      return Response.json({ error: "Cue not found" }, { status: 404 });
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    return Response.json({ deleted: true });
  }

  private async handleReorderCues(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const body = await this.adminBody(request);
    const actIdentifier =
      isRecord(body) && typeof body.actId === "string" ? body.actId : null;
    const ids =
      isRecord(body) &&
      Array.isArray(body.ids) &&
      body.ids.every((id) => typeof id === "string")
        ? body.ids
        : null;
    if (
      !actIdentifier ||
      !ids ||
      !replaceCueOrder(this.ctx.storage, PRIMARY_SHOW_ID, actIdentifier, ids)
    )
      return Response.json(
        { error: "Invalid complete order" },
        { status: 400 },
      );
    this.broadcastSnapshots("admin");
    this.broadcastSnapshots("projector");
    return Response.json({ reordered: true });
  }

  private async handleListMedia(request: Request): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, false)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    return Response.json({
      assets: listMediaAssets(this.ctx.storage.sql, PRIMARY_SHOW_ID),
    });
  }

  private async handleUploadMedia(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const result = await uploadMediaAsset(
      this.ctx.storage,
      this.env.MEDIA,
      PRIMARY_SHOW_ID,
      request,
      url.searchParams.get("filename"),
    );
    return result.ok
      ? Response.json({ asset: result.asset }, { status: 201 })
      : Response.json({ error: result.error }, { status: result.status });
  }

  private async handleDeleteMedia(
    request: Request,
    assetId: string,
  ): Promise<Response> {
    if (!(await this.authenticatedAdmin(request, true)))
      return Response.json({ error: "Unauthorised" }, { status: 401 });
    const result = await deleteMediaAsset(
      this.ctx.storage,
      this.env.MEDIA,
      PRIMARY_SHOW_ID,
      assetId,
    );
    return result === "deleted"
      ? Response.json({ deleted: true })
      : Response.json(
          { error: result },
          { status: result === "not_found" ? 404 : 409 },
        );
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
      recordAuditEvent(this.ctx.storage.sql, PRIMARY_SHOW_ID, {
        type: parsed.message.succeeded ? "cue.executed" : "cue.failed",
        actor: "projector",
        commandId: parsed.message.commandId,
        data: { detail: parsed.message.detail?.slice(0, 120) ?? null },
      });
      return;
    }

    if (parsed.message.type === "preflight_request") {
      if (attachment.role.kind !== "admin") {
        this.sendProtocolError(
          ws,
          "unauthorised",
          "Only the operator may request preflight",
        );
        return;
      }
      // Relayed, never persisted: the projector probes its own media pipeline
      // and answers to admin through the coordinator.
      this.broadcastProjector({
        type: "preflight_request",
        protocolVersion: PROTOCOL_VERSION,
        revision: this.currentRevision(),
        requestId: parsed.message.requestId,
        assets: preflightAssetRequests(this.ctx.storage.sql, PRIMARY_SHOW_ID),
      });
      return;
    }

    if (parsed.message.type === "projector_preflight") {
      if (attachment.role.kind !== "projector") {
        this.sendProtocolError(
          ws,
          "unauthorised",
          "Only a projector may report preflight",
        );
        return;
      }
      this.broadcastAdmin({
        type: "projector_preflight_report",
        protocolVersion: PROTOCOL_VERSION,
        revision: this.currentRevision(),
        requestId: parsed.message.requestId,
        report: parsed.message.report,
      });
      return;
    }

    if (parsed.message.type === "projector_status") {
      if (attachment.role.kind !== "projector") {
        this.sendProtocolError(
          ws,
          "unauthorised",
          "Only a projector may report playback telemetry",
        );
        return;
      }
      // Telemetry is ephemeral operator assistance: it is relayed to admin and
      // never written to SQLite, so hibernation simply drops it. Only a newly
      // appearing media error earns a line in the operational log.
      this.broadcastAdmin({
        type: "projector_telemetry",
        protocolVersion: PROTOCOL_VERSION,
        revision: this.currentRevision(),
        status: parsed.message.status,
      });
      const error = parsed.message.status.error;
      if (error && error !== this.lastProjectorError) {
        recordAuditEvent(this.ctx.storage.sql, PRIMARY_SHOW_ID, {
          type: "media.error",
          actor: "projector",
          data: { detail: error.slice(0, 120) },
        });
      }
      this.lastProjectorError = error;
      return;
    }

    if (parsed.message.type === "judge_submit") {
      if (attachment.role.kind !== "judge") {
        this.sendProtocolError(
          ws,
          "unauthorised",
          "Only a judge may submit a score",
        );
        return;
      }
      const outcome = submitJudgeScore(
        this.ctx.storage,
        PRIMARY_SHOW_ID,
        attachment.role.judgeId,
        parsed.message.input.raw,
      );
      this.sendOne(ws, {
        type: "judge_submission_update",
        protocolVersion: PROTOCOL_VERSION,
        revision: outcome.revision,
        accepted: outcome.ok && outcome.accepted,
        locked: outcome.ok,
        ...(!outcome.ok &&
        outcome.code !== "UNAUTHORISED" &&
        outcome.code !== "NO_CURRENT_ACT"
          ? { reason: outcome.code }
          : {}),
      });
      if (outcome.ok) {
        this.sendSnapshot(ws, attachment.role);
        if (outcome.accepted) {
          // The scoreboard must be current the moment the operator switches
          // to it, so the projector learns of every submission, not only those
          // that arrive while it is already showing scores.
          this.broadcastSnapshots("admin");
          this.broadcastSnapshots("projector");
        }
      }
      return;
    }

    // Audience votes travel over HTTP because the anonymous voter identity is an
    // HttpOnly cookie that a WebSocket frame cannot carry.
    this.sendProtocolError(
      ws,
      "unsupported_action",
      "This message is not accepted on the show socket",
    );
  }

  webSocketClose(): void {
    // Hibernation-safe connections are discovered from attachments; no memory cleanup is required.
    this.broadcastConnectionCount();
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
    this.broadcastConnectionCount();
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
    const audience = this.project({ kind: "audience" });
    if (!audience || audience.role !== "audience") {
      return;
    }
    const revision = audience.show.revision;

    if (changes.includes("acts")) {
      // The act list itself changed shape; every role re-derives from it.
      this.broadcastSnapshots("admin");
      this.broadcastSnapshots("projector");
      this.broadcastSnapshots("audience");
      this.broadcastSnapshots("judge");
    }

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

    const projector = this.project({ kind: "projector" });
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
              intermissionMessage: projector.show.intermissionMessage,
              emergencyMessage: projector.show.emergencyMessage,
              emergencyPresentation: projector.runtime.emergencyPresentation,
            },
          ],
        };
        this.broadcastAdmin(message);
        this.broadcastProjector(message);
        // Phones mirror the public display for intermission, hold and
        // emergency, so they need the same patch.
        this.broadcastAudience(message);
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
            executionId: command.commandId,
            commandId: command.commandId,
            action,
            cueId: projector.runtime.preparedCueId,
            ...(command.type === "SEEK_MEDIA"
              ? { positionMs: command.positionMs }
              : {}),
            ...(action === "black"
              ? { blackScreen: projector.runtime.blackScreen }
              : {}),
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
      const state = this.currentResultRevealState();
      const publicMessage: ServerMessage = {
        type: "result_reveal",
        protocolVersion: PROTOCOL_VERSION,
        revision,
        state,
        // Both public projections withhold the number until revealed.
        revealedResult: audience.revealedResult,
      };
      this.broadcastAdmin({
        type: "result_reveal",
        protocolVersion: PROTOCOL_VERSION,
        revision,
        state,
        revealedResult: null,
      });
      this.broadcastProjector(publicMessage);
      this.broadcastAudience(publicMessage);
      this.broadcastJudges(publicMessage);
      // Finalising changes the operator's result map and ranking preview.
      if (command.type === "FINALISE_RESULT") this.broadcastSnapshots("admin");
    }
    if (changes.includes("results")) {
      const message: ServerMessage = {
        type: "public_results",
        protocolVersion: PROTOCOL_VERSION,
        revision,
        results: audience.publicResults,
      };
      this.broadcastProjector(message);
      this.broadcastAudience(message);
      if (!changes.includes("acts")) this.broadcastSnapshots("admin");
    }
    if (changes.includes("judge_permission")) {
      this.broadcastJudgePermissionUpdates(revision);
    }
  }

  private mediaAction(
    command: AdminCommand,
  ):
    | "prepare"
    | "play"
    | "pause"
    | "resume"
    | "stop"
    | "stop_all"
    | "restart"
    | "replay"
    | "seek"
    | "next"
    | "previous"
    | "black"
    | null {
    switch (command.type) {
      case "PREPARE_CUE":
        return "prepare";
      case "PLAY_CUE":
        return "play";
      case "PAUSE_MEDIA":
        return "pause";
      case "RESUME_MEDIA":
        return "resume";
      case "STOP_MEDIA":
        return "stop";
      case "STOP_ALL_MEDIA":
        return "stop_all";
      case "RESTART_MEDIA":
        return "restart";
      case "REPLAY_MEDIA":
        return "replay";
      case "SEEK_MEDIA":
        return "seek";
      case "NEXT_CUE":
        return "next";
      case "PREVIOUS_CUE":
        return "previous";
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
      const projection = this.project(attachment.role);
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
    const projection = this.project(role);
    if (!projection) {
      // A missing show is a provisioning state, not a refused credential;
      // the console turns it into the "create the show" step.
      this.sendProtocolError(
        ws,
        this.showExists() ? "unauthorised" : "show_unavailable",
        this.showExists() ? "Role is unavailable" : "No show has been created",
      );
      return;
    }
    this.sendOne(ws, {
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      revision: projection.show.revision,
      projection,
    });
  }

  private broadcastSnapshots(targetRole: ConnectionRole["kind"]): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (
        attachment?.phase === "ready" &&
        attachment.role.kind === targetRole
      ) {
        this.sendSnapshot(ws, attachment.role);
      }
    }
  }

  /**
   * Counting connections walks every socket, so a reconnect storm of a few
   * hundred phones must not do that once per close. Coalesced like aggregates.
   */
  private broadcastConnectionCount(): void {
    if (this.connectionCountTimer !== null) return;
    this.connectionCountTimer = setTimeout(() => {
      this.connectionCountTimer = null;
      this.sendConnectionCount();
    }, 250);
  }

  private sendConnectionCount(): void {
    let audience = 0;
    const judgeIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (attachment?.phase === "ready" && attachment.role.kind === "audience")
        audience += 1;
      if (attachment?.phase === "ready" && attachment.role.kind === "judge")
        judgeIds.add(attachment.role.judgeId);
    }
    this.broadcastAdmin({
      type: "connection_count",
      protocolVersion: PROTOCOL_VERSION,
      revision: this.currentRevision(),
      audience,
      judgeIds: [...judgeIds],
    });
  }

  private showExists(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM shows WHERE id = ?",
          PRIMARY_SHOW_ID,
        )
        .toArray().length > 0
    );
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
    code: Extract<ServerMessage, { type: "protocol_error" }>["code"],
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
    this.sendRaw(ws, serialiseServerMessage(message));
  }

  private sendRaw(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
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
    const payload = serialiseServerMessage(message);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (
        attachment?.phase === "ready" &&
        attachment.role.kind === "judge" &&
        attachment.role.judgeId === judgeIdentifier
      ) {
        this.sendRaw(ws, payload);
      }
    }
  }

  /** One serialisation per broadcast; hundreds of phones share the bytes. */
  private broadcastRole(
    targetRole: ConnectionRole["kind"],
    message: ServerMessage,
  ): void {
    const payload = serialiseServerMessage(message);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(ws);
      if (
        attachment?.phase === "ready" &&
        attachment.role.kind === targetRole
      ) {
        this.sendRaw(ws, payload);
      }
    }
  }
}

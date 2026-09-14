# SYTYCDS architecture baseline

## Reconnaissance

The repository began as an empty Git repository containing only `.gitattributes`; the initial commit had no package manifest, source, build configuration, tests, routing, storage, or WebSocket code. There was therefore no legacy design to preserve or refactor and no scaffolding bloat to remove.

This baseline is a single npm package. It requires Node 22.12 or newer and npm 11 or newer; setup was verified locally with Node 26.8.1 and npm 11.19.0. `package-lock.json` is the dependency lock and npm is the sole package manager.

The implemented foundation is deliberately narrow: a React SPA, a Worker API, a bound SQLite Durable Object, an R2 binding, and Workers-runtime tests. It now includes centralized show-control commands, role-projected hibernating WebSockets, small admin session authentication, a pure scoring engine, anonymous vote identity, the transactional audience vote path, and judge-token lifecycle. Media playback and final public interfaces remain later work.

## Runtime boundaries and authority

```text
admin / projector / vote / judge browsers
                  |
       HTTPS + WebSocket (planned)
                  |
       Cloudflare Worker boundary
      auth, validation, asset/API routing
                  |
       one named ShowCoordinator object
       authoritative state + SQLite writes
                  |
        R2 media objects (by key only)
```

- **Browsers:** render their role-specific interface, collect input, perform local media playback, reconnect, and reconcile server revisions. Browsers are never authoritative for show state, accepted votes, judge submissions, scores, or result visibility.
- **Worker:** serves the built SPA, terminates public HTTP/WebSocket requests, applies request-level security and role checks, and routes show operations to the coordinator. It must not keep important state in isolate memory.
- **ShowCoordinator Durable Object:** the single writer and authoritative coordinator for one show. It owns schema initialization and will own command ordering, validation, idempotency, role-specific state projections, score transactions, aggregate updates, and hibernatable WebSocket fan-out.
- **R2:** stores uploaded performance media. SQLite stores metadata and object keys, not media bodies. R2 content is delivered through explicitly authorised Worker paths or suitable signed access rather than becoming coordinator state.

The four browser roles are operator (`/admin`), public display (`/projector`), audience voter (`/vote`), and one of exactly four token-authenticated adjudicators (`/judge/:token`). The fixed React path resolver only accepts these routes and lazy-loads the relevant semantic surface. The Worker asset fallback permits direct navigation and refresh on each route. Authentication and live data are intentionally deferred.

## SQLite schema and migrations

`worker/schema.ts` is the sole schema definition and migration runner. Each migration is an ordered set of direct SQL statements run inside a Durable Object SQLite transaction; its row is recorded in `schema_migrations` only after all statements succeed. An unknown newer version or a missing earlier version is fatal. Re-initialisation detects prior rows and makes no duplicate changes.

The initial schema contains show state; ordered acts; independent visual/audio cue metadata; four-slot hashed-token judges; per-act judge permissions and insert-once submissions; anonymous insert-once audience votes; their incremental aggregates; result snapshots and finalised results; idempotent command records; and audit events. Composite keys keep an act and judge associated with the same show. The audience-vote primary key enforces one hash per act and the aggregate table is keyed for a constant-time update, so the hot path never needs to scan votes. The four available judge slots are constrained to 1–4; future show-setup validation must require all four before a show is opened.

## Authoritative transitions and realtime

`show_runtime` persists the values that are unsafe to hold only in a Durable Object instance: the safe display mode to restore from HOLD or EMERGENCY, global judge-permission default, prepared and active visual/audio cue IDs, each transport state, and black-screen override. `worker/show-state.ts` is the sole admin mutator. It validates an optimistic expected revision, enforces act and judge ownership, writes command idempotency/audit records, applies one transition, and increments the show revision in a single SQLite transaction. Display changes cannot alter voting; INTERMISSION retains the selected act; submitted judges cannot be reopened; and black screen does not stop audio.

The `/api/ws` endpoint is handled by the coordinator with the Durable Object WebSocket Hibernation API. A compact attachment records only negotiated role and protocol version plus the hash of an authenticated admin session where needed, so sockets survive object eviction without an in-memory connection map. Initial snapshots are projected per role and later traffic consists of revisioned patches, voting/permission updates, media commands, and acknowledgements. Audience connections remain anonymous at this layer; judges authenticate by comparing a SHA-256 URL-token digest with the stored hash. Admin sessions are backed by a random HttpOnly, SameSite=Strict cookie and checked again for every admin command. Projector roles fail closed until `PROJECTOR_ACCESS_TOKEN` is configured as a Worker secret.

## Credentials, sessions, and anonymous identity

Set `ADMIN_ACCESS_TOKEN` and `PROJECTOR_ACCESS_TOKEN` with Wrangler/Cloudflare secrets; neither belongs in `wrangler.jsonc`, the repository, nor a frontend bundle. `POST /api/admin/login` compares the deployment secret using a timing-safe Web Crypto comparison, applies a small per-subject failed-login limit, and issues an eight-hour server-backed session cookie. Admin mutations require that session and a same-origin request; the cookie's Strict same-site policy provides the additional browser CSRF defence. Login is deliberately the only unauthenticated admin write endpoint.

Audience voting uses a separate 256-bit random first-party voter cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS). SQLite sees only its SHA-256 digest, which is unique per show and act. A syntactically valid altered cookie intentionally identifies a different anonymous browser: no anonymous browser scheme can prevent deliberate cookie replacement, so the product makes no claim of one vote per physical person.

Judge URLs contain a random 256-bit token, while SQLite stores only its SHA-256 digest. Tokens are shown only during initial provisioning or rotation; they cannot safely be retrieved later. Operators should rotate a judge token to generate a replacement link, immediately invalidating the previous link.

## State lifetime

Persistent state belongs in coordinator SQLite: show configuration, acts and cues, display/voting state, hashed identities and credentials, accepted submissions, aggregates, revisions, idempotency records, and result publication state. R2 persists media bytes.

Ephemeral state may include live socket objects/attachments, coalescing timers, derived caches, client connection status, and projector playback telemetry. It must be safe to reconstruct after Durable Object hibernation, eviction, deployment, or browser reload. A cache may accelerate reads but cannot become a second source of truth.

## Data flow

1. A browser requests a static asset or an `/api/*` endpoint. Cloudflare serves matching assets and runs the Worker first for API paths.
2. The Worker authenticates and validates the request, then addresses the one stable coordinator ID (`primary`).
3. The coordinator serializes state transitions and persists required facts in SQLite before acknowledging success.
4. The coordinator returns a role-appropriate response and, once realtime work is added, emits compact revisioned WebSocket updates. Reconnecting clients receive a fresh role-specific projection.
5. Media metadata travels through the coordinator; large media bodies travel to or from R2 without entering React state or SQLite.

At present, `GET /api/health` exercises this path through the Worker and coordinator and verifies that SQLite is available. All other API paths return 404.

## Repository structure

```text
src/                  React browser entry and baseline UI
worker/               Worker entry and ShowCoordinator Durable Object
test/                 Workers-runtime integration tests
docs/architecture.md  this baseline and decision record
index.html             Vite browser entry
vite.config.ts         React + Cloudflare Vite integration
wrangler.jsonc         Worker, assets, Durable Object, and R2 bindings
tsconfig*.json         strict, boundary-specific TypeScript projects
```

Wrangler generates `worker-configuration.d.ts` from `wrangler.jsonc`; binding and Workers runtime types are not maintained by hand. Vite development runs Worker code in `workerd`. Vite build emits both client assets and deployable Worker output; Vite preview runs that output in the Workers runtime.

## Major invariants

- There is one authoritative coordinator for a show and one stable way to address it.
- Only committed SQLite data counts as accepted or authoritative; no browser or Worker-isolate memory can overrule it.
- Mutations are validated, serialized, durable, and idempotent where retries could change outcomes.
- Private fields are removed in server-side role projections, not hidden in a client.
- Audience voting, judge voting, and display state remain independent.
- Judge submissions and audience votes are insert-once facts protected by database constraints.
- A final score does not exist until all required inputs exist and is never clamped or client-authored.
- Realtime messages will carry monotonically increasing revisions; reconnect snapshots supersede stale deltas.
- Visual and backing-audio transports remain independent; projector command success requires acknowledgement.
- Missing R2 media, stale clients, disconnects, retries, eviction, and reloads must fail visibly and recover without corrupting accepted state.

## Decision record: edge-coordinated single-show runtime

**Status:** accepted for the SYTYCDS production architecture.

**Decision:** use React and Vite for the four browser surfaces; one Cloudflare Worker as the public trust boundary; one SQLite-backed Durable Object as the show coordinator; Durable Object WebSocket Hibernation for realtime delivery; and R2 for performance media.

**Rationale:** React supports the stateful operator and mobile interactions without imposing a full-stack framework. Vite and the Cloudflare plugin keep the frontend and Worker in one build while executing backend code in `workerd` during development. A single Durable Object gives the show one serialized write authority, preventing competing operator devices and concurrent submissions from creating split-brain state. SQLite provides transactions, uniqueness constraints, efficient aggregates, durable recovery, and inspectable relational data. Hibernatable WebSockets provide low-latency revisioned updates without polling or forcing the coordinator to remain resident. R2 is designed for large media objects and keeps those bytes out of SQLite, Worker bundles, and browser application state.

**Consequences:** the coordinator is intentionally a consistency bottleneck and must keep hot paths short, update aggregates incrementally, and coalesce broadcasts. The Worker and coordinator require explicit role projections and protocol types. R2 object lifecycle and missing-asset handling require operational tooling later. Cloudflare bindings make Workers-runtime integration tests mandatory for infrastructure-sensitive code.

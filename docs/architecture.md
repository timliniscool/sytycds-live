# SYTYCDS architecture baseline

## Reconnaissance

The repository began as an empty Git repository containing only `.gitattributes`; the initial commit had no package manifest, source, build configuration, tests, routing, storage, or WebSocket code. There was therefore no legacy design to preserve or refactor and no scaffolding bloat to remove.

This baseline is a single npm package. It requires Node 22.12 or newer and npm 11 or newer; setup was verified locally with Node 26.8.1 and npm 11.19.0. `package-lock.json` is the dependency lock and npm is the sole package manager.

The implemented foundation is deliberately narrow: a React SPA, a Worker API, a bound SQLite Durable Object, an R2 binding, and an infrastructure test. Voting, show control, media playback, authentication, role projections, and WebSockets are not implemented yet.

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
- **ShowCoordinator Durable Object:** the single writer and authoritative coordinator for one show. It will own command ordering, validation, idempotency, role-specific state projections, score transactions, aggregate updates, and hibernatable WebSocket fan-out. The current class only initializes and reports bootstrap schema metadata.
- **R2:** stores uploaded performance media. SQLite stores metadata and object keys, not media bodies. R2 content is delivered through explicitly authorised Worker paths or suitable signed access rather than becoming coordinator state.

The four browser roles are operator (`/admin`), public display (`/projector`), audience voter (`/vote`), and one of exactly four token-authenticated adjudicators (`/judge/:token`). The SPA fallback already permits these paths, but route-specific UI and authentication are intentionally deferred.

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

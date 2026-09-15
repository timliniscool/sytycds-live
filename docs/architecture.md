# SYTYCDS Live architecture baseline

## Reconnaissance

The repository began as an empty Git repository containing only `.gitattributes`; the initial commit had no package manifest, source, build configuration, tests, routing, storage, or WebSocket code. There was therefore no legacy design to preserve or refactor and no scaffolding bloat to remove.

This baseline is a single npm package. It requires Node 22.12 or newer and npm 11 or newer; setup was verified locally with Node 26.8.1 and npm 11.19.0. `package-lock.json` is the dependency lock and npm is the sole package manager.

The application is one deliberately narrow React SPA, Worker API, SQLite Durable Object, and R2 binding. It includes centralized show-control commands, role-projected hibernating WebSockets, server-backed operator and projector sessions, configurable scoring, anonymous vote identity, transactional vote and judge paths, media playback, public results, setup/readiness workflows, and all four production surfaces.

## Runtime boundaries and authority

```text
admin / projector / vote / judge browsers
                  |
            HTTPS + WebSocket
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

The four browser roles are operator (`/admin`), public display (`/projector`), audience voter (`/vote`), and one of one-to-eight token-authenticated adjudicators (`/judge/:token`). The fixed React path resolver only accepts these routes and lazy-loads the relevant semantic surface. The Worker asset fallback permits direct navigation and refresh on each route.

## SQLite schema and migrations

`worker/schema.ts` is the sole schema definition and migration runner. Each migration is an ordered set of direct SQL statements run inside a Durable Object SQLite transaction; its row is recorded in `schema_migrations` only after all statements succeed. An unknown newer version or a missing earlier version is fatal. Re-initialisation detects prior rows and makes no duplicate changes.

The schema contains show branding and semantic theme configuration; show state; ordered acts; independent visual/audio cue metadata; a dynamic one-to-eight judge collection with separate credential state; per-act judge permissions and insert-once submissions; anonymous insert-once audience votes; their incremental aggregates; frozen result snapshots; idempotent command records; and audit events. Composite keys keep an act and judge associated with the same show. The audience-vote primary key enforces one hash per act and the aggregate table is keyed for a constant-time update, so the hot path never scans votes. Migration 9 copies legacy four-judge and finalised-result rows without regenerating credentials or changing their 50:50 result mathematics.

## Authoritative transitions and realtime

`show_runtime` persists the values that are unsafe to hold only in a Durable Object instance: the safe display mode to restore from HOLD or EMERGENCY, global judge-permission default, prepared and active visual/audio cue IDs, each transport state, and black-screen override. `worker/show-state.ts` is the sole admin mutator. It validates an optimistic expected revision, enforces act and judge ownership, writes command idempotency/audit records, applies one transition, and increments the show revision in a single SQLite transaction. Display changes cannot alter voting; INTERMISSION retains the selected act; submitted judges cannot be reopened; and black screen does not stop audio.

The `/api/ws` endpoint is handled by the coordinator with the Durable Object WebSocket Hibernation API. A compact attachment records the negotiated role and protocol version plus only the credential digest and reaction-limiter fields needed after eviction. Initial snapshots are projected per role and later traffic consists of revisioned patches, voting/permission updates, media commands, acknowledgements, and sampled reaction signals. Audience voter identity is a server-issued HttpOnly cookie; judges authenticate by comparing a SHA-256 URL-token digest with the stored hash. Admin and paired-projector sessions are random, HttpOnly cookies and are checked again for protected operations.

## Credentials, sessions, and anonymous identity

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` with Wrangler/Cloudflare secrets; neither belongs in `wrangler.jsonc`, the repository, nor a frontend bundle. `POST /api/admin/login` verifies a salted PBKDF2-SHA256 credential using a timing-safe comparison, applies a limiter scoped to username plus client and browser signals (rather than the whole school NAT), rotates prior sessions, and issues an eight-hour server-backed cookie. Admin mutations require that session and a same-origin request; the cookie's Strict same-site policy provides the additional browser CSRF defence. A protected rotation endpoint changes credentials without ever returning a stored verifier.

Projectors use an eight-digit, ten-minute, one-use pairing code. Successful pairing replaces that low-entropy code with a random 256-bit, 180-day HttpOnly session; regeneration invalidates unused codes and revocation invalidates existing sessions. The permanent credential is never rendered or put in a URL.

Audience voting uses a separate 256-bit random first-party voter cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS). SQLite sees only its SHA-256 digest, which is unique per show and act. A syntactically valid altered cookie intentionally identifies a different anonymous browser: no anonymous browser scheme can prevent deliberate cookie replacement, so the product makes no claim of one vote per physical person.

Judge URLs contain a random 256-bit token, while SQLite stores only its SHA-256 digest. Tokens are shown only during initial provisioning or rotation; they cannot safely be retrieved later. Operators should rotate a judge token to generate a replacement link, immediately invalidating the previous link.

## Media channels and operator feedback

The visual and backing-audio transports are separate state, and every media
command says which channel it touches. A cue carries an ordered, validated
operation list; visual and backing-audio actions are applied independently, so
a visual cue never silences a backing track and an audio transport cue never
clears the screen. PREPARE preloads media; GO executes load/play, pause, resume,
stop, replay and seek operations. `STOP_MEDIA` ends the visual channel alone;
`STOP_ALL_MEDIA` is the panic control that ends both, clears both active cues
and returns the projector to its display-mode graphics. `REPLAY_MEDIA` restarts
the current backing track from the beginning and leaves vision untouched, which
is the one-press emergency action during a performance. `BLACK_SCREEN` toggles
and never touches audio.

Operator confidence comes from two return paths. The projector acknowledges each
media command by execution ID, and a failed acknowledgement is raised in the
console and in the always-visible status bar rather than logged. Separately the
projector samples its own media elements and forwards playback state, position
and duration as `projector_status`; the coordinator relays it to admin only, and
it is never written to SQLite. Unchanged telemetry repeats on a slow heartbeat so
an operator who reloads mid-show sees the transport immediately.

Admin commands are stamped with the newest revision the client has observed, not
the revision embedded in its last snapshot, and one media command is in flight at
a time. The optimistic revision check in the coordinator remains the authority; a
duplicate delivery is absorbed by the command log.

## Projector presentation, public modes and results

The projector draws two layers. The base is chosen by display mode (lobby, act
card, empty stage, scoreboard, intermission, hold, emergency, final results).
The visual layer is whatever the commanded visual channel asks for: a media
frame, a title card, black, or nothing. `src/projector/scene.ts` derives both
from the projection alone, so the surface only renders. The media layer is
hidden, never stopped, under HOLD, EMERGENCY, SCOREBOARD and FINAL_RESULTS,
because those graphics are the commanded public output; audio is unaffected.

`ProjectorMediaEngine` owns image, video and audio elements outside React and
converges them on the authoritative runtime (`reconcile`). Every snapshot and
media patch reconciles, so a reconnect or reload restores the presentation
without restarting media that already matches. Commands add only what state
cannot express (seek, restart from the top, replay) and are executed once per
execution ID. Images load off-DOM and swap only once decoded, so a failed asset
leaves the previous frame in place and never shows a broken icon; video
elements carry no controls, picture-in-picture or remote playback. Image fit is
`contain` by default and `cover` only where a cue explicitly asks (IMAGE only).
Operator diagnostics on the projector are behind the `D` key.

The scoreboard receives judge tiles (raw text, parsed classification and the
tapered score) and the live audience aggregate; the final score reaches the
projector and phones only as `revealedResult`, inside the `result_reveal`
message or a snapshot, after the operator reveals it. Number motion is
representational: the authoritative value never changes through animation.

INTERMISSION and EMERGENCY text are show configuration (`shows`); the emergency
presentation (BLACK or TEXT) and the results stage live in `show_runtime`.
Entering HOLD or EMERGENCY records the safe mode to restore; EMERGENCY also
pauses any playing transport, which the ordinary RESUME brings back. Nothing
persistent is destroyed by an override. The display patch now reaches phones as
well, so they mirror intermission, hold and emergency.

Rankings are computed from `finalised_results` only (`shared/ranking.ts`),
never from live aggregates. Equal stored scores share a rank and skip the next;
the tie is represented, never broken. Withdrawn acts (`acts.withdrawn_at`) leave
the ranking and are skipped by NEXT/PREVIOUS but keep their history. The public
sees the ranking only through the results stage (HIDDEN, LEADERBOARD, STAGED,
TOP_THREE, WINNER); the projection removes everything the stage withholds, and
the operator's console shows the complete picture.

`PUBLIC_ORIGIN` (a Worker variable) is the canonical audience origin for the
lobby QR; when unset each client uses its own origin, which is right in
development. Judge links never appear in a public projection and are managed
from the SETUP view of the console, where they are shown once when issued or
rotated. Preflight (`worker/preflight.ts`, `src/admin/PreflightPanel.tsx`) runs
coordinator, browser, realtime and projector probes; the projector probes its
own media pipeline in reply to a relayed `preflight_request` and answers with a
`projector_preflight` report that is relayed to admin and never persisted. A
required failure blocks READY; warnings never masquerade as failure.

## Media preparation, operational log, recovery and load

The projector page registers `public/media-sw.js` with scope `/projector`. The
worker answers only `GET /api/media/*`, from the `sytycds-media` CacheStorage
cache, including the Range requests media elements make; everything else goes
to the network untouched, so no API, admin or judge response is ever cached.
The page, not the worker, decides what is cached: `MediaCache` reconciles the
cache with the projector projection's `mediaManifest` (every asset any cue
references, keyed by R2 version), streams each missing file once, verifies its
length, stores it under its version, removes stale or unreferenced entries,
asks for persistent storage, and reports files, bytes, failures and quota
exhaustion through telemetry and the preflight report.

`audit_events` is the append-only operational log (`worker/audit.ts`). Every
operator command writes one typed event with safe metadata (accepted commands
say what changed; refused ones say why); judge acceptance, audience vote
milestones, projector acknowledgements, newly appearing media errors and
operator sign-in outcomes are also recorded. Secrets, tokens, addresses and
individual votes are not. `GET /api/admin/history` pages newest-first by ID and
the console's HISTORY view loads one bounded page at a time.

Recovery is deterministic: a reconnecting client always receives the
authoritative snapshot; revisions detect stale and gapped messages; command,
vote and judge replays are absorbed by the command log and insert-once
constraints; a socket that sleeps with a phone is probed on return and closed
if it does not answer a resync, which hands over to the reconnect path. After
a projector page reload the media engine loads but holds anything the server
says is PLAYING, and reports `held`, because restarting a backing track from
the top mid-act is worse than silence; RESUME or REPLAY is the operator's
decision. Connection-count and aggregate broadcasts are coalesced so a
reconnect storm or a vote burst costs a handful of messages, not one per event.

`npm run test:load` runs the load and chaos harness in `test/load` against the
real coordinator: 100, 500 and 1000 HTTP voters with replay and aggregate
checks, close-mid-burst and act-change races, 100 and 500 phones with fan-out
and reconnect storms, repeated operator clicks, query plans on the vote path,
per-vote transaction cost, role payload sizes, and the three-hour reaction
traffic model (54 million local taps collapse to 10,800 sampled packets).

## Setup, act preparation and reactions

The SETUP view is the show's preparation headquarters. Operators configure the
event title, short name, tagline, curated semantic theme, cached Google font,
reaction availability, judge count and audience/judge allocation. Appearance
previews locally before saving and propagates through role projections. Scoring
changes are protected once any vote, judge score or final result exists; the
explicit `RESET SCORING` path deletes only scoring facts, not acts or media.
Judge credentials and projector pairing codes are one-time displays.

The ACTS & CUES view owns running-order CRUD, public copy, operator-only notes,
public images, media uploads with progress and extracted metadata, reference-
safe deletion, previews, sequential image cue creation, and cue reordering.
Large media bodies stream to R2 and never enter React state. Public act images
use a narrow endpoint that serves only images referenced by an act; other media
continues to require an admin or paired-projector session.

Audience reactions are local-first. Every tap animates immediately on that
phone, while only a rotating cohort of five server-selected reporter slots may
send one capped histogram per five-second interval. The coordinator validates
the slot, interval, feature state and emergency state before relaying a compact
signal to admin/projector only. Projector rendering is capped at 48 transient
nodes, groups excess units into clusters, respects reduced motion, and is
suppressed for emergency and explicit black output. Clearing is an authenticated
ephemeral operator command; reactions never enter authoritative scoring state.

## Deployment

`docs/deployment.md` is the operator's runbook: install, Wrangler login, R2
bucket, secrets, canonical origin, first and later deployments, rollback and
the smoke test. The show itself is provisioned from the console (`PUT
/api/admin/show`), so a fresh deployment needs no database seeding. Static
assets carry security headers from `public/_headers`; API responses get theirs
from `worker/index.ts`.

## State lifetime

Persistent state belongs in coordinator SQLite: show configuration, acts and cues, display/voting state, hashed identities and credentials, accepted submissions, aggregates, revisions, idempotency records, and result publication state. R2 persists media bytes.

Ephemeral state may include live socket objects/attachments, coalescing timers, derived caches, client connection status, and projector playback telemetry. It must be safe to reconstruct after Durable Object hibernation, eviction, deployment, or browser reload. A cache may accelerate reads but cannot become a second source of truth.

## Data flow

1. A browser requests a static asset or an `/api/*` endpoint. Cloudflare serves matching assets and runs the Worker first for API paths.
2. The Worker authenticates and validates the request, then addresses the one stable coordinator ID (`primary`).
3. The coordinator serializes state transitions and persists required facts in SQLite before acknowledging success.
4. The coordinator returns a role-appropriate response and emits compact revisioned WebSocket updates. Reconnecting clients receive a fresh role-specific projection.
5. Media metadata travels through the coordinator; large media bodies travel to or from R2 without entering React state or SQLite.

`GET /api/health` exercises this path through the Worker and coordinator and verifies that SQLite is available; all application API paths are explicitly routed and unknown paths return 404.

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
- Realtime messages carry monotonically increasing revisions; reconnect snapshots supersede stale deltas.
- Visual and backing-audio transports remain independent; projector command success requires acknowledgement.
- The projector receives cue media keys but never operator labels or backstage notes; those are stripped in the server projection.
- Audience phones receive the public display mode, never cue, media or result state that has not been revealed.
- Missing R2 media, stale clients, disconnects, retries, eviction, and reloads must fail visibly and recover without corrupting accepted state.

## Decision record: edge-coordinated single-show runtime

**Status:** accepted for the SYTYCDS production architecture.

**Decision:** use React and Vite for the four browser surfaces; one Cloudflare Worker as the public trust boundary; one SQLite-backed Durable Object as the show coordinator; Durable Object WebSocket Hibernation for realtime delivery; and R2 for performance media.

**Rationale:** React supports the stateful operator and mobile interactions without imposing a full-stack framework. Vite and the Cloudflare plugin keep the frontend and Worker in one build while executing backend code in `workerd` during development. A single Durable Object gives the show one serialized write authority, preventing competing operator devices and concurrent submissions from creating split-brain state. SQLite provides transactions, uniqueness constraints, efficient aggregates, durable recovery, and inspectable relational data. Hibernatable WebSockets provide low-latency revisioned updates without polling or forcing the coordinator to remain resident. R2 is designed for large media objects and keeps those bytes out of SQLite, Worker bundles, and browser application state.

**Consequences:** the coordinator is intentionally a consistency bottleneck and must keep hot paths short, update aggregates incrementally, and coalesce broadcasts. The Worker and coordinator require explicit role projections and protocol types. R2 object lifecycle and missing-asset handling require operational tooling later. Cloudflare bindings make Workers-runtime integration tests mandatory for infrastructure-sensitive code.

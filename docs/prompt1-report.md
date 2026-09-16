# Prompt 1 report — architecture repair and consolidation

This is the hand-over for Prompt 2 (the interface redesign). It records what
changed underneath, what the console can now rely on, how every existing live
control is classified, and what is still open. Nothing in Prompt 2 should have
to re-derive any of this from the code.

Verification at hand-over: `format:check`, `lint`, `typecheck`, `test`
(30 files, 511 tests) and the production build all pass.

## 1. State changes implemented

| Area             | Before                                                               | Now                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show flow        | Display modes only; operator chose each one and each media transport | `show_runtime.flow_step` (ACT_CARD / PERFORMANCE / SCORING / SCOREBOARD / null) plus a derived `ShowFlowState { step, next, blocked }` in every admin projection and as a `flow` patch after every accepted command. Two new commands: `ADVANCE_SHOW` (GO) and `SET_SHOW_STEP`.               |
| GO policy        | —                                                                    | Four booleans on `shows` (`flow_*` columns), exposed as `show.flowPolicy`, saved through `PUT /api/admin/show`; absent in a request ⇒ stored value kept.                                                                                                                                      |
| Voting close     | CLOSED refused everything after the transaction                      | CLOSE mints `show_runtime.vote_close_revision` + `vote_closed_at`; `voting_state_update` carries `closeRevision`; the audience projection carries `voteCloseRevision`; `POST /api/vote` accepts `closeRevision` inside `VOTE_CLOSE_GRACE_MS` (8 s). SELECT/NEXT/PREVIOUS and OPEN clear it.   |
| Presence         | Console inferred "connected" from telemetry                          | `connection_count` now carries `projectors`, `projectorPaired`, `projectorArmed`; armed is recorded on the projector socket's attachment from its own report; telemetry is dropped when no projector socket exists; an admin receives presence immediately on hello.                          |
| Act appearance   | Show-level theme and font only                                       | `acts.theme_id`, `acts.font_family` (nullable = inherit), public as `PublicAct.appearance`; projector, phones and judge surfaces draw the current act in it; the console stays in the show theme. Only curated themes and cached typefaces are accepted.                                      |
| Act presentation | `performanceMode` DEFAULT/CUSTOM                                     | Domain fields `actImageAssetId`, `performanceVisualMode` (AUTOMATIC / IMAGE / VIDEO, derived from the stored mode and the asset's kind), `backingAudioAssetId`. Legacy vocabulary still parses. A declared kind that does not match the file is refused.                                      |
| Media            | Show-level `media_assets`, boolean `referenced`                      | Ownership (`act_id`), test tagging (`generated_test`, `test_show_id`), typed `kind`, `readiness`, and an explicit `references[]` list per asset (act image / backing audio / performance visual / cue, with the act and cue). `GET /api/admin/media?actId=` returns one act's library.        |
| Reset            | Kept name, theme, judges, weighting, projector sessions              | Clears event operations and temporary pairing codes while retaining event identity, appearance, judge setup and links, weighting, GO policy, public text, reactions, and established projector sessions; deletes generated test data and sweeps stray R2 objects under the show's namespaces. |
| Test shows       | —                                                                    | `test_show_generations` (seed, scenario, id); `POST /api/admin/test-show` (confirmed by phrase) replaces show data with a generated show; fixtures under R2 `test-shows/<id>/`.                                                                                                               |
| Diagnostics      | —                                                                    | `GET /api/admin/diagnostics`: realtime metrics from the instance and SQLite; storage metrics listed from R2 at most every 45 s (or `?refresh=1`).                                                                                                                                             |
| Projector arming | `await resume()` then `play()`                                       | Both gesture-sensitive calls issued synchronously in the click before any `await`; the audio element is injectable for tests.                                                                                                                                                                 |

## 2. Database migrations

**Migration 15 — `act_media_library_show_flow_and_test_shows`.** Guarded on the
real shape (each column/table added only if absent), so a partially applied or
rewound history is repaired rather than failed, in keeping with migration 13.

- `media_assets`: `act_id`, `generated_test`, `test_show_id`; index `(show_id, act_id)`.
- `acts`: `theme_id`, `font_family`.
- `shows`: `flow_open_judges_on_scoring` (1), `flow_open_voting_on_scoring` (0), `flow_scoreboard_step` (1), `flow_stop_media_on_scoring` (1).
- `show_runtime`: `flow_step`, `vote_close_revision`, `vote_closed_at`.
- New table `test_show_generations`.
- Data migration: every existing asset used by exactly one act (via its act columns or its cues) becomes that act's library entry; shared or unused files remain show-level. References are untouched; nothing is re-uploaded.

No production data is destroyed by the migration.

## 3. Media-library consolidation

One library per act, one upload path (`POST /api/admin/media?actId=`), one
reference model (`assetReferences()` in `worker/media-assets.ts`). The act
image, backing audio, performance visual and every advanced cue select an
asset ID from that library. The separate drop zones for act image, backing
audio and performance visual are gone; the act editor shows the library with
kind, readiness and use badges, and the presentation slots are dropdowns over
it. A file used by another act is shown as `SHARED`; a pre-ownership file as
`SHOW FILE`. Deletion safety is unchanged: references decide, never filenames.
Deleting an act now also retires files it owned but never used.

Media arriving before the act exists is not supported: the library is created
with the act, and the editor says so.

## 4. Voting-close behaviour

- Selected, not locked, operator closes ⇒ the phone submits automatically,
  quoting the close revision; the phone shows "Sending your score of N…" then
  the locked state.
- Nothing selected ⇒ nothing sent.
- Locked, or a submission already in flight ⇒ untouched; no duplicate.
- Server: a submission quoting the current close revision for the current act
  is accepted within 8 s of `vote_closed_at`, once per phone. A second CLOSE
  does not mint a second revision. Selecting another act or reopening voting
  clears the revision, superseding the window. Anything else after CLOSE is
  refused with `VOTING_CLOSED`.
- Scale: at 1000 phones a close can produce up to 1000 real submissions in the
  following seconds. No additional poll or acknowledgement traffic was added;
  the close revision travels inside the existing `voting_state_update`.
- Tested with simulated network delay (`submitAudienceVote(..., now)`).

## 5. Reset behaviour

`RESET ENTIRE SHOW` ≠ factory reset of the installation. It resets the show to
the product default (see `worker/show-reset.ts` for the policy text) and keeps
the administrator account and sessions, deployment secrets, Cloudflare
configuration, cached typefaces (`fonts/` in R2, `font_assets`,
`selected_font_css`) and the application. Act delete and reset remain
idempotent; R2 failures remain queued, retryable and reported honestly.

The dev-database note in `docs`/memory about "reset keeps the show row, theme
and judges" no longer holds: after a local reset, recreate the demo show's
configuration as well as its acts.

## 6. Projector audio — root cause and fix

Root cause: `arm()` awaited `AudioContext.resume()` and only then called
`HTMLMediaElement.play()`. In browsers that scope user activation to the
gesture's task (Safari; Chromium once activation is consumed), the `play()`
ran after an asynchronous boundary and was refused; the second click found the
context already running, skipped the await, and succeeded.

Fix: `resumeAudioContext()` and `unlockAudioElement()` are now synchronous
entry points that issue their browser calls before returning a promise, and
`arm()` starts both before its first `await`. The surface calls `engine.arm()`
directly from the click handler. Nothing fakes `armed`; refusal is reported
with the browser's reason. Covered by `test/prompt1-consolidation.test.ts`,
which asserts both calls have happened before the returned promise is awaited.

## 7. Realtime status architecture

`connection_count` is the presence message: `audience`, `judgeIds`,
`projectors` (open projector sockets), `projectorPaired` (a live session row
exists), `projectorArmed` (true/false from the connected projector's own
report, null when none is connected). It is sent to a new admin immediately,
coalesced (250 ms) on connect/close storms, and immediately when a projector's
armed state changes. The client stores it as `state.presence` and nulls
`projectorTelemetry` when `projectors === 0`. The pairing panel no longer
polls; `GET /api/admin/projector` remains for on-demand checks and now includes
`armed`.

## 8. Show-flow model

```
(no act) --GO--> ACT_CARD(first act)
ACT_CARD --GO--> PERFORMANCE   : display PERFORMANCE; derived cue visual PLAYING;
                                 backing audio PLAYING if backingAudioStart = PERFORMANCE
PERFORMANCE --GO--> SCORING    : [policy.stopMediaOnScoring] stop all transports;
                                 display ACT_CARD; [policy.openJudgesOnScoring] OPEN_ALL_JUDGES;
                                 [policy.openVotingOnScoring] OPEN_AUDIENCE_VOTING
SCORING --GO--> SCOREBOARD     : display SCOREBOARD            (if policy.scoreboardStep)
SCOREBOARD --GO--> ACT_CARD(next act)  : refused while voting OPEN; refused at end
```

Safe to combine (done by GO): display changes, derived performance media
start/stop, opening judges. Never combined unless policy says so: opening
voting. Never combined at all: closing voting, BLACK, STOP ALL, HOLD,
EMERGENCY, FINALISE, REVEAL, FINAL RESULTS, results staging. `SET_DISPLAY_MODE`
to ACT_CARD/PERFORMANCE/SCOREBOARD moves the step with it; LOBBY, INTERMISSION
and FINAL RESULTS clear it; HOLD/EMERGENCY leave it. Act changes clear it. GO is
blocked during EMERGENCY.

## 9. Live control classification

A = primary normal-show action · B = secondary useful · C = emergency/safety ·
D = diagnostics/status · E = advanced/recovery · F = duplicate/redundant ·
G = obsolete/dead.

| Control (SHOW view)                                                    | Class | Prompt 2 recommendation                                                                       |
| ---------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| GO (show flow)                                                         | A     | The hero control. Label from `flow.next`, reason from `flow.blocked`.                         |
| ACT CARD / PERFORMANCE / SCORING / SCOREBOARD step                     | B     | Keep as a compact step rail; they are jumps, not the normal path.                             |
| ← Previous / Next →                                                    | B     | Keep; also arrow keys.                                                                        |
| Running-order act rows (SELECT_ACT)                                    | B     | Keep.                                                                                         |
| Display mode: LOBBY, INTERMISSION, FINAL RESULTS                       | B     | Keep as "screen" controls outside the act flow.                                               |
| Display mode: ACT CARD, PERFORMANCE, SCOREBOARD                        | F     | Redundant with the step rail; fold into it.                                                   |
| OPEN / CLOSE AUDIENCE VOTING                                           | A     | Keep explicit and prominent.                                                                  |
| OPEN ALL / CLOSE ALL judges                                            | B     | Keep; GO into SCORING covers the common case.                                                 |
| Per-judge OPEN / CLOSE                                                 | B     | Keep in the judge matrix.                                                                     |
| FINALISE / REVEAL / HIDE                                               | A     | Keep explicit.                                                                                |
| Cue stack GO (PLAY_CUE)                                                | E     | Advanced. For the derived PERFORMANCE cue it duplicates flow GO when backing audio is MANUAL. |
| PREPARE                                                                | E     | Advanced; keep.                                                                               |
| PAUSE / RESUME / RESTART                                               | E     | Recovery transport; keep in an advanced/recovery group.                                       |
| ◀ PREV CUE / NEXT CUE ▶                                                | E     | Advanced; keep with the cue stack.                                                            |
| SEEK bar                                                               | E     | Advanced; keep.                                                                               |
| REPLAY BACKING AUDIO                                                   | C     | Keep one-press.                                                                               |
| STOP VISUAL                                                            | E     | Secondary to STOP ALL; keep in advanced.                                                      |
| STOP ALL MEDIA                                                         | C     | Keep one-press and unmistakable.                                                              |
| BLACK SCREEN (display controls)                                        | C     | Keep.                                                                                         |
| BLACK SCREEN / UNBLACK (media emergency row)                           | F     | Duplicate of the above; one control.                                                          |
| HOLD · PLEASE STAND BY / RETURN TO SHOW                                | C     | Keep.                                                                                         |
| ARM EMERGENCY → BLACK NOW / TEXT NOW / BLACK / TEXT                    | C     | Keep the two-press pattern.                                                                   |
| RETURN TO SHOW (override banner)                                       | C     | Keep; same command as the panel's return.                                                     |
| Status: connection, REV, PROJECTOR mode                                | D     | Keep; REV can go behind diagnostics.                                                          |
| Status: PROJECTOR … · AUDIO …                                          | D     | Now authoritative. Keep as the single projector readout.                                      |
| MediaConsole "PROJECTOR CONNECTED · AUDIO NOT ARMED" banner            | F     | Same fact as the status bar; show once.                                                       |
| MediaConsole readout: selected/prepared/executing/projector/time/cache | D     | Keep, collapsible; "Projector" cell duplicates telemetry shown in the status bar.             |
| Vote metrics: accepted, mean, phones, update health                    | D     | Keep; "update health" duplicates the connection badge.                                        |
| SIGN OUT                                                               | B     | Keep.                                                                                         |
| Keyboard P / H                                                         | B     | Keep; consider G for GO.                                                                      |

Setup view: theme picker, font search, judge panel, weighting, GO policy,
pairing, judge links, public text, preflight, danger zone (reset, test show,
orphans, retry) — all B/D/E; none redundant. HistoryPanel — D. ResultsPanel
(stage, reveal next, reset, withdraw, reinstate, put on projector) — B.

No control was found to be G (dead); `test/admin-controls.test.ts` continues to
prove every command is reachable and every button is live.

## 10. Test-show generator architecture

- `shared/test-show.ts` (pure): 13 weighted scenarios (~60% end, ~25% mid,
  ~15% early/edge), `seededRandom` (mulberry32), `createTestSeed`,
  `generateTestShowPlan(seed, scenario?)` producing acts, judge names,
  weighting, votes, judge inputs, finalised flags, withdrawals, current act,
  display mode, flow step, voting state and results stage. Synthetic names
  and copy only.
- `worker/test-show.ts`: `generateTestShow` clears show data (via the shared
  `clearShowData` used by reset), applies the scenario's judge panel through
  the normal scoring-configuration path, creates acts through `createAct` /
  `editAct`, writes real PNG and WAV fixtures to R2 under
  `test-shows/<testShowId>/` with `generatedTest` metadata and
  `media_assets.generated_test = 1`, inserts votes/aggregates and judge
  submissions, finalises through `finaliseResult`, sets the show position and
  records `test_show_generations`. Broken-media scenarios insert an asset row
  whose object is deliberately absent.
- Endpoints: `GET /api/admin/test-show` (current, scenarios, whether show data
  exists) and `POST /api/admin/test-show` `{ confirm: "GENERATE TEST SHOW",
seed?, scenario? }`. Judge sockets are closed because the panel changed.
- Video fixtures are not generated (no dependency-free encoder); media-heavy
  scenarios use images and audio.

## 11. Analytics data available

`GET /api/admin/diagnostics` →

- `realtime`: `presence`, `show { displayMode, audienceVoteState, activeActId,
revision, flow }`, `votes { currentAct, total }`, `projectorMedia` (last
  telemetry while connected), `recentFailures` (last 10 refused commands,
  projector failures, media errors), `counters` (hellos per role, refused
  hellos, resync requests, protocol errors, socket errors, since instance
  start).
- `infrastructure` (cached 45 s): R2 object counts and bytes for the show,
  test and font namespaces (with truncation flag), SQLite `databaseSize`,
  schema version, pending media cleanup.

No secrets or internal identifiers are exposed. These are not yet drawn
anywhere; Prompt 2 designs the panel.

## 11b. Console status fixes found during live verification

Two pre-existing gaps surfaced while verifying the new presence model in the
running dev server and are fixed in this prompt:

- The console never refreshed the judge matrix after a permission change
  (`OPEN_ALL_JUDGES`, per-judge open/close, and now GO into SCORING). The
  coordinator sends the admin a fresh snapshot on every `judge_permission`
  change.
- The console read audience aggregates only from its snapshot and ignored the
  coalesced `aggregate_update` messages it was already receiving, so the
  accepted-vote count and weighted mean did not move during voting without a
  reload. The SHOW view now prefers the live aggregate map.

## 12. Features preserved from other contributors

All prior commits are by the same author account, but every capability present
at the start of Prompt 1 is retained: hibernating WebSocket protocol and
revisions; command idempotency; the cue engine and its projector media engine
(reconcile/execute, staged loads, held playback after reload); media service
worker cache and manifest; preflight (server, browser, realtime, projector);
audit log and history view; results ranking with dense ties, staged reveal,
podium and winner; withdrawal/reinstatement; reactions (local-first, sampled
reporters); Google Fonts caching; admin credential recovery; projector pairing
codes and sessions; orphan and stray sweeps with the durable cleanup queue;
act deletion preview; the operator guide rendered from the README; load and
chaos harness; all seven curated themes with the WCAG pairing test.

Removed as UI (capability preserved): the three separate drop-zone uploaders
in the act editor (replaced by the one library) and the pairing panel's 5 s
poll (replaced by presence).

## 13. Responsive and theme audit

- `/vote` no longer caps at 34 rem: from 720 px it is a two-column layout
  with a wide measure; small and landscape phones unchanged.
- `85vh`/`70vh` → `dvh`; admin and act-editor grid columns no longer force a
  520 px / 28 rem minimum that overflowed narrow desktops.
- All design colours in `src/styles.css` are now theme tokens (or `color-mix`
  of tokens). Remaining literals are true invariants: blackout, the emergency
  screen, the QR code's black on white, the act-card image mask, the reaction
  particles, and the first-paint defaults that `applyShowTheme` overwrites.
- Projector presentation state remains content-only (`ProjectorBase`,
  `VisualLayer`); no pixel coordinates are encoded.

## 14. Known blockers and open points for Prompt 2

- **Console density.** The SHOW view now carries GO, the step rail, display
  modes, the media console, emergency, voting, judges and scoring in one
  column. Prompt 2 must fold the F-class duplicates and demote E-class
  transport into a recovery drawer.
- **Diagnostics have no surface** yet; the endpoint exists.
- **Test-show video fixtures** are not generated.
- **Act library before the act exists** is deliberately unsupported; Prompt 2
  should make "save, then add media" a natural first step.
- **Presence for judges** is per-judge connection only; there is no per-device
  armed/health equivalent.
- **Local dev database:** after the new reset, recreate configuration as well
  as acts when restoring the demo show.
- **Per-act font override** requires the family to be cached first; the act
  editor offers only cached families, so a new family must be chosen once at
  show level (which caches it) before an act can override to it.

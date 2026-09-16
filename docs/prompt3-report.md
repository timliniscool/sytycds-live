# Prompt 3 report — media on creation, expression scoring, staged reveal, audio

This records what was delivered on top of Prompts 1 and 2, how each area was
verified, and what is left. Every line marked **live** was driven through the
running dev coordinator, its database and the real browser surfaces, not
inferred from the code.

Verification at hand-over: `format:check`, `lint`, `typecheck`, `test`
(37 files, 561 tests) and the production build all pass.

---

## 1. Media can be added while the act is being created

The act editor no longer says "save the act first". Files dropped or chosen
on a new act wait in a local queue (badged `UPLOADS WITH THE ACT`), can already
be assigned to the act image, performance visual and backing audio slots, and
are uploaded into the new act's library the moment **ADD TO RUNNING ORDER** is
pressed. Internally: the act is created with any queued slot empty, each file
is uploaded with `actId`, the slots are then assigned their real asset ids in
one PATCH, and the editor switches to the new act once the running order has
caught up. A failed upload stays in the queue with its reason and a **RETRY
UPLOAD** button; the act is never left half-made or unexplained.

**Live.** An act was created through the real form with a WAV and a PNG
dropped before saving and an unsupported `.txt` refused at the drop. The
database afterwards held both assets with `act_id` = the new act, the backing
track and image assigned, and the derived PERFORMANCE cue pointing at the
track. Editing the act (rename) and deleting another act (two-step, cleanup
reported) both still work.

A pre-existing regression was found and fixed on the way: **+ ADD ACT** never
opened the new-act form while the running order had acts in it, because the
stale-selection effect immediately reselected the current act.

## 2. Backing audio is a selection, not a second uploader

The dedicated backing-audio drop zone is gone. **Backing audio** is a select
over the act's audio and video entries (or, during creation, the queued
files), with a preview and REMOVE. The same holds for the act image and the
performance visual. README copy updated to match.

## 3. Generated shows contain soloists and groups

`TestActPlan` carries `performers[]` and `groupName`. Roughly half of
generated acts are soloists, the rest split between named groups and groups
known by their members (2–5, occasionally 6–16); the long-text scenario forces
a large named group with hyphenated names. The worker passes performers and
group name through `parseActInput`, so every surface uses the existing
identity policy. **Live:** a tie-heavy show rendered "The Midnight Quartet ·
7 performers", "Jory Sable · Mika Fairlie · Tam Ashby" and solos correctly on
the results board, scoreboard, act card and phone.

## 4. Generating a test show needs one confirmation

The typed `GENERATE TEST SHOW` phrase is gone from the console. The confirm
panel explains what is replaced and what is kept and offers **REPLACE SHOW
DATA WITH A TEST SHOW** / **CANCEL**. The server still requires its fixed API
phrase, which the client sends, so a stray API call cannot generate a show.
Reset and act deletion keep their typed confirmations: those are proportionate
to destroying a real show.

## 5. Staged reveal — two real defects fixed

- **Empty board.** With STAGED selected and nothing revealed the projector
  showed the holding screen "No act has a final score yet" instead of a board
  of empty places; the first reveal then swapped a whole screen. The board now
  renders whenever there is a ranking, with one outline per hidden act.
- **Rows resized on tie reveals.** Outlines were one per hidden _rank group_
  and the row count changed when a tie group of three filled one outline, so
  every row shrank. `PublicResults.totalEntries` now carries the ranked count;
  the list is `repeat(totalEntries, 1fr)` and the type scales from that
  constant, so no row moves or resizes from the first press to the last, and a
  full leaderboard can never run past the bottom of the projector (it gets
  smaller instead; beyond ten rows the member line is dropped). The row
  entrance is opacity-only so an animation can never touch geometry.

**Live**, full progression on a tie-heavy show (7 acts, 3 rank groups): 7
outlines → last-place trio → second pair → first pair; every row 70 px tall
throughout, list height exactly its container, no horizontal overflow, values
right-aligned, long group lines ellipsised. An extra REVEAL was refused
("Every rank has been revealed"); RESET returned to outlines; a projector
reload mid-reveal came back at exactly the same step.

## 6. Audio arming — root causes, not a patch

Three defects in the lifecycle were found and fixed:

1. **Media never loaded in the hall.** The media route answered a plain GET
   with `206 Partial Content` and `Content-Range: bytes NaN-NaN/size`, because
   the local R2 runtime returns an empty `range` on whole-object reads.
   Browsers treat a 206 to a non-range request as a network error, and the
   projector's service worker forwarded exactly that, so every asset failed
   with "Failed to fetch" and the cache stayed at 0. Whole reads are now 200;
   ranges compute their `Content-Range` from the requested range and are
   pinned by `test/media-serving.test.ts`.
2. **Stale cue list after an act change.** The `active_act` patch carries the
   act but not its cues or media manifest, so the projector kept the previous
   act's cues until some unrelated snapshot arrived. The first PREPARE or GO
   after SELECT_ACT failed with "cue is unavailable". The projector now
   receives a full snapshot on act change (`test/projector-act-change.test.ts`
   proves it over real sockets).
3. **Engine races.** The arming probe and a concurrent reconcile could load a
   track mid-probe (aborting the probe and unloading the track); reconciles now
   wait for the probe, the probe never detaches a source that was loaded
   meanwhile, and its own silent play/pause events are not reported as
   playback. `NotAllowedError` on `play()` now drops `armed` (the surface
   shows AUDIO NOT ARMED — ENABLE again) instead of claiming PLAYING. Staged
   audio for an act that is no longer current is released. Covered by
   `test/audio-arming-lifecycle.test.ts`.

**Live**, repeatedly: armed on the first press; PREPARE loaded without
playing; PLAY → `audio playing`; PAUSE → `paused`; RESUME → `playing`;
STOP ALL → `idle`; PLAY again → playing; SELECT another act with a PREPARE
0.3 s later → no error, `audio idle` (nothing stale), its PLAY then played the
new track to `ended`. Reload of the projector re-armed on one press.

## 7. Show state across administrator devices

Verified by inspection and test: no `localStorage`/`sessionStorage` is used
anywhere in `src/`; the only browser storage is the projector's CacheStorage
media cache (device-specific by design) and cookies for sessions. Acts,
performers, groups, running order, media metadata and assignments, backing
tracks, judges, weighting, GO policy, theme and typeface all live in the
coordinator's SQLite. `test/admin-cross-device.test.ts` configures a show,
signs in a second independent admin session over the real socket and asserts
the first snapshot carries all of it.

## 8–11. Expression scoring

`shared/math-expression.ts` is a closed tokeniser/Pratt parser/evaluator with
no `eval`, `Function` or dynamic code path: numbers, `π`/`pi`, `e`,
`∞`/`infinity`, `+ − × ÷ ^ !`, brackets, implicit multiplication, a whitelist
of functions (`sqrt cbrt root abs ln log log2 log10 exp sin cos tan asin acos
atan sinh cosh tanh floor ceil round trunc sign min max mean factorial gamma
deg rad`), finite sums and definite integrals in both function form and plain
English (`integral from 0 to pi of sin(x) dx`; adaptive Simpson with a hard
evaluation budget, nesting ≤ 2, finite bounds only). Unknown symbols,
unbalanced brackets, NaN results, over-deep nesting and over-long input are
refused with a one-line reason. `parseJudgeScore` keeps its fast paths and
persisted shape; an overflowing value classifies as ±infinity deliberately,
never as NaN.

- **Judge page**: one-sentence Effective Score explanation, a hint listing
  the kinds of expression accepted, and a 35-key scientific keypad that edits
  at the caret. The typeset entry, its Effective Score and, when different,
  what it counts as are shown live, on the confirmation and once locked.
- **Rendering**: `MathTree` builds MathML through React's element API from
  the parsed tree (tags from a closed union, leaves as escaped text), so no
  judge text can become markup. Plain numbers and single constants stay as
  typed; anything richer is typeset on the judge page, in the console's judge
  matrix and on the projector scoreboard tile (with `= value` and the taper
  note beside it).
- **Pipeline audit**: `test/math-expression.test.ts` covers normal decimals,
  negatives, zero, exactly 10, large positive and negative, scientific
  notation, π, e, ±infinity, arithmetic, functions, integrals, malformed
  input, budget exhaustion and the unchanged taper outside 0–10.

**Live:** `integral from 0 to pi of sin(x) dx * 4` typeset on the phone,
locked as Effective Score 8, shown typeset in the judge matrix and on the
scoreboard as "= 8"; `2^4` entered from the keypad locked as Effective Score
16 counting 10.861.

## 12. Scrolling and native controls

Thin theme-coloured scrollbars everywhere (standard properties first, WebKit
fallback, transparent track, hidden on the projector), `select` with a
currentColor chevron and native popup, themed `progress`, accent-coloured
checkboxes and radios, focus rings on selects/textareas/summaries, scrolling
media and cue lists with `overscroll-behavior`. No native control was replaced
by a custom imitation.

## 13. Regression sweep

Beyond the live checks above: act creation, editing and deletion; solo, named
and unnamed groups on every surface; generation without a typed phrase;
projector pairing (paired display re-authorised without a reload); voting
(7 locked in through the phone); final results and podium unchanged; judge
page at 375 px (keypad 343 px wide, no horizontal overflow). `test/
admin-controls.test.ts` still finds every command reachable and no inert
button.

## Files

New: `shared/math-expression.ts`, `src/math/MathExpression.tsx`,
`test/math-expression.test.ts`, `test/audio-arming-lifecycle.test.ts`,
`test/media-serving.test.ts`, `test/projector-act-change.test.ts`,
`test/admin-cross-device.test.ts`, this report.

Changed: `shared/scoring.ts`, `shared/domain.ts`, `shared/ranking.ts`,
`shared/test-show.ts`, `src/admin/ActEditor.tsx`, `src/admin/DangerZone.tsx`,
`src/judge/judge-view.ts`, `src/surfaces/JudgeSurface.tsx`,
`src/surfaces/AdminSurface.tsx`, `src/projector/Results.tsx`,
`src/projector/Scoreboard.tsx`, `src/projector/scoreboard-view.ts`,
`src/projector/MediaEngine.ts`, `src/styles.css`, `worker/media-assets.ts`,
`worker/show-coordinator.ts`, `worker/test-show.ts`, `README.md`, and the
tests that pinned the old parser, tile and results shapes.

## Not claimed

- The projector was exercised in the in-app browser pane, which draws only
  intermittently; arming was pressed for real three times and playback
  observed through the engine's own diagnostics, not heard on speakers.
- `1e` (a digit followed by a bare `e`) reads as `1·e ≈ 2.718`, as a
  calculator would; the old parser refused it.
- Local dev data: the tie-heavy test show (seed `CAFE1234`) plus the acts
  created during verification are still in the local coordinator.

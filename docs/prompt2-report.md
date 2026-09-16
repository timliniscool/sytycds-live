# Prompt 2 report — groups, act management and release validation

This records what Prompt 2 delivered on top of the Prompt 1 consolidation, how
each area was verified, and what is deliberately left as it is. Nothing here is
claimed to work unless it was exercised: every line marked **live** was driven
through the real HTTP API, the real database and the real browser surfaces on a
running coordinator, not asserted from reading the code.

Verification at hand-over: `format:check`, `lint`, `typecheck`, `test`
(32 files, 525 tests) and the production build all pass.

---

## 1. Soloists and groups

An act is now a list of performers, not a name. `acts` gained `group_name`,
`performer_display_mode` and `show_full_member_list_to_audience`; a new
`act_performers` table holds ordered members, back-filled from the old
`performer_name` so no legacy act lost its identity.

`shared/act-identity.ts` is the single policy every surface asks. Given an act
it returns a primary line, an optional secondary line, the member list and a
count, and it decides automatically:

| Act                            | Primary                   | Secondary       |
| ------------------------------ | ------------------------- | --------------- |
| One performer                  | the performer's name      | —               |
| Named group, few short names   | the group name            | the member list |
| Named group, many names        | the group name            | `14 performers` |
| Unnamed group, few short names | the member list           | —               |
| Unnamed group, many names      | `Ensemble · N performers` | —               |

The readability rule is a length budget, not just a count, so a group of four
with very long names falls back to a count rather than overflowing a projector
line. Audience phones get a slightly larger budget than the hall.

**Verified live.** Five acts (solo, unnamed trio, named quartet, named group of
14, unnamed choir of 16) were created through the admin API, reloaded, and read
back from `act_performers`. Each rendered correctly on the act card, the
performance screen, the scoreboard, the audience phone and the podium.

## 2. Audience member lists are opt-in

`toAudienceAct()` redacts `performers` to an empty list unless the act sets
`showFullMemberListToAudience`. The count survives redaction, so a phone can
still say how many people are on stage without naming them. This is server-side
omission, not client-side hiding.

**Verified live** on a phone viewport: the opted-in choir listed all 16 members;
the projection for a non-opted act carried no member rows at all.

## 3. Frozen identity in results

`FINALISE_RESULT` freezes the presentation identity into
`finalised_results_v2.performer_name` and `performer_subtitle`. Renaming or
re-grouping an act afterwards cannot rewrite a result that has already been
announced.

**Verified live.** All seven acts were finalised through the real command and
each frozen row was read back: solos froze a bare name, the named quartet froze
its group name plus the member list, the group of 14 froze `14 performers`, and
the choir froze `Ensemble · 16 performers`.

## 4. A selection is never a vote

`VOTE_CLOSE_GRACE_MS` and the post-close grace path are gone. Closing voting
discards any score a phone had selected but not locked in, and submits nothing.

**Verified live, both directions.** A phone selected 8 while voting was open —
the database held zero votes. Voting was closed — still zero, and the phone said
_"Voting closed"_. Voting reopened, 7 was selected, **LOCK IN 7** pressed and
confirmed: exactly one vote of 7 was stored and the aggregate moved from 40 to
41 votes.

## 5. Delete Act

Reported non-functional and release-blocking. It works, and its storage cleanup
is reference-aware.

**Verified live** on an act with four uploaded files, one of which a second act
also referenced. The preview named two released assets and one shared asset with
no blockers. The delete returned `retiredAssets 2, keptSharedAssets 1,
objectsDeleted 2, objectsPending 0, cleanupComplete true`. Afterwards:

- the act, its performers, cues, judge submissions, audience aggregates and
  finalised result were all gone;
- the two unique objects were gone from R2, confirmed by a bucket scan that
  found zero stray objects;
- the second act's own asset and the shared asset both still served real bytes;
- no act or cue held a dangling media reference;
- repeating the delete returned `Act not found` and changed nothing.

## 6. Global reset

Reset clears the event and keeps the venue. Two gates guard it: the operator
types `RESET` or the event's own name into the console, and the client then
sends a separate fixed API phrase, so a stray API call cannot wipe a show.

**Verified live end to end.** A request carrying only the operator's phrase was
refused and destroyed nothing. The real reset then reported
`clearedActs 7, objectsDeleted 3, objectsPending 0, mediaCleanupComplete true`,
and assertions on both halves of the contract passed:

- **Cleared to zero:** acts, performers, cues, cue references, media assets,
  audience votes and aggregates, judge submissions and permissions, finalised
  results, result snapshots, pairing codes. The show returned to `LOBBY` with no
  current act and a cleared runtime.
- **Retained exactly:** event name, short name, tagline, subtitle, theme,
  typeface, audience weighting, reactions, public messages, all four GO-policy
  flags, the whole judge panel, the administrator account, cached typefaces, and
  the three established projector sessions.
- **Storage:** the orphan scan found no assets, no pending cleanup and no stray
  objects.

The projector and the phone both stayed connected through the reset and moved
straight to the empty lobby without a reload.

## 7. Final Results eligibility

This was the one real user-facing defect found during validation. The panel
disabled every results stage when nothing was ranked but said nothing about why,
and it still allowed an empty results board to be pushed to the projector.

Now the panel explains itself. `src/admin/results-view.ts` rolls the server's
per-act exclusion reasons into one sentence naming the next action, ordered so
the reason closest to producing a ranking comes first. Every disabled control
carries that sentence as its tooltip, and **PUT FINAL RESULTS ON PROJECTOR**
stays shut until something can actually be shown.

**Verified live** against a show with no finalised results: the panel read
_"4 acts are fully scored and waiting for FINALISE. Nothing can be ranked until
then."_, all five stage buttons except HIDDEN were disabled with that tooltip,
the projector button was disabled, and the table underneath named the exact
missing judges for the other three acts. Ten unit tests in
`test/results-eligibility.test.ts` pin every branch.

## 8. Ties and the podium

Ranking is dense, and the podium shows the top three rank numbers rather than
the top three acts.

**Verified live** in two different tie shapes.

With three solos and one named group all on 9.800 and two acts on 9.500, the
console listed `=1 =1 =1 =1 =2 =2 3` — a four-way first and a two-way second,
each row flagged as tied.

After re-finalising every act, two solos and one named group shared first on
9.800. The projector podium then rendered first place as a single step labelled
**3 WAY TIE** holding all three acts, with a second and a third beside it, and
every group carried its subtitle: the quartet its member list, the group of 14
its `14 performers`, and the choir its `Ensemble · 16 performers`.

## 9. Scoreboard and podium layout

The reported "black bar" on the scorecard was chased to its actual cause. It is
not a product defect: DOM measurement showed the stage filling its container
completely, and the bar only appears as letterboxing in an emulated viewport.
Two genuine layout defects were found instead and fixed in `src/styles.css`:

- `.scoreboard__audience` sat in a greedy grid row with `align-content: center`,
  leaving a tall, nearly empty dark slab beside the judge tiles. It now
  distributes its content and the judge tiles stretch to the same band, so the
  middle of the screen is two balanced blocks.
- `.podium__step` packed its content at the top, leaving roughly two thirds of
  each step empty. It now uses an explicit two-row grid.

Both fixes carry a comment naming the defect they remove.

**Verified live** at the projector: the audience panel and judge block measure
the same height, and the podium steps are proportionally filled.

## 10. Every live control

`test/admin-controls.test.ts` discovers controls from the application source, so
a control added by anyone is covered as soon as it exists. It proves every
control sends a command the server implements, every implemented command is
reachable from some control, every admin endpoint called is a declared route,
and no rendered button is inert. It reports **36 commands across 5 surfaces**.

A passing static check is not proof anything works, so all 36 were then driven
through the real `/api/admin/command` endpoint against a running show, each
followed by a read of the authoritative state it should have changed:

| Verdict                | Count |
| ---------------------- | ----- |
| PASS                   | 42    |
| INTENTIONALLY DISABLED | 6     |
| FAIL                   | 0     |

The passes include act navigation, display modes, the black-screen toggle,
audience voting, per-judge and all-judge permissions, per-act reveal, public
text, emergency activation and restore, the full media transport (prepare, play,
pause, resume, restart, seek, stop, replay, stop-all), cue navigation, all five
results stages, staged reveal and reset, withdraw and reinstate, show-step
selection and GO.

The six intentionally disabled cases are guards, each verified to refuse with a
reason: an unknown act id, a display mode outside the union, public text over
the length cap, RESTORE_DISPLAY with nothing to restore, staged reveal while
staged is not the active stage, and a cue id that does not belong to the current
act.

Two commands needed real fixtures before they meant anything, so an act was
given genuine backing audio and a second cue: `SEEK_MEDIA` and `REPLAY_MEDIA`
are audio-channel actions, and `NEXT_CUE` / `PREVIOUS_CUE` need more than one
cue. All four then passed against real state.

## 11. Performance and bundle size

Measured from a real production build.

| Surface          | JavaScript downloaded | Gzipped  |
| ---------------- | --------------------- | -------- |
| `/vote`          | 219.7 KiB             | ~72.6 kB |
| `/judge/:token`  | 213.5 KiB             | ~69.7 kB |
| `/projector`     | 250.6 KiB             | ~82.6 kB |
| `/admin` initial | 245.6 KiB             | ~78.4 kB |

Code splitting is real and correct. A phone on `/vote` downloads no admin code,
no projector graphics and no QR encoder — confirmed by searching the emitted
chunks, not by inspecting imports. Of the bytes it does load, 88% is the shared
React entry chunk; vote-specific code is about 9.5 kB gzipped. There are exactly
two runtime dependencies, `react` and `react-dom`. Routing, QR encoding and
markdown parsing are all first-party. There is not one `console` statement in
`src/`, `shared/` or `worker/`, and no large inlined blobs.

Two measured costs are accepted deliberately rather than removed:

- **The README ships inside the Help chunk** (50.9 kB raw, 19.2 kB gzipped).
  `HelpPanel` renders the repository's own README so the manual cannot drift
  from the documentation. It is admin-only and lazily loaded, so no audience or
  judge device ever fetches it. Splitting the document would reintroduce exactly
  the drift the design exists to prevent.
- **CSS is one 81.9 kB file (14.2 kB gzipped)** served to all four surfaces.
  Splitting it per surface is a real saving but a structural change to the
  theming system, which is out of scope for a release-validation pass.

Three genuine pieces of dead weight were removed: `primaryActIdentity`, the
superseded `VOTE_CLOSE_GRACE_MS` stub, and a byte-identical copy of
`isUniqueViolation` that existed in both the vote and judge intake paths and now
lives once in `worker/schema.ts`. Other reportedly dead exports were checked
individually and found to be in use; nothing was removed on suspicion.

## 12. Database and migrations

Migration 16 adds the group columns, the `act_performers` table and
`finalised_results_v2.performer_subtitle`. It follows the established guarded
pattern: every column and table is added only if absent, so a partially applied
or re-run migration reconciles instead of failing. The schema is at version 16
on the running coordinator.

## 13. Test data

No test data remains. The five group-matrix acts, their four uploaded media
files and the backing-audio fixture were all removed by the global reset
exercise, which doubled as the cleanup. The show is in an empty lobby with its
venue configuration intact, and the orphan scan reports an empty bucket. The
public message strings used during control testing were cleared through the real
commands.

All destructive testing ran against the local development coordinator only. The
reset harness refuses to run against a non-local host.

## 14. What is not claimed

- Load and soak behaviour was not re-measured in this pass; `test:load` exists
  and was not run.
- The projector was exercised in the in-app browser pane, not on real projector
  hardware at 1920×1080. The layout is built on a proportional unit
  (`--unit: min(1vw, 1.7778vh)`), so composition scales, but a hardware
  rehearsal is still worth doing before the event.
- Nothing was deployed. All verification was against the local dev server.

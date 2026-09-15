# SYTYCDS Live — operator manual

This is the manual for the person running the show. Read it once before the
first show; keep it open beside the console on the night. Developer and
deployment notes are at the bottom.

Everything in this manual describes what the software actually does. If a
control is not described here, it does not exist.

---

## Contents

1. [What is SYTYCDS Live?](#what-is-sytycds-live)
2. [First-time setup](#first-time-setup)
3. [Logging in](#logging-in)
4. [Preflight](#preflight)
5. [Projector pairing](#projector-pairing)
6. [Enable Audio](#enable-audio)
7. [Themes and fonts](#themes-and-fonts)
8. [Judge configuration](#judge-configuration)
9. [Audience and judge weighting](#audience-and-judge-weighting)
10. [Creating acts](#creating-acts)
11. [Backing audio](#backing-audio)
12. [The performance screen](#the-performance-screen)
13. [Simple Show Flow and advanced cues](#simple-show-flow-and-advanced-cues)
14. [Running an act](#running-an-act)
15. [Audience voting](#audience-voting)
16. [Judge scoring](#judge-scoring)
17. [Scoreboard and reactions](#scoreboard-and-reactions)
18. [HOLD, INTERMISSION, BLACK and EMERGENCY](#hold-intermission-black-and-emergency)
19. [Finalising results](#finalising-results)
20. [Final Results and ties](#final-results-and-ties)
21. [Deleting an act](#deleting-an-act)
22. [Resetting the whole show](#resetting-the-whole-show)
23. [Orphaned media](#orphaned-media)
24. [Help inside the console](#help-inside-the-console)
25. [Common problems](#common-problems)
26. [Emergency recovery](#emergency-recovery)
27. [Developer and deployment notes](#developer-and-deployment-notes)

---

## What is SYTYCDS Live?

SYTYCDS Live runs a live talent show from one browser tab. It drives four
surfaces at once:

| Surface       | Address      | Who uses it                                        |
| ------------- | ------------ | -------------------------------------------------- |
| **Console**   | `/admin`     | You. Password-protected.                           |
| **Projector** | `/projector` | The machine plugged into the screen and the PA.    |
| **Audience**  | `/vote`      | Phones in the hall. No login; they scan a QR code. |
| **Judge**     | `/judge/…`   | One private link per judge.                        |

One server holds the authoritative show state. Every surface is a view of it.
Nothing is decided in a browser: if the console and the hall ever disagree,
the server is right and the surfaces catch up on their own.

---

## First-time setup

Do this at least a day before the show, in this order. Each step depends on
the one above it.

1. **Log in** to `/admin`.
2. **Create the show** — title and tagline. Nothing else works until the show
   exists.
3. **Set the appearance** — theme and typeface (_01 / EVENT_).
4. **Set the judge panel** — how many judges and what they are called
   (_02 / SCORING_).
5. **Set the weighting** — audience share versus judge share
   (_02 / SCORING_).
6. **Pair the projector** (_DISPLAY ACCESS_).
7. **Hand out judge links** (_JUDGE LINKS_).
8. **Build the running order** — acts, images, backing audio (_ACTS & CUES_).
9. **Run Preflight** (_03 / SHOW READINESS_) and clear every failure.

On the night, repeat steps 6, 7 (only if a judge lost their link) and 9.

---

## Logging in

Go to `/admin` and sign in with the operator username and password. The
session is an HttpOnly cookie; it survives reloads and lasts the evening.

Repeated wrong passwords are rate-limited, and the wait grows. If you are
locked out, wait rather than retrying faster.

**SIGN OUT** is in the top right. Signing out does not stop the show: the
projector keeps showing whatever it was showing.

---

## Preflight

_SETUP & PREFLIGHT → 03 / SHOW READINESS → RUN PREFLIGHT._

Every row is a real probe, not a checklist item, and every failure names the
fix. Four groups run at once:

- **Coordinator** — the server, its database, media files, judge and show
  configuration, the public origin for the QR code.
- **Browser** — can this console reach the server, and is it signed in.
- **Realtime** — a live resync round trip, timed.
- **Projector** — the projector's own self-test: protocol version, media
  engine, audio arming, cache storage, and every image, video and audio file
  the show references, decoded on the projector itself.

Two rows matter most and are also shown permanently in the console header:

```
PROJECTOR CONNECTED · AUDIO ARMED
```

`AUDIO NOT ARMED` cannot be fixed from the console. See
[Enable Audio](#enable-audio).

**RERUN** on a failed row re-runs only that group.

---

## Projector pairing

The projector is the machine plugged into the screen and the sound system.
Pairing is how that machine proves it is allowed to be the public display.

1. On the console: _SETUP & PREFLIGHT → DISPLAY ACCESS →_
   **GENERATE PROJECTOR CODE**. An eight-digit code appears with a countdown.
   It is valid for ten minutes.
2. On the projector machine, open `/projector`. It shows **Pair this display**.
3. Type the code and press **PAIR DISPLAY**.
4. The display moves straight to live show output. **You do not reload it.**

The code is single use and dies the moment it is used. Eight wrong attempts
burn it; generate a new one. The display then holds a long-lived session, so
you can reload the projector, restart its browser or unplug it overnight and
it comes back paired.

**REVOKE PROJECTOR SESSIONS** ends every projector session immediately. Any paired
display drops back to the pairing screen at once — no reload — and needs a
fresh code. Use it if a display is lost or stolen, or before handing a laptop
back.

Pair exactly one display. Preflight warns if more than one is connected,
because a second display is a second public screen.

---

## Enable Audio

Browsers refuse to play sound until somebody clicks something **in that
browser**. A click on your console is not a click on the projector, so nothing
you do here can unlock the hall's sound. Only the projector can.

After pairing — and after any reload of the projector page — the projector
shows one panel over the output:

> **This display is paired**
> ENABLE AUDIO & ENTER SHOW

Press it **on the projector machine**. The projector then genuinely unlocks
its audio pipeline and tests it silently; it reports `AUDIO ARMED` to your
console only if the test actually succeeded. A button press alone is never
enough.

**Continue without audio** dismisses the panel and shows the picture
immediately, leaving a small `AUDIO NOT ARMED — ENABLE` button in the corner.
Use it if a projector reloads mid-show and you need the picture back this
second; press the corner button at the next opportunity.

Arming lasts the whole page session. It survives every show state change,
every act, every cue. A reload starts the browser's permission over, so the
panel comes back — that is the browser, not a fault.

---

## Themes and fonts

_SETUP & PREFLIGHT → 01 / EVENT → APPEARANCE._

Pick a curated theme. Every theme defines a full set of colours for both the
web surfaces and the projector, and every combination the software can draw is
contrast-tested, so no theme can make text unreadable.

The projector variant of a theme is always dark, including the light ones: a
white field at projector size is glare.

Selecting a theme **previews** it in the console. A banner appears:

> Previewing unsaved changes — save to put them on every screen.

Press **SAVE EVENT APPEARANCE**. Only then is the theme the show's theme:
stored on the server, sent to the console, the projector, the phones and the
judges, and kept across navigation, reload and reconnect. Leaving the
workspace without saving restores the stored appearance.

**Typeface** — search Google Fonts and pick one; the server downloads and
serves it, so the hall does not depend on Google being reachable. If a font
cannot be downloaded, everything else still saves and the show keeps the font
it had; the notice says so. _System UI (offline-safe)_ always works.

---

## Judge configuration

_SETUP & PREFLIGHT → 02 / SCORING → JUDGES._

There is exactly one place that decides how many judges the show has and what
they are called:

```
JUDGES
Number of judges:  4
Judge 1: [ Alice ]
Judge 2: [ Bob   ]
Judge 3: [       ]
Judge 4: [       ]
```

- One to eight judges.
- Changing the number changes the list of name fields immediately.
- **Names are optional.** A blank field stays "Judge 3", which is a perfectly
  good name on the scoreboard. Type a name only if you want one.
- Reducing the count deactivates the judges at the end. They keep their
  identity and history, so increasing the count again brings them back.

Press **SAVE JUDGES AND WEIGHTING**. The panel and the weighting are saved
together — you never get half a configuration.

Judge links live under _JUDGE LINKS_ and are issued automatically for each new
judge. A link is shown **once**; copy it or scan its QR code then. If a link is
lost, **ROTATE** issues a new one and the old URL stops working immediately.
**REVOKE** disables a link without deleting the judge.

Once any score or vote exists the configuration locks. Changing it then
requires typing `RESET SCORING`, which erases every vote, judge score and
finalised result for the whole show. Acts, media and judges survive.

---

## Audience and judge weighting

The same section sets the split, from 0% to 100% audience. The console shows
what each judge is worth:

> 4 judges · 50% judge share · approximately 12.50% each of the overall score.

The audience block is one weighted mean of every accepted phone vote. Judges
are equally weighted among themselves.

An extreme split is allowed and honoured. At 100% audience, judge scores are
not required to complete a result; at 0% audience, phone votes are not.

---

## Creating acts

_ACTS & CUES._ Each act has:

| Field              | Who sees it                                     |
| ------------------ | ----------------------------------------------- |
| Performer name     | Projector and phones                            |
| School year        | Projector and phones                            |
| Act name           | Projector and phones                            |
| Act type           | Projector (and phones with the act name)        |
| Public description | Projector. Phones only if you switch it on.     |
| Act image          | Projector. Phones only if you switch it on.     |
| Internal notes     | **You only.** Never sent to any public surface. |

### On audience phones

Phones always receive the act name, the performer and the year or group. Two
switches control the rest:

- `Show description on audience phones` — off by default.
- `Show act image on audience phones` — off by default.

When a switch is off, the server does not send that field at all; it is not
hidden in the phone, it is absent. Stage media — performance visuals and
backing audio — is never sent to phones under any setting.

**MOVE UP / MOVE DOWN** set the running order. **SELECT FOR SHOW** makes an
act current. **DELETE ACT** opens a summary of exactly what would be destroyed;
see [Deleting an act](#deleting-an-act).

---

## Backing audio

_ACTS & CUES → act → Performance → BACKING AUDIO._

Drop an MP3, WAV or other audio file on the drop zone, or click it to choose a
file. You do not build a cue for this.

After upload the panel shows the filename, duration, dimensions where they
apply, file size, a **READY** badge and a player so you can check you uploaded
the right track. **REMOVE** clears it. Dropping another file replaces it.

Then choose when it starts:

- **Manually, when the operator presses GO** — default. The track is loaded and
  waiting; you press **GO** when the performer is ready.
- **Automatically, when PERFORMANCE begins** — switching the projector to
  PERFORMANCE starts the track.

The backing track is a channel of its own. Changing the visual, blacking the
screen or stopping the visual never silences it. Only **STOP ALL MEDIA**, a
cue that stops audio, or EMERGENCY does.

---

## The performance screen

Every act already has a finished performance screen. You do not have to supply
anything for an act to look right on the projector.

**Default** — the act's name, the performer and the year or group, centred and
sized to read from the back of a hall. If the act has an image it appears
behind the text as a restrained wash. The layout holds at 1920×1080 and
1280×720.

**Custom performance visual** — tick `Use custom performance visual` and drop
an image or a video. It replaces the whole normal performance screen.

- Images are shown **whole**. They keep their aspect ratio, are never
  stretched or distorted, and are letterboxed or pillarboxed against the
  theme's own background. `Show the whole image` is the default.
- `Crop to fill the screen` is available when you deliberately want the image
  to bleed to the edges, and will cut off part of it.
- Videos likewise keep their aspect ratio and use the screen without
  distortion.

Backing audio is independent of all of this: an act can have a custom visual
and no audio, audio and the default screen, both, or neither.

---

## Simple Show Flow and advanced cues

For an ordinary act the whole show is three steps:

1. **ACT CARD** — the performer is announced.
2. **PERFORMANCE** — the performance screen (default or custom) and the
   backing track.
3. **SCOREBOARD** — the scores.

The software builds the media cue for step 2 from the act's Performance
settings. It appears in the cue stack labelled `PERFORMANCE` with an `AUTO`
badge, always first, and is rebuilt whenever you change those settings. You
cannot edit or delete it from the cue editor — change the act instead.

**Advanced cues and media library** (a disclosure at the bottom of the act) is
the full engine, unchanged, for acts that need it: multi-step sequences, title
cards, slide runs, separate visual and audio operations, pause, resume, replay,
seek, stop, black and clear. Your own cues are never touched by the derivation
and run after the derived one.

Most acts never need to open it.

---

## Running an act

The **SHOW** view is the live console.

**Choosing the act** — click it in the running order, or use **← Previous** /
**Next →** (also the left and right arrow keys). Withdrawn acts are skipped by
Previous/Next but can still be selected deliberately. You cannot change the act
while audience voting is open, and the console asks for confirmation if media
is playing.

**Display mode** — LOBBY, ACT CARD, PERFORMANCE, SCOREBOARD, INTERMISSION,
FINAL RESULTS. `P` is a shortcut for PERFORMANCE, `H` for HOLD.

**Media transport** — one command at a time; the console waits for the
projector to acknowledge before accepting another, so a double click cannot
fire twice.

| Control                     | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| **GO**                      | Runs the selected cue: visual up, backing track from the top. |
| **PREPARE**                 | Loads the cue's media without showing or playing anything.    |
| **PAUSE**                   | Pauses everything that is playing.                            |
| **RESUME**                  | Resumes what was paused.                                      |
| **RESTART**                 | Restarts the current media from the beginning.                |
| **REPLAY BACKING AUDIO**    | Restarts the backing track only; the visual is untouched.     |
| **◀ PREV CUE / NEXT CUE ▶** | Moves the selection through the cue stack, without playing.   |
| **STOP VISUAL**             | Ends the visual channel. The backing track keeps playing.     |
| **STOP ALL MEDIA**          | Stops every transport. The panic control; always available.   |
| **BLACK SCREEN**            | Toggles blackout. See below.                                  |
| Seek bar                    | Appears once the projector reports a duration.                |

Underneath the transport the console shows what the projector actually
reports: its transports, playback position and duration, media cache progress,
and any media error. If the projector did not execute a command, it says so.

---

## Audience voting

Phones reach the show by scanning the QR code on the LOBBY screen, or by
opening `/vote`.

**OPEN AUDIENCE VOTING** (confirmed, because it is public) lets phones score
the current act 0–10. **CLOSE AUDIENCE VOTING** ends it.

How a phone vote works, exactly:

1. The voter taps a number. **This is local. Nothing is sent.** The phone says
   so: _"Selected 8 — not sent yet"_.
2. They press **LOCK IN 8**, then confirm.
3. Only then is a vote sent, and only the server decides whether it counts.
4. The phone shows the score as locked only after the server accepts it.

If the operator closes voting while a score was being sent, the phone says
_"Voting closed before your score was submitted."_ — never a false success.

Closing voting never submits anything. A voter who chose a number but did not
lock it in has their choice discarded and sees "Voting has closed"; no vote is
recorded. If a lock-in and your close cross in flight, the server decides: a
vote committed while voting was still open counts, and anything arriving after
is refused.

One vote per phone per act, and it cannot be changed. The console shows
accepted votes, the weighted mean and how many phones are connected.

Close voting before changing the act.

---

## Judge scoring

Each judge opens their private link on their own device.

**OPEN ALL** opens scoring for every judge who has not already submitted;
**CLOSE ALL** closes it. **OPEN** / **CLOSE** per judge do the same for one.
A submitted score cannot be reopened.

The judge matrix shows three independent things per judge: whether they are
**CONNECTED**, whether scoring is **OPEN**, and whether a score is **LOCKED**.
A judge can be offline with scoring open; that is not an error, they simply
have not loaded the page.

Judges type a number. Anything from 0 to 10 counts as typed. Values outside
that range are accepted and tapered by the server towards a bound, and the
console shows both what was typed and the score that counts. This is a
deliberate, documented part of the scoring model.

---

## Scoreboard and reactions

**SCOREBOARD** shows the audience mean and each judge's tile. The act's final
score is _not_ on the projector until you press **REVEAL**; it is not sent to
any public surface before that, so it cannot leak.

**Reactions** — when enabled, phones can tap reaction buttons and a light lane
of them floats across the projector. They are sampled, not counted one by one,
so the hall's phones cost the show almost nothing. Reactions are suppressed
during EMERGENCY and under blackout. **CLEAR PROJECTOR REACTIONS** empties the
lane immediately.

---

## HOLD, INTERMISSION, BLACK and EMERGENCY

Output priority is absolute:

```
EMERGENCY   >   BLACKOUT   >   the ordinary display mode
```

**HOLD** — "please stand by". One press (**HOLD · PLEASE STAND BY**, or the
`H` key). The show underneath is preserved; **RETURN TO SHOW** goes back to
exactly the mode you were in. The current act, scores and voting are
untouched.

**INTERMISSION** — a break graphic with your own message (_SETUP → PUBLIC
TEXT_). It is an ordinary display mode: it changes nothing about the current
act, the scores or whether voting is open.

**BLACK SCREEN** — a true black screen: `#000`, no graphic, no text, no
footer, no cursor, no reactions. It is an **override**, not a display mode.
While it is on, nothing uncovers it: not switching to FINAL RESULTS, not
PERFORMANCE, not the scoreboard, not a cue, not STOP ALL MEDIA. Only pressing
BLACK again, or emergency policy, restores the picture. The console header
shows `SCREEN BLACKED OUT` the whole time it is on.

Blackout never touches sound. Audio keeps playing behind a black screen.

**EMERGENCY** — two presses, deliberately. **ARM EMERGENCY** first, then
**BLACK SCREEN NOW** or **EMERGENCY TEXT NOW** (or **CANCEL**). It takes the
highest priority, pauses anything playing, suppresses reactions, and shows
either pure black or your emergency text (_SETUP → PUBLIC TEXT_). While it is
active you can switch between **BLACK** and **TEXT**. It erases nothing: acts,
scores and results are all intact. **RETURN TO SHOW** goes back to the mode you
were in; **RESUME** in the media console restarts what was paused.

---

## Finalising results

An act's result has three states:

- **INCOMPLETE** — something is missing. The console says what: which judges
  have not scored, or that the audience result is missing.
- **PROVISIONAL** — every configured input is in. The number is live and could
  still move if a late vote arrives.
- **FINALISED** — frozen. The score, its inputs, the weighting, the formula
  version and the act's name as it stood are all recorded permanently.

**FINALISE** freezes the current act's result. **REVEAL** puts the number on
the projector and the phones; **HIDE** takes it back off.

Only a finalised result can be revealed, and only a finalised result can be
ranked. A frozen result is never recalculated: changing the weighting
afterwards, or renaming a performer, cannot alter a published result or move a
rank.

The **RESULTS** view lists every act. Any act not in the ranking is listed with
the reason:

- `scoring complete — press FINALISE`
- `judge 3 has not scored` (or the list of judges)
- `audience result incomplete`
- `no judge panel configured`
- `W/D` — withdrawn

---

## Final Results and ties

Ranking is **dense**. Equal scores share a rank and the next different score
takes the very next number.

| Scores             | Ranks            |
| ------------------ | ---------------- |
| 9.8, 9.8, 9.5, 9.2 | 1, 1, 2, 3       |
| 9.9, 9.6, 9.6, 9.3 | 1, 2, 2, 3       |
| 8.4 ×5, then 8.3   | 1, 1, 1, 1, 1, 2 |

The podium is the top three **rank numbers**, not the top three acts. Two
joint firsts still leave a second and a third on the podium — four acts on a
three-place podium. Five acts tied at the top are all first, and the next
distinct score is second.

Ties are decided on the stored score, exactly. Two scores that both display as
"8.00" are two ranks if the stored numbers differ; nothing invents a winner
between genuinely equal scores.

Reveal is yours to control (_RESULTS_):

- **LEADERBOARD** — the whole ranking.
- **STAGED** — revealed from last place upwards, one rank at a time with
  **REVEAL NEXT PLACE**. A tie group always appears whole. **RESET** starts
  again from the bottom.
- **TOP THREE** — the top three rank numbers.
- **WINNER** — rank 1 only, however many acts that is.
- **HIDDEN** — nothing public.

Switch the projector to **FINAL RESULTS** to put the current stage on screen.

---

## Deleting an act

_ACTS & CUES → act → **DELETE ACT**._

Deleting is two steps. The first asks the server what deleting this act would
really destroy, and shows it:

- the act and its cues
- every audience vote cast for it
- every judge score submitted for it
- its finalised result, if it has one — **it leaves the rankings**
- the uploaded files only this act uses, which are deleted from storage
- the uploaded files another act also uses, which are **kept**

You then type `DELETE ACT` to confirm. Everything happens in one transaction:
either all of it is gone or none of it is, and no half-deleted act can be left
behind. Deleting the current act also clears the current selection.

Two conditions stop a deletion, and no confirmation can override them:

- audience voting is open for that act — close voting first
- media is playing for that act — stop it first

Deleting the same act twice is safe: the second attempt reports that it is
already gone rather than doing anything.

**Storage.** A file only this act used is deleted from storage with it. A file
shared with another act stays. If storage refuses the deletion, the act is still
deleted and the console tells you the file is outstanding — use **RETRY MEDIA
CLEANUP** under _SETUP & PREFLIGHT → DANGER_. Nothing is ever reported as
cleaned when it is not.

The operational log keeps its record that the act was deleted, and what it
contained. Show history is append-only and is never rewritten.

---

## Resetting the whole show

_SETUP & PREFLIGHT → 04 / DANGER → **RESET ENTIRE SHOW…**_

This is the between-events control. It returns the event to a clean, ready state
without making you set it up again.

**It clears:** every act, every cue, every uploaded file, every audience vote and
aggregate, every judge score, every finalised result and ranking snapshot, the
current act, the display mode, the voting and reveal state, and the projector
pairing code. The projector returns to the lobby with nothing playing and no
blackout.

**It keeps:** the event name and tagline, the theme, the typeface, the public
intermission and emergency text, the judge panel and the judges' links, and the
audience/judge weighting. Paired displays stay paired — a screen already trusted
in the hall should not need re-pairing because the running order changed. Your
operator sign-in is untouched.

**It never touches** the administrator account, deployment secrets, Cloudflare
configuration or any platform asset. This is not a factory reset.

The confirmation is deliberate: pressing **RESET ENTIRE SHOW…** opens a warning,
and the destructive button stays disabled until you type either the event's own
name or `RESET`.

Afterwards the console reports what actually happened, including whether every
media file really left storage. If storage refused, the reset has still fully
happened and the outstanding files are retryable work — the console says so
rather than claiming a clean bucket.

---

## Orphaned media

_SETUP & PREFLIGHT → 04 / DANGER → **FIND ORPHANED MEDIA**_

An orphan is uploaded media the show no longer has any use for. The sweep looks
in both directions, because leaks happen in both:

- **A record with nothing referencing it** — a file no act and no cue points at
  any more.
- **Bytes with no record at all** — a file whose database row was already
  deleted while the storage delete failed and was swallowed by an older version
  of this software. Nothing in the database can reveal these, so the sweep asks
  storage directly what it is holding.

Scanning is safe: it changes nothing and reports the count and total size.
**DELETE … FILES** then removes them from storage.

Orphan status comes from the database's own references and from storage itself,
never from a filename. The show's uploads live under their own storage prefix;
cached typefaces and every platform and deployment asset live outside it and can
never appear in this list.

**RETRY MEDIA CLEANUP** works through anything storage refused earlier, from any
deletion or reset. It is safe to press at any time and does nothing when there
is nothing outstanding.

---

## Help inside the console

The last item in the console's navigation is **? HELP & OPERATOR GUIDE**. It
renders this manual inside the app, with a contents rail and a search box, so
the guide is available on the night without another device.

Opening it changes nothing: it sends no command and touches no show state.

---

## Common problems

**The projector says "Pair this display".**
Its session was revoked or expired. Generate a code and pair again. It takes
about ten seconds and needs no reload.

**The projector says "Display not authorised".**
The server refused its credential. Generate a fresh code and pair again.

**No sound in the hall; the console says AUDIO NOT ARMED.**
Go to the projector machine and press **ENABLE AUDIO & ENTER SHOW** on its
screen. Nothing on the console can do this.

**Media is silent after reloading the projector mid-act.**
The projector holds media rather than restarting a track from the top behind a
performer. The console says so. Press **RESUME** to continue, or **REPLAY
BACKING AUDIO** to restart the track.

**A cue shows MISSING MEDIA or INCOMPATIBLE MEDIA.**
Its file was deleted or is the wrong kind (a video where an image is expected).
Re-upload it or fix the cue.

**"Close audience voting before changing the current act."**
Exactly that. Close voting first.

**FINALISE is greyed out.**
The result is incomplete. The line above it says which judges or which
audience result is missing.

**An act is missing from the final results.**
Open **RESULTS**; it is listed with its reason.

**DELETE ACT says voting is open or media is playing.**
It is protecting a live act. Close voting, or press STOP ALL MEDIA, then delete.

**The console says media files are still pending in storage.**
Storage refused a deletion. The database is already correct; press **RETRY MEDIA
CLEANUP** under _SETUP & PREFLIGHT → DANGER_. Nothing is lost.

**The screen is black and nothing brings it back.**
That is blackout working as designed. Press **BLACK** again. The console
header shows `SCREEN BLACKED OUT` whenever it is on.

**The console says the control link is not live.**
It reconnects by itself. The show state is on the server, so nothing is lost.
If it stays `UNAUTHORISED`, sign out and in again.

**A judge lost their link.**
_SETUP → JUDGE LINKS → ROTATE._ The new link is shown once; the old one dies
immediately.

---

## Emergency recovery

**Something is happening in the hall.** Press **ARM EMERGENCY**, then
**BLACK SCREEN NOW** or **EMERGENCY TEXT NOW**. Sound pauses, reactions stop,
and the screen goes to black or to your emergency message. Nothing is lost.
When it is over, **RETURN TO SHOW** and then **RESUME**.

**Something is on screen that must not be.** **BLACK SCREEN**. Nothing can
uncover it until you press it again.

**Media is misbehaving.** **STOP ALL MEDIA**. Every transport stops; the
projector returns to its display graphics. Blackout, if on, stays on.

**The projector machine has died.** Open `/projector` on a replacement
machine, generate a new code, pair it, press **ENABLE AUDIO & ENTER SHOW**.
The show state is on the server; the new display picks up mid-show.

**The console machine has died.** Open `/admin` on another machine and sign
in. The show is unaffected: the projector keeps showing what it was showing.

**A result was finalised by mistake.** It is frozen on purpose and there is no
undo for a single act. The only reset is _SETUP & PREFLIGHT → 02 / SCORING →
`RESET SCORING`_, which erases every vote, judge score and finalised result for
the whole show. Do not use it during a show unless you mean it.

**Start completely fresh.** _SETUP & PREFLIGHT → 04 / DANGER → RESET ENTIRE
SHOW…_, then type the event name or `RESET`. This erases every act, cue, media
file, vote, score and result, and keeps your event name, theme, typeface and
judge panel. There is no undo. See
[Resetting the whole show](#resetting-the-whole-show).

---

## Developer and deployment notes

### Stack

React 19 and TypeScript on the client; one Cloudflare Worker serving a
SQLite-backed Durable Object (`ShowCoordinator`) plus static assets; R2 for
media bytes. No runtime dependencies beyond React.

| Area               | Where                                                  |
| ------------------ | ------------------------------------------------------ |
| Shared vocabulary  | `shared/` — domain, protocol, scoring, ranking, themes |
| Server             | `worker/` — coordinator, state machine, schema, auth   |
| Client surfaces    | `src/surfaces/`, `src/admin/`, `src/projector/`        |
| Tests              | `test/` (`test/load/` runs separately)                 |
| Architecture notes | `docs/architecture.md`                                 |
| Deployment runbook | `docs/deployment.md`                                   |

### Commands

```bash
npm ci
npm run dev          # local dev server on :5173
npm run test         # vitest, in the Workers runtime
npm run typecheck    # tsc -b
npm run lint         # eslint
npm run build        # tsc -b && vite build
npm run deploy       # build then wrangler deploy
npm run test:load    # load and chaos harness
```

Local secrets go in `.dev.vars` (never committed); see `.dev.vars.example`. In
production they are Worker secrets. `docs/deployment.md` is the full runbook.

### Things worth knowing before changing anything

- **The server is authoritative.** Clients hold a projection and a revision.
  Every operator command carries the revision it expected; a stale one is
  rejected rather than applied. Commands are idempotent by command ID.
- **Projections are the security boundary.** Internal notes, operator labels,
  judge tokens and unrevealed scores are removed server-side, never hidden by a
  client. Audience phones get a narrower act than the projector does.
- **Schema migrations are append-only and never edited after shipping.** A
  version number records that a migration _ran_, not what it contained, so
  editing one silently fixes new installations and leaves existing ones broken.
  Migration 13 exists precisely to repair a database left that way.
- **Blackout is an output override**, not a display mode, and lives on the
  runtime state. Precedence is EMERGENCY > BLACKOUT > display mode, decided in
  one place (`src/projector/scene.ts`).
- **Derived cues** (`origin = 'SIMPLE'`) are generated from an act's
  presentation and regenerated on every act save. Cues an operator wrote
  (`MANUAL`) are never touched.
- **Themes are semantic tokens only.** No component assumes what sits on a
  colour; `test/themes.test.ts` asserts WCAG AA on every pairing a component is
  allowed to draw, for every theme, in both the web and projector palettes.
- **Audio arming is a projector-side gesture.** It can never be triggered
  remotely, and `armed` is set only after a real unlock succeeds.
- **Media spans two systems that cannot commit together.** The rule is fixed and
  one-directional: SQLite is made correct first, and every object that must
  still leave R2 is recorded in `media_cleanup_queue` as retryable work. A row
  never points at an object that is already gone, and an object that should be
  gone is never silently forgotten. `worker/media-cleanup.ts` owns this, and
  "referenced" is decided from cue references and the act columns that name an
  asset — never from a filename or an object key.
- **The operator guide is the README.** `src/admin/HelpPanel.tsx` parses it into
  a typed tree and renders React elements; there is no HTML path, so document
  content cannot execute. It is a lazy chunk and never reaches `/vote`.
- **`test/admin-controls.test.ts` discovers the console's controls from the
  source** rather than a hand-kept list, and fails if a control sends a command
  the server does not implement, if a server command has no control, or if a
  rendered button has no action.

Made by Tim Lin.

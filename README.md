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
11. [The act media library](#the-act-media-library) and [Backing audio](#backing-audio)
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
23. [Generating a test show](#generating-a-test-show) and [Orphaned media](#orphaned-media)
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
8. **Build the running order** — acts, their media libraries, backing audio
   (_ACTS & MEDIA_).
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

The panel's status — `PAIRED`, `CONNECTED`, `AUDIO ARMED` — is pushed live from
the coordinator the moment it changes; nothing here polls or guesses.

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
enough. It works on the **first** press: both browser unlocks happen inside
the click itself, before anything else, which is what browsers require.

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

_ACTS & MEDIA._ Each act has:

| Field              | Who sees it                                     |
| ------------------ | ----------------------------------------------- |
| Performers         | Projector and phones according to display rules |
| Group name         | Projector and phones when supplied              |
| School year        | Projector and phones                            |
| Act name           | Projector and phones                            |
| Act type           | Projector (and phones with the act name)        |
| Public description | Projector. Phones only if you switch it on.     |
| Act image          | Projector. Phones only if you switch it on.     |
| Internal notes     | **You only.** Never sent to any public surface. |

**MOVE UP / MOVE DOWN** set the running order. **SELECT FOR SHOW** makes an
act current. **DELETE ACT** opens a summary of exactly what would be destroyed;
see [Deleting an act](#deleting-an-act).

### Soloists and groups

Every act has an ordered performer list. Use **+ ADD PERFORMER** for duos,
bands, dance crews and large ensembles; up to 64 members are retained as
separate records and can be edited or removed individually. **Group name** is
optional: a multi-person act does not need one, and supplying one never removes
the member names.

The advanced **Projector performer display** defaults to **Automatic**. A solo
shows the person's name; a short unnamed group shows its names; a named group
shows the group name with a readable member line; a large named group shows the
group name and a performer count; a large unnamed group shows `Ensemble · N
performers`. Automatic considers the length of the rendered member line as
well as the raw count. The editor preview shows the chosen result. Explicit
overrides can show only the group name, group plus members, member names, or a
performer count.

### On audience phones

_Advanced settings → On audience phones._ Phones always receive the act name,
the public performer/group identity and the year or cohort. Three switches
control the rest:

- `Show description on audience phones` — off by default.
- `Show act image on audience phones` — off by default.
- `Show full member list to audience` — off by default. When off, the server
  sends only the identity and count needed to represent the act; internal
  member rows are not sent to the phone.

When a switch is off, the server does not send that field at all; it is not
hidden in the phone, it is absent. Stage media — performance visuals and
backing audio — is never sent to phones under any setting.

### Appearance override

_Advanced settings → Appearance._ An act can be drawn in another curated theme
or typeface while it is current; the projector and the phones follow it, the
console does not. Only curated themes and typefaces the show has already
cached are offered, so an override can never produce an unreadable pairing.
`Inherit` (the default) means the show's own setting.

---

## The act media library

_ACTS & MEDIA → act → Act media library._

Every act has **one** media library, and it is the only place files are
uploaded. Drop images, audio or video on it — several at once if you like — or
click it to choose files. Each file becomes a typed entry showing its kind,
filename, duration or dimensions, size, a **READY** badge once its metadata
has been read, and a badge for every place the act uses it (`ACT IMAGE`,
`BACKING AUDIO`, `PERFORMANCE VISUAL`, `CUE`). Click an entry to preview it.

Everything below points at entries in this library by name. Nothing is ever
uploaded twice, and nothing has its own separate uploader:

| Slot               | Chooses from                    |
| ------------------ | ------------------------------- |
| Act image          | images in the library           |
| Performance visual | images or videos in the library |
| Backing audio      | audio (or video) in the library |
| Advanced cues      | any entry of the matching kind  |

A file that another act also uses is marked `SHARED`; a file uploaded before
libraries existed, or shared deliberately, is a `SHOW FILE` and appears in the
library of every act that uses it. **DELETE** removes a file from storage and
is only available while nothing uses it. Deleting an act removes the files
only it used or owned; shared files stay.

Files can be added while the act is still being created. They wait in the
form, can already be chosen for the act image, performance visual or backing
audio, and are uploaded into the new act's library the moment **ADD TO
RUNNING ORDER** is pressed. A file whose upload fails stays listed with the
reason and a **RETRY UPLOAD** button; the act itself is never left half-made.

---

## Backing audio

_Act media library, then Presentation → Backing audio._

Add the track to the act's media library (while creating the act or later),
then choose it under **Backing audio**. Backing audio is only ever a choice
from the library — there is no second uploader for it — and you do not build a
cue for it. Then choose when it starts:

- **Automatically, when PERFORMANCE begins** — the GO into PERFORMANCE starts
  the track. This is what most acts want.
- **Manually, when the operator presses GO on the cue** — the track is loaded
  and waiting; you press **GO** on the PERFORMANCE cue when the performer is
  ready.

The backing track is a channel of its own. Changing the visual, blacking the
screen or stopping the visual never silences it. Only **STOP ALL MEDIA**, the
GO into SCORING (by default), a cue that stops audio, or EMERGENCY does.

---

## The performance screen

Every act already has a finished performance screen. You do not have to supply
anything for an act to look right on the projector.

**Automatic** — the act's name, the performer and the year or group, centred
and sized to read from the back of a hall. If the act has an image it appears
behind the text as a restrained wash. The layout is proportional and holds at
every projector shape.

**An image or a video from the library** — choose it under **Performance
visual**. It replaces the whole automatic screen.

- Images are shown **whole**. They keep their aspect ratio, are never
  stretched or distorted, and are letterboxed or pillarboxed against the
  theme's own background. `Show the whole image` is the default.
- `Crop to fill the screen` is available when you deliberately want the image
  to bleed to the edges, and will cut off part of it.
- Videos likewise keep their aspect ratio and use the screen without
  distortion.

Backing audio is independent of all of this: an act can have a custom visual
and no audio, audio and the automatic screen, both, or neither.

---

## Simple Show Flow and advanced cues

For an ordinary act the whole show is four steps, one **GO** each:

1. **ACT CARD** — the performer is announced.
2. **PERFORMANCE** — the performance screen (automatic or chosen) comes up and,
   if the act asked for it, the backing track starts.
3. **SCORING** — the performance media ends, the act card returns and the
   judges are opened.
4. **SCOREBOARD** — the scores.

The next **GO** moves to the next act's card. See
[Running an act](#running-an-act) for what GO does and does not do.

The software builds the media cue for step 2 from the act's Presentation
settings. It appears in the cue stack labelled `PERFORMANCE` with an `AUTO`
badge, always first, and is rebuilt whenever you change those settings. You
cannot edit or delete it from the cue editor — change the act instead.

**Advanced cues** (a disclosure at the bottom of the act) is the full engine,
unchanged, for acts that need it: multi-step sequences, title cards, slide
runs, separate visual and audio operations, pause, resume, replay, seek, stop,
black and clear. Every cue chooses its media from the act's library; there is
no second upload path. Your own cues are never touched by the derivation and
run after the derived one. Tick images in the library and **ADD … AS
SEQUENTIAL CUES** to make a slide run in one press.

Most acts never need to open it.

---

## Running an act

The **SHOW** view is the live console.

**Choosing the act** — click it in the running order, or use **← Previous** /
**Next →** (also the left and right arrow keys). Withdrawn acts are skipped by
Previous/Next but can still be selected deliberately. You cannot change the act
while audience voting is open, and the console asks for confirmation if media
is playing.

**GO** — the one control for an ordinary act. The button always says what it is
about to do (`PERFORMANCE`, `SCORING`, `NEXT ACT · …`) and, when it cannot,
why (`Close audience voting before moving to the next act`). Pressing it
performs the whole step:

| GO into         | What happens                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| **ACT CARD**    | The act card is shown. From nothing selected, GO selects the first act.                                       |
| **PERFORMANCE** | The performance visual comes up; the backing track starts if the act asked for it.                            |
| **SCORING**     | Performance media stops, the act card returns, judges are opened. Audience voting opens only if you allow it. |
| **SCOREBOARD**  | The scores are shown.                                                                                         |
| **NEXT ACT**    | The next act's card. Refused while audience voting is open; refused at the end of the running order.          |

The four step buttons beside GO jump straight to a step. _SETUP & PREFLIGHT →
02b / SHOW FLOW_ decides what GO may do on its own: stopping media on SCORING,
opening judges on SCORING, opening audience voting on SCORING (off by default,
because it is public and cannot be undone for the act), and whether SCOREBOARD
is a step of its own.

**Always explicit, never done by GO:** OPEN and CLOSE AUDIENCE VOTING (unless
you turned the policy on), BLACK, STOP ALL MEDIA, HOLD, EMERGENCY, FINALISE,
REVEAL and FINAL RESULTS.

**Display mode** — LOBBY, ACT CARD, PERFORMANCE, SCOREBOARD, INTERMISSION,
FINAL RESULTS remain available for anything the flow does not cover. `P` is a
shortcut for PERFORMANCE, `H` for HOLD.

**Media transport** — the advanced and recovery controls, one command at a
time; the console waits for the projector to acknowledge before accepting
another, so a double click cannot fire twice.

| Control                     | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| **GO** (cue stack)          | Runs the selected cue: visual up, backing track from the top. |
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

**Status bar** — `PROJECTOR CONNECTED · AUDIO ARMED` (or `PAIRED · NOT
CONNECTED`, `NOT PAIRED`, `AUDIO NOT ARMED`) is live from the coordinator's own
sockets and sessions. Paired means a display holds a credential; connected
means its socket is open now; armed means that connected display has unlocked
sound. They are three different facts and the console never infers one from
another.

---

## Audience voting

Phones reach the show by scanning the QR code on the LOBBY screen, or by
opening `/vote`. The page is responsive: a phone, a tablet or a laptop each get
a layout that fits.

**OPEN AUDIENCE VOTING** (confirmed, because it is public) lets phones score
the current act 0–10. **CLOSE AUDIENCE VOTING** ends it.

How a phone vote works, exactly:

1. The voter taps a number. The phone says _"Selected 8 — not submitted yet"_.
2. They press **LOCK IN 8** and confirm. Only then is the vote sent.
3. Only the server decides whether a vote counts.
4. The phone shows the score as locked only after the server accepts it.

**A selection is not a vote.** Closing voting discards any score a phone had
selected but had not locked in, and sends nothing. A late request cannot quote
the close transition to gain an exception. The phone says _"Voting closed"_;
if an explicit request lost the server race it says _"Voting closed before
your score was submitted."_

If a lock-in and your close cross in flight, the server decides: a vote
committed while voting was still open counts, and anything the server orders
after CLOSE is refused.

One vote per phone per act, and it cannot be changed. The console shows
accepted votes, the weighted mean and how many phones are connected.

Close voting before changing the act. CLOSE itself produces no vote traffic.

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

Judges enter a value, not necessarily a plain decimal. The scoring page has a
compact scientific keypad and the field accepts plain-text mathematics in the
way a calculator or WolframAlpha would read it: `8.5`, `pi`, `e`, `1e6`,
`infinity`, `sqrt(81)`, `sin(pi/2)`, `(7+3)/2`, `2^3`, `log(100)`, `exp(2)`,
`5!`, `sum from k=1 to 10 of k^2` or `integral from 0 to pi of sin(x) dx`.
Nothing is ever executed as code: a closed parser reads the expression and
refuses anything else with a plain reason.

Two numbers are shown to the judge. The **Effective Score** is the numeric
value the entry evaluates to before the show's scoring transformation is
applied. Anything from 0 to 10 counts as is; values outside that range are
tapered by the server towards a bound (infinity counts as 15, negative
infinity as −5), and the page says what the entry will count as when that
differs. An entry richer than a plain number or constant is typeset as
mathematics on the judge's page, in the console's judge matrix and on the
projector scoreboard, with the value it evaluated to beside it.

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

### When nothing is eligible yet

Until at least one act has been finalised there is nothing to rank, so every
stage except HIDDEN is disabled and **PUT FINAL RESULTS ON PROJECTOR** stays
shut. An empty results board in front of an audience is worse than no results
board at all.

The panel tells you why rather than leaving you with a dead button. It names
the next thing to do — typically _"4 acts are fully scored and waiting for
FINALISE"_ — and the table underneath gives the exact reason for each act:
which judges have not scored, whether the audience result is missing, or that
scoring is complete and only FINALISE remains. Hovering a disabled control
repeats the reason.

---

## Deleting an act

_ACTS & MEDIA → act → **DELETE ACT**._

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

This returns the event to a safe, empty running state while keeping the venue
setup ready for the next event.

**It clears:** every act and cue; every uploaded and generated media file
(from storage too); every audience vote and aggregate, judge score, finalised
result and ranking snapshot; the current act, display mode, show-flow step,
voting and reveal state; every temporary projector pairing code; and any
generated test show and its seed.

**It keeps:** the event name, short name, tagline and public messages; the
theme and typeface; reactions; the judge panel and its links; audience/judge
weighting; GO behaviour; and established projector sessions. The projector and
judge devices stay paired but immediately receive the empty lobby state.

**It never touches** the administrator account or your sign-in, deployment
secrets, Cloudflare configuration, cached typefaces or any platform asset.
`RESET ENTIRE SHOW` is a between-events data reset, not a factory reset of the
installation or its venue configuration.

The confirmation is deliberate: pressing **RESET ENTIRE SHOW…** opens a warning,
and the destructive button stays disabled until you type either the event's own
name or `RESET`.

Afterwards the console reports what actually happened, including whether every
media file really left storage. If storage refused, the reset has still fully
happened and the outstanding files are retryable work — the console says so
rather than claiming a clean bucket.

---

## Clearing votes and scores

**For one act** — in LIVE SCORING on the SHOW view, **CLEAR VOTES & SCORES…**
removes the current act's audience votes, judge scores and any finalised
result, so it can be scored again from nothing; the RESULTS view has a
**CLEAR** button on every act's row for the same thing. Type **CLEAR** in the
sheet to confirm. If the act is the one on stage, its voting closes and a
revealed result is hidden. Other acts are untouched.

**For the whole show** — _SETUP & PREFLIGHT → 04 / DANGER →
**RESET ALL VOTES & SCORES…**_ does the same for every act at once (type
**RESET VOTES**). Acts, performers, media, cues, judge links and settings all
stay.

Changing the current act is always allowed, including to an act that has
already been finalised; the one exception is while audience voting is open,
which must be closed first so no phone can vote for the wrong act. The
console says so on screen: **← Previous** and **Next →** are disabled with a
note, and pressing an act row shows the reason as a notification.

## Notifications

Anything the show refuses — a command that is not allowed right now, a
console that has fallen a step behind the coordinator, a file that would not
upload — appears as a notification at the bottom of the console, never as a
browser alert. It dismisses itself after a few seconds or on **DISMISS**.
Risky actions such as changing act while media plays, or opening audience
voting, ask you to press the same control again within a few seconds rather
than opening a dialog.

---

## Analytics

At the very bottom of the SHOW view, **ANALYTICS** is a collapsed panel that
reports on request: connected phones, judges and projectors (and whether the
projector's audio is armed), votes for the current act and the show, the
revision and display state, socket counters since the coordinator started,
projector media and cache state, R2 storage by namespace, database size and
schema version, and the most recent refused commands and media errors.
Nothing is polled; press **REQUEST ANALYTICS** (or **RE-LIST STORAGE** to
bypass the 45-second storage cache).

---

## Generating a test show

_SETUP & PREFLIGHT → 04 / DANGER → **GENERATE TEST SHOW…**_

Fills the show with a procedurally generated evening — acts, tiny synthetic
media fixtures, audience votes, judge scores and results, at a random point in
a random scenario — so every screen can be checked with realistic data before
doors, without typing anything in.

Each press draws a new eight-character **seed** and a scenario; the console
shows both, and typing the same seed later reproduces the same show exactly.
Scenarios are weighted towards the end of an evening (completed show, near
end, tie-heavy, a judge who has not scored) because that is where rankings,
reveals and final results live; mid-show, early, sparse and heavy audiences,
media-heavy, long text, edge scoring inputs and deliberately broken media are
all in the pool and can be pinned from the list.

Generation **replaces** the current show data and asks for one clear
confirmation that says so; it never appends invented acts to a real running
order. Generated acts include soloists, named groups and unnamed groups. Your event name, theme,
typeface and GO behaviour are kept; the judge panel is replaced by the
scenario's. Everything generated is tagged and stored under its own namespace,
so **RESET ENTIRE SHOW** removes all of it.

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

The small round **? HELP** button in the bottom-left corner of the console
opens this manual in an overlay, with a contents rail and a search box, so the
guide is available on the night without another device and without leaving
the view you are working in. **CLOSE** returns you exactly where you were.

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
  remotely, and `armed` is set only after a real unlock succeeds. Both
  gesture-sensitive calls (`AudioContext.resume()` and the audio element's
  `play()`) are issued synchronously in the click's call stack, before the
  first `await`; awaiting between them is what made the first click fail.
- **The show flow is a derived, deterministic state machine**
  (`computeFlow` in `worker/show-state.ts`). GO performs exactly what the
  console said it would, or refuses with the reason the console already shows.
  Dangerous actions are never implied by a step unless the show's stored GO
  policy allows them.
- **Voting requires explicit consent.** Selecting a score is client-local.
  CLOSE discards it without a request, and the transaction order of an explicit
  LOCK IN versus CLOSE is authoritative. Nothing is accepted after CLOSE.
- **Presence is authoritative.** Paired (a session row), connected (a socket
  attachment) and armed (recorded on the projector's attachment from its own
  report) are three facts computed from the coordinator's own state and pushed
  as `connection_count`; the console never infers them from telemetry.
- **Media has ownership and references.** `media_assets.act_id` says whose
  library a file is in; `assetReferences()` says who uses it. Ownership decides
  where a file appears, references decide whether it may be deleted, and
  generated test fixtures carry `generated_test` and live under `test-shows/`.
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

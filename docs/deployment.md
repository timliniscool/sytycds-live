# Deploying SYTYCDS Live to Cloudflare

This guide takes a clean Windows machine to a running production show. Every
command runs in **PowerShell** from the repository folder unless stated. It
was written against Wrangler 4.130 and the Cloudflare Vite plugin 1.54; if a
command's output differs from what is described here, trust the tool's output
and its `--help` over this page.

## What gets deployed

One Cloudflare Worker (`sytycds-live`) serves everything:

| Piece            | Where it is configured                              | Notes                                                                  |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| Worker code      | `worker/index.ts` via `wrangler.jsonc` `main`       | Built by Vite; Wrangler deploys from `dist/sytycds_live/wrangler.json` |
| Frontend assets  | `wrangler.jsonc` `assets`                           | Built to `dist/client`; SPA fallback; `/api/*` runs the Worker first   |
| Show coordinator | `wrangler.jsonc` `durable_objects` + `exports`      | One SQLite-backed Durable Object, class `ShowCoordinator`              |
| Media storage    | `wrangler.jsonc` `r2_buckets` (`MEDIA`)             | Bucket `sytycds-media`; created once, below                            |
| Canonical origin | `wrangler.jsonc` `vars.PUBLIC_ORIGIN`               | Plain variable; empty means "use the browser's own origin"             |
| Admin account    | Worker secrets `ADMIN_USERNAME`, `ADMIN_PASSWORD`   | Verified server-side; never in the repo                                |
| Font catalogue   | Worker secret `GOOGLE_FONTS_API_KEY`                | Optional; required only to search/select Google Fonts                  |
| Projector access | One-time code and HttpOnly projector session        | Generated in admin; no deployment token                                |
| Security headers | `public/_headers` (assets), `worker/index.ts` (API) | CSP, frame denial, nosniff, no-store on API                            |

Local development and production differ only by where these values come
from: `.dev.vars` locally (never committed), Wrangler secrets and
`wrangler.jsonc` in production. There are no generated IDs to paste anywhere;
Durable Object and R2 bindings are by name.

## 1. Install

Requirements: Node 22.12 or newer and npm 11 or newer, Git, and a Cloudflare
account on a plan that includes Durable Objects (Workers Paid).

```powershell
winget install OpenJS.NodeJS.LTS Git.Git
node --version   # v22.12 or newer
git clone https://github.com/timliniscool/sytycds-live.git
cd sytycds-live
npm ci
```

## 2. Authenticate Wrangler

```powershell
npx wrangler login
npx wrangler whoami
```

`wrangler login` opens a browser; approve the request. `whoami` should print
your account. Wrangler is a dev dependency, so `npx wrangler` always uses the
pinned version.

## 3. Create the media bucket (once)

```powershell
npx wrangler r2 bucket create sytycds-media
```

The name must match `bucket_name` in `wrangler.jsonc`. Nothing else about R2
needs configuring; the Worker writes and reads objects through the binding.
Operator/projector media uses authenticated `/api/media/*` routes. The narrow
`/api/public/media/:assetId` route serves only a non-deleted image currently
selected as an act's public image.

## 4. Set the secrets (once, or whenever you rotate them)

Choose the administrative username and generate a long random password. In
PowerShell, this produces a suitable password:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

Store both values as Worker secrets. Each command prompts for the value; paste
it and press Enter. The Google Fonts key is optional.

```powershell
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GOOGLE_FONTS_API_KEY
```

The operator types `ADMIN_USERNAME` and `ADMIN_PASSWORD` into `/admin`. On the
first successful login the coordinator derives and stores a salted PBKDF2
verifier. Later credential changes use the authenticated credential-rotation
operation, which invalidates other sessions; changing deployment secrets alone
does not overwrite the stored verifier. Projectors are paired from the admin
console with an expiring one-time code, so there is no projector secret to
distribute. Secrets are encrypted by Cloudflare and are not visible in the
dashboard afterwards.

`ADMIN_ACCESS_TOKEN` remains a deployment-only compatibility input for an
existing installation upgrading from the earlier token login. It is treated as
the bootstrap password and should be replaced by `ADMIN_PASSWORD`, then removed.

The first `secret put` on a brand-new Worker may ask to create the Worker;
answer yes.

## 5. Set the canonical origin

Open `wrangler.jsonc` and set `PUBLIC_ORIGIN` to the exact HTTPS origin the
audience will use, with no path:

```jsonc
"vars": {
  "PUBLIC_ORIGIN": "https://sytycds-live.<your-subdomain>.workers.dev",
},
```

Use your custom domain instead if you attach one (Workers → your Worker →
Settings → Domains & Routes). The projector's lobby QR points at
`PUBLIC_ORIGIN/vote`. Leaving it empty is fine for a first smoke test: the QR
then uses whatever origin the projector browser opened.

Cookies are marked `Secure` automatically on HTTPS; `workers.dev` and custom
domains are always HTTPS.

## 6. First deployment

```powershell
npm run deploy
```

This runs the type check, the Vite build (client assets and Worker), then
`wrangler deploy`. Wrangler reads the build's generated config from
`dist/sytycds_live/wrangler.json`, uploads the assets, and prints the
`https://sytycds-live.<subdomain>.workers.dev` URL.

Database schema: there is nothing to run. The coordinator applies its
migrations itself the first time it is touched (`worker/schema.ts`), and
re-applies only what is new on later deployments. The Durable Object class is
declared with SQLite storage in `wrangler.jsonc` (`exports.ShowCoordinator`),
which is the current Wrangler shape and needs no migration block.

## 7. Provision the show

1. Open `https://<your-origin>/admin` and sign in with the configured username
   and password.
2. The console reports that no show exists and shows **Create the show**.
   Enter the title and optional tagline and press **CREATE SHOW**.
3. In **SETUP & PREFLIGHT**, save the title, short name, tagline, curated
   theme, and font. Configure one to eight judges and the audience allocation,
   then copy or scan any newly issued judge links; credentials are shown once.
   Scoring configuration locks as soon as votes, scores, or final results
   exist. Its explicit reset permanently removes that scoring data.
4. Generate an eight-digit projector code, pair `/projector`, and confirm the
   live status. Reissuing the code invalidates the unused previous code.
5. In **ACTS & CUES**, add the running order, upload media, choose public act
   images, and build the ordered cue stacks. Browser-extracted duration and
   dimensions appear in the media library; referenced files cannot be deleted.
6. Set intermission and emergency text, then run **RUN PREFLIGHT**. Fix anything
   marked FAILURE. Warnings are advisory.

## 8. Later deployments

```powershell
git pull
npm ci
npm test
npm run deploy
```

Deploying does not touch the show's data: the Durable Object's SQLite storage
persists across deployments and any new schema migration runs on first
request. Open clients reconnect on their own and receive a fresh snapshot.

Do not deploy during a performance. If you must, the audience and judge pages
survive it; the projector should be checked afterwards.

## 9. Rollback

Every deployment is a version. To go back to the previous one:

```powershell
npx wrangler versions list
npx wrangler rollback
```

`rollback` prompts for the version to restore and redeploys it in seconds.
Rolling back code never rolls back data; a schema migration that has already
run stays applied, so only roll back to a version that understands the current
schema (in practice: the previous deployment).

## 10. Production smoke test

Run this after every deployment, before doors. Use a laptop for the console
and projector and a phone for the audience and judge checks.

1. **Health.** `curl https://<origin>/api/health` returns `{"ok":true,…}` with
   the current `schemaVersion`.
2. **Admin.** `/admin` signs in; the status bar shows `LIVE` and a revision.
   A wrong secret is refused; five wrong attempts are blocked for 15 minutes.
3. **Projector.** Open `/projector`; it shows the pairing keypad. Generate a
   code in admin, enter the eight digits, and confirm the paired display shows
   the lobby QR. Press **ARM SHOW / ENABLE AUDIO**. Press `D` to confirm `link
live` and the media cache count, then `D` again. Reload the projector and
   confirm its HttpOnly session survives.
4. **Audience.** Scan the QR with a phone; `/vote` loads and shows the show
   title. Select an act, open voting in the console, cast a vote, confirm the
   phone locks and the console count rises. A second attempt on the same phone
   is refused.
5. **WebSocket.** Turn the phone's Wi-Fi off and on; the page shows
   _Reconnecting…_ then recovers without a reload and still shows the lock.
6. **Judge.** Open one judge link on a phone, open judge scoring in the
   console, submit `8.5`; the phone shows LOCKED and the console matrix shows
   the score. A second submission is refused.
7. **Media.** Play a cue containing an image and backing audio; the projector
   shows both and the console reads _Projector acknowledged STARTED_. Advance
   to a visual-only cue and confirm the audio continues. Exercise pause,
   resume, replay, seek, black, and stop all. Reload the projector and confirm
   authoritative media state recovers.
8. **Reveal.** With every required active judge score and, when audience weight
   is non-zero, at least one vote, FINALISE then REVEAL on SCOREBOARD; the
   projector counts up the final score and the phone shows it. HIDE removes it
   from both.
9. **Preflight.** In SETUP & PREFLIGHT, **RUN PREFLIGHT** reads READY or READY
   WITH WARNINGS.
10. **Safety and reactions.** With media playing, enter HOLD and restore it;
    then trigger both emergency presentations and verify audio pauses. Tap each
    audience reaction repeatedly, confirm local animation remains immediate,
    disable reactions in setup, and verify projector reactions stop. Use
    **CLEAR LIVE REACTIONS** before doors.

If any step fails, check `npx wrangler tail` in a second terminal while
repeating it; the Worker logs each refused request and uncaught error.

## Useful commands

```powershell
npx wrangler tail                    # live logs
npx wrangler secret list             # names only, never values
npx wrangler r2 object list sytycds-media
npx wrangler deploy --dry-run        # validate config and build without deploying
```

## Local development

```powershell
New-Item .dev.vars                     # add ADMIN_USERNAME and ADMIN_PASSWORD
npm run dev
```

Vite runs the Worker in the local Workers runtime with a local Durable Object
and a local R2 bucket. `.dev.vars` is read when the server starts; restart it
after editing. Open `http://localhost:5173/admin`, create the show, and use
the console exactly as in production. `test/show-lifecycle.test.ts` also runs a
fresh isolated Durable Object from zero acts through final reveal, including
HOLD, emergency, black, resume, and stop-all recovery checks.

For a disposable dress-rehearsal database and R2 store, use `npm run
dev:fresh`. Nothing from that process is retained after it stops. This mode
still reads `.dev.vars` for the local admin credential.

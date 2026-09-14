# Deploying SYTYCDS to Cloudflare

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
| Operator secret  | Worker secret `ADMIN_ACCESS_TOKEN`                  | Never in the repo                                                      |
| Projector token  | Worker secret `PROJECTOR_ACCESS_TOKEN`              | Never in the repo                                                      |
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
needs configuring; the Worker writes and reads objects through the binding and
media is only ever served through `/api/media/*`.

## 4. Set the secrets (once, or whenever you rotate them)

Generate two long random values and keep them somewhere safe. In PowerShell:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

Run that twice, then store each value as a Worker secret. Each command prompts
for the value; paste it and press Enter.

```powershell
npx wrangler secret put ADMIN_ACCESS_TOKEN
npx wrangler secret put PROJECTOR_ACCESS_TOKEN
```

`ADMIN_ACCESS_TOKEN` is what the operator types into `/admin`.
`PROJECTOR_ACCESS_TOKEN` goes in the projector URL as `?token=…`. Secrets are
stored encrypted by Cloudflare and are not visible in the dashboard afterwards.

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

1. Open `https://<your-origin>/admin` and sign in with `ADMIN_ACCESS_TOKEN`.
2. The console reports that no show exists and shows **Create the show**.
   Enter the title and optional tagline and press **CREATE SHOW**.
3. In **SETUP & PREFLIGHT**, issue the four judge links (**JUDGE LINKS**) and
   copy or scan them now; they are shown once. Set the intermission and
   emergency text.
4. Add acts and cues, upload media, and run **RUN PREFLIGHT**. Fix anything
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
3. **Projector.** `/projector?token=<PROJECTOR_ACCESS_TOKEN>` shows the lobby
   with the QR; without the token it shows _Display not authorised_. Press
   **ARM SHOW / ENABLE AUDIO**. Press `D` to confirm `link live` and the media
   cache count, then `D` again.
4. **Audience.** Scan the QR with a phone; `/vote` loads and shows the show
   title. Select an act, open voting in the console, cast a vote, confirm the
   phone locks and the console count rises. A second attempt on the same phone
   is refused.
5. **WebSocket.** Turn the phone's Wi-Fi off and on; the page shows
   _Reconnecting…_ then recovers without a reload and still shows the lock.
6. **Judge.** Open one judge link on a phone, open judge scoring in the
   console, submit `8.5`; the phone shows LOCKED and the console matrix shows
   the score. A second submission is refused.
7. **Media.** Play an image cue; the projector shows it and the console reads
   _Projector acknowledged STARTED_. Reload the projector; the image returns.
8. **Reveal.** With four judge scores and at least one vote, FINALISE then
   REVEAL on SCOREBOARD; the projector counts up the final score and the phone
   shows it. HIDE removes it from both.
9. **Preflight.** In SETUP & PREFLIGHT, **RUN PREFLIGHT** reads READY or READY
   WITH WARNINGS.

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
Copy-Item .dev.vars.example .dev.vars   # then edit the two tokens
npm run dev
```

Vite runs the Worker in the local Workers runtime with a local Durable Object
and a local R2 bucket. `.dev.vars` is read when the server starts; restart it
after editing. Open `http://localhost:5173/admin`, create the show, and use
the console exactly as in production.

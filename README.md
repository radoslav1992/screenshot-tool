# Screenify

Screenshots as a service — an installable PWA built with **Astro** and deployed entirely on
**Cloudflare**. Paste a URL, pick a device and a capture mode, get pixel-perfect files back, in the
app or through the API.

Built from the `Screenify SaaS Design` handoff: seven mobile-first screens (landing, sign up, new
capture, library, API keys, pricing, account), recreated as real pages rather than as a static mockup.

---

## Stack

| Concern          | Choice                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Framework        | Astro 7, `output: 'server'`, `@astrojs/cloudflare`                 |
| Runtime          | Cloudflare Workers                                                 |
| Database         | Cloudflare D1 (`DB`) — users, sessions, API keys, captures, usage   |
| File storage     | Cloudflare R2 (`SHOTS`) — rendered PNG/JPG/PDF files                |
| Rate limiting    | Cloudflare KV (`RATE`) — per-key, per-minute counters               |
| Rendering        | Cloudflare Browser Rendering (`BROWSER`), REST API as a fallback    |
| UI               | Hand-written CSS design system, no UI framework, no client router   |

There is no build-time UI framework and no runtime npm dependency beyond Astro and
`@cloudflare/puppeteer` — pages ship as HTML with a few kilobytes of progressive-enhancement JS.

## Screens

| Route              | Screen                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `/`                | Landing — hero, URL bar, three capture modes, developer teaser     |
| `/signup`, `/login`| Email + password auth                                              |
| `/app`             | New capture — URL, device, mode, advanced options                  |
| `/app/library`     | Library with mode filters and per-capture previews                 |
| `/app/c/:id`       | Capture detail — files, share link, delete                         |
| `/app/api`         | API keys, quick start, parameters                                  |
| `/app/account`     | Profile, plan, usage meter, install prompt, sign out               |
| `/pricing`         | Free / Pro / Business, monthly-yearly toggle                       |
| `/docs`            | Full API reference                                                 |
| `/offline`         | Service-worker offline fallback                                    |

## Capture modes

- **visible** — one frame of the viewport.
- **fullpage** — the whole document as one tall image (capped at 20,000 CSS px).
- **series** — viewport-sized frames from top to bottom; each frame counts against quota.

Devices: `desktop` 1440×900 @2x, `tablet` 834×1194 @2x, `mobile` 390×844 @3x, or any custom
`width`×`height` (Pro and above). Formats: `png`, `jpg`, `pdf` (`pdf` not valid with `series`).

---

## Local development

```bash
npm install
npm run db:migrate:local     # apply migrations to the local D1 instance
npm run dev                  # http://localhost:4321
```

`astro dev` runs the app inside workerd via `@cloudflare/vite-plugin`, so D1, R2 and KV all work
locally against `.wrangler/state`.

**Local rendering:** Miniflare launches a real Chrome for the `BROWSER` binding. If it is running as
root it needs `--no-sandbox`, which Miniflare adds when `CI` is set:

```bash
CI=1 npm run dev
```

## Deploying

`wrangler.jsonc` already points at the project's Cloudflare resources: D1 `screenify-data`, R2
`screenify-screenshots`, and the `RATE` KV namespace. To recreate them in another account:

```bash
npx wrangler d1 create screenify-data
npx wrangler r2 bucket create screenify-screenshots
npx wrangler kv namespace create RATE
```

1. Apply the schema to the remote database:

   ```bash
   npm run db:migrate
   ```

   No wrangler CLI access? Paste `db/apply-manually.sql` into the D1 console (Cloudflare dashboard →
   Storage & Databases → D1 → *screenify-data* → Console) and run it. It contains the same schema
   plus the `d1_migrations` bookkeeping row, so a later `npm run db:migrate` reports *No migrations
   to apply* rather than trying to create the tables twice. It is idempotent — safe to re-run.

2. Set `PUBLIC_SITE_URL` in `wrangler.jsonc` to your deployed origin, then:

   ```bash
   npm run deploy
   ```

### Checking a deployment

`GET /api/health` reports whether each binding is wired up and whether the D1 schema exists. It
returns booleans and setup hints only — no data, no credentials.

```bash
curl https://your-domain/api/health
# {"ok":true,"checks":{"database":{"ok":true,…},"storage":{"ok":true},"kv":{"ok":true},
#  "renderer":{"ok":true,"engine":"binding"}}}
```

A deployment whose schema was never applied answers `503` with `missing: ["users", …]`, and signup
fails with `schema_missing` rather than a generic error. Server-side causes are logged with a
context tag, so `npx wrangler tail` shows lines like `[signup] D1_ERROR: no such table: users`.

Browser Rendering requires a **paid Workers plan**. Without the binding, set `CF_ACCOUNT_ID` and
`CF_API_TOKEN` (a token with *Browser Rendering: Edit*) as secrets to use the REST fallback — it
covers `visible`, `fullpage` and `pdf`, but not `series`.

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
```

---

## API

Bearer-authenticated, JSON or form-encoded, same validation as the UI.

```bash
curl https://your-domain/v1/capture \
  -H "Authorization: Bearer $SCREENIFY_KEY" \
  -d url="https://stripe.com/pricing" \
  -d device="mobile" \
  -d mode="fullpage"
```

| Endpoint                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `POST /v1/capture`          | Create a capture (`async=1` returns 202 + polls)  |
| `GET /v1/captures`          | List captures, newest first                       |
| `GET /v1/captures/:id`      | Fetch one capture                                 |
| `DELETE /v1/captures/:id`   | Delete a capture and its files                    |
| `GET /v1/account`           | Plan and quota                                    |

Files are served from `/f/:captureId/:name?t=<shareToken>`; add `&download=1` for a download
disposition. API access is a Pro/Business entitlement; rate limits are 60 and 300 req/min.

Full reference: `/docs`.

## PWA

- `public/manifest.webmanifest` — standalone display, maskable icons, app shortcuts, and a
  `share_target` so sharing a URL to Screenify opens the capture form pre-filled.
- `public/sw.js` — cache-first for fonts/icons/hashed assets, network-first for documents with an
  offline fallback. API responses and rendered files are never cached.
- Install prompt is surfaced as a row on the Account screen.
- Fonts (Sora, IBM Plex Sans/Mono) are self-hosted latin subsets, so the shell renders offline and
  no third-party request is made.

## Security notes

- Passwords: PBKDF2-SHA256, 210k iterations, per-user salt.
- Sessions: 32-byte tokens, stored as SHA-256 hashes, `HttpOnly` + `SameSite=Lax` + `Secure`.
- API keys: stored as SHA-256 hashes; the secret is shown once at creation.
- CSRF: session cookies are `SameSite=Lax` and every cookie-authenticated mutation also checks the
  `Origin` header. Astro's global `checkOrigin` is off so that `curl -d …` works against `/v1`,
  which is bearer-authenticated and therefore has no CSRF surface.
- SSRF: capture URLs are restricted to http/https and rejected for loopback, RFC1918, link-local,
  CGNAT and `.local`/`.internal` hosts, plus anything in `CAPTURE_HOST_DENYLIST`.
  This is a hostname-level check — it does not resolve DNS, so a public hostname pointing at a
  private address is not caught. Rendering happens inside Cloudflare's Browser Rendering
  infrastructure rather than on your network, which is what makes that acceptable here.

## Not included

- **Billing.** Plans and quotas are enforced, but no payment provider is wired up; plan changes are
  manual (`UPDATE users SET plan='pro'`). The pricing page says so.
- **OAuth.** The Google and GitHub buttons from the design are present and tell the user social
  sign-in is not connected yet. Email and password work fully.
- **Team seats** advertised on the Business plan.

## Project layout

```
migrations/           D1 migrations, applied by wrangler
db/                   the same schema as one paste-into-the-console script
public/               manifest, service worker, icons, self-hosted fonts
src/components/       Logo, TabBar, ShotCard, CodeBlock
src/layouts/          Base (head + PWA wiring), AppShell (tab bar)
src/lib/              auth, captures, renderer, capture-options, plans, http, rate-limit
src/pages/            screens, /api/* (session), /v1/* (bearer), /f/* (files)
src/scripts/          progressive-enhancement modules
src/styles/           design tokens + component CSS, @font-face
src/middleware.ts     session loading, route guards, security headers
```

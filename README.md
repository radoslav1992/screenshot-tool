# Easy Screen Capture

Screenshots as a service — an installable PWA built with **Astro** and deployed entirely on
**Cloudflare**. Paste a URL, pick a device and a capture mode, get pixel-perfect files back, in the
app or through the API.

Built from the original design handoff: seven mobile-first screens (landing, sign up, new
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
| `/pricing`         | Free / Plus / Pro / Business, monthly-yearly toggle, Stripe checkout|
| `/docs`            | Full API reference                                                 |
| `/offline`         | Service-worker offline fallback                                    |

## Capture modes

- **visible** — one frame of the viewport.
- **fullpage** — the whole document as one tall image (capped at 20,000 CSS px).
- **series** — viewport-sized frames from top to bottom; each frame counts against quota.

Devices: `desktop` 1440×900 @2x, `tablet` 834×1194 @2x, `mobile` 390×844 @3x, or any custom
`width`×`height` (paid plans). Tablet and mobile load as Safari on an iPad and an iPhone (user agent,
touch and mobile viewport together); desktop keeps the rendering browser's own Chrome user agent. Output frames land on an exact pixel size without cropping:
`instagram-post` 1080×1350, `instagram-square` 1080×1080, `instagram-story` 1080×1920, `og-image`
1200×630, `x-post` 1600×900 — named presets, so they are available on every plan. Formats: `png`,
`jpg`, `pdf` (`pdf` not valid with `series`).

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

**Tests:** `npm test` runs every offline check (rendering, redaction, consent, diffs, projects, monitors,
SEO rules, retention, push, Apple, commerce, capture engine, auth and billing, billing error pages, D1
schema files, signup attribution and referrals, web push and the install hint, Pro trials) against SQLite and local Chromium; no real email, webhook, Stripe or push call is made.
Before changing an API the iOS app uses, also run
`BASE=http://localhost:4321 npm run mobile:check` against a dev server: it drives the API exactly like the
app (manual session cookie, JSON, no Origin header, redirects not followed) and asserts every response
shape the app decodes.

## Deploying

`wrangler.jsonc` already points at the project's Cloudflare resources: D1 `screenify-data`, R2
`screenify-screenshots`, the `RATE` KV namespace, and the Worker named `screenify`.

Those names predate the rename to Easy Screen Capture and are deliberately left alone — they are
live resources holding real data. Renaming the Worker creates a *second* Worker and orphans the
deployed one along with its secrets, custom domain and cron trigger; the bucket and database names
cannot be changed at all without copying the contents to new ones. None of them is ever shown to a
user. See *Renaming the infrastructure* below if you want to do it anyway.

To recreate them in another account:

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
   Storage & Databases → D1 → *screenify-data* → Console) and run it. It is for a **fresh, empty
   database**: the schema every migration through `0012` adds up to, plus the `d1_migrations`
   bookkeeping rows, so a later `npm run db:migrate` reports *No migrations to apply* rather than
   trying to create the tables twice. It is idempotent — safe to re-run.

   **Upgrading a database that already has an older schema?** Not with `apply-manually.sql`: it
   creates missing tables but cannot add columns to existing ones, and it would still record every
   migration as applied. Paste the upgrade file for each migration the database is missing, in order:

   | File | Migration |
   | --- | --- |
   | `db/0002-upgrade.sql` | email verification and retention |
   | `db/0003-upgrade.sql` | Stripe billing |
   | `db/0004-upgrade.sql` | watches |
   | `db/0005-upgrade.sql` | page facts |
   | `db/0006-upgrade.sql` | projects and review reports |
   | `db/0007-upgrade.sql` | collaboration and digests |
   | `db/0008-upgrade.sql` | monitor noise settings |
   | `db/0009-upgrade.sql` | monitor rules and alert retries |
   | `db/0010-upgrade.sql` | mobile push |
   | `db/0011-upgrade.sql` | Apple subscriptions and the free quota |
   | `db/0012-upgrade.sql` | watch-run index |
   | `db/0013-upgrade.sql` | background captures and batches |
   | `db/0014-upgrade.sql` | pinned baselines |
   | `db/0015-upgrade.sql` | report sign-off and branding |
   | `db/0016-upgrade.sql` | smart checks for rule-based monitors |
   | `db/0017-upgrade.sql` | signup sources, referrals and bonus screenshots |
   | `db/0018-upgrade.sql` | web push for browsers and the installed app |
   | `db/0019-upgrade.sql` | 14-day Pro trials |
   | `db/0020-upgrade.sql` | site health: uptime, SSL, domain and broken-link checks |
   | `db/0022-upgrade.sql` | which client approval pinned a monitor baseline |

   `GET /api/health` lists which of these the database is missing (see *Checking a deployment*).
   Each file ends by recording its migration in `d1_migrations`, so `npm run db:migrate` skips it
   afterwards.

   The D1 console flattens pasted SQL onto one line, which makes `--` comments swallow everything
   after them. `apply-manually.sql` and the upgrade files are therefore comment-free and safe to
   paste as-is; `npm test` checks that, and that each one builds exactly what its migrations do.
   `ALTER TABLE … ADD COLUMN` is not idempotent in SQLite: if a re-run reports *duplicate column
   name*, that column is already there — drop that line and run the rest. The exceptions are 0002
   and 0011, which also update existing rows (0002 marks existing accounts as confirmed, 0011 gives
   existing free accounts the grandfathered 200-capture quota): if their first `ALTER` reports a
   duplicate column, that upgrade has already run, and running its `UPDATE` again would hand the
   same to every account created since.

2. Set `PUBLIC_SITE_URL` in `wrangler.jsonc` to your deployed origin, then:

   ```bash
   npm run deploy
   ```

### Checking a deployment

`GET /api/health` reports whether each binding is wired up and which D1 migrations the database
has. It returns booleans, schema object names and setup hints only — no data, no credentials.

```bash
curl https://your-domain/api/health
# {"ok":true,"checks":{"database":{"ok":true,…},"storage":{"ok":true},"kv":{"ok":true},
#  "renderer":{"ok":true,"engine":"binding"}},
#  "migrations":[{"name":"0001_init.sql","applied":true},…]}
```

A deployment whose schema was never applied answers `503` with `missing: ["users", …]`, and signup
fails with `schema_missing` rather than a generic error. Because production deploys before anyone
applies the migration that came with it, every later migration is checked too, by the tables,
columns and indexes it creates (listed in `src/lib/schema-manifest.ts`). One that is missing, or
only partly applied, also answers `503`, with an entry such as
`{"name":"0011_apple_lite.sql","applied":false,"missing":["apple_accounts","users.free_quota",…],"upgrade":"db/0011-upgrade.sql"}`
and a `database.detail` naming the upgrade files to paste, in order. Server-side causes are logged
with a context tag, so `npx wrangler tail` shows lines like `[signup] D1_ERROR: no such table: users`.

Browser Rendering requires a **paid Workers plan**. Without the binding, set `CF_ACCOUNT_ID` and
`CF_API_TOKEN` (a token with *Browser Rendering: Edit*) as secrets to use the REST fallback — it
covers `visible`, `fullpage` and `pdf`, but not `series`. Options only the binding can honour (`hide`,
`blur`, `redact_pii`, ignore regions, credentials, actions, `dark_mode`, `sizes`) are refused with
`501 unsupported_option` rather than silently dropped. When the binding exists but cannot be reached,
REST stands in only for captures that ask for none of those (and no ad blocking, consent handling or
facts, so a monitor's picture stays comparable); anything else answers a retryable
`503 browser_unavailable`.

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
```

### Checks before a deploy, and watching after it

Every push to `main` deploys straight to production, so `.github/workflows/ci.yml` runs what a contributor
runs — `npx astro check`, `npm test` (with the Chromium that matches `playwright-core`, through `CHROME_PATH`)
and `npm run build` — on every pull request and every push to `main`. To make a merge wait for it, add a
rule in **Settings → Rules → Rulesets** (or **Branches**) for `main` that requires the status check
**Typecheck, test and build**.

Once it is live, the service is watched from both sides:

- **From outside**, `.github/workflows/uptime.yml` runs every 30 minutes: the home page must answer `200`
  and `/api/health` must be `ok`, with the hourly sweep's heartbeat fresh. Three failures a minute apart fail
  the run, and GitHub emails whoever last changed its `cron:` line (**Settings → Notifications → Actions**
  decides how). If those emails do not arrive, edit that line once in GitHub's web editor to take them over.
- **From inside**, the hourly cron runs a self-check (`src/lib/ops-watchdog.ts`) that nobody's page view
  would catch: monitors more than two hours late, a capture queue that has stopped moving, most recent
  monitor checks failing on our side (browser limits, rate limits, an unreachable renderer), a required
  migration missing, or D1, R2 or KV unreachable. It emails each address in `OWNER_EMAILS` when that changes,
  again once a day while it stays broken, and once when it is all clear. With `OWNER_EMAILS` unset it only
  logs `[watchdog] …` lines.

The self-check leaves its time in KV, and `/api/health` reports it as `checks.scheduler`: stale after
2¼ hours means the cron itself has stopped, the one failure the self-check cannot email about. It is kept
out of the top-level `ok`, which stays about serving requests; the uptime workflow checks both.

---

## API

Bearer-authenticated, JSON or form-encoded, same validation as the UI.

```bash
curl https://your-domain/v1/capture \
  -H "Authorization: Bearer $ESC_API_KEY" \
  -d url="https://stripe.com/pricing" \
  -d device="mobile" \
  -d mode="fullpage"
```

| Endpoint                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `POST /v1/capture`          | Create a capture (`async=1` returns 202 + polls)  |
| `POST /v1/compare`          | Capture two pages and measure the difference      |
| `POST /v1/batch`            | Capture a list of URLs, or a whole sitemap        |
| `POST /v1/batches`          | Queue up to 500 pages to capture in the background |
| `GET /v1/batches`           | Recent background batches                         |
| `GET /v1/batches/:id`       | A batch's progress, items and finished captures   |
| `POST /v1/batches/:id`      | `action=cancel`: stop what has not started        |
| `GET /v1/captures`          | List captures, newest first                       |
| `GET /v1/captures/:id`      | Fetch one capture                                 |
| `DELETE /v1/captures/:id`   | Delete a capture and its files                    |
| `GET /v1/account`           | Plan and quota                                    |

Files are served from `/f/:captureId/:name?t=<shareToken>`; add `&download=1` for a download
disposition. API access is a Pro/Business entitlement; rate limits are 60 and 300 req/min.

Full reference: `/docs`.

## PWA

- `public/manifest.webmanifest` — standalone display, maskable icons, app shortcuts, and a
  `share_target` so sharing a URL to Easy Screen Capture opens the capture form pre-filled.
- `public/sw.js` — cache-first for fonts/icons/hashed assets, network-first for documents with an
  offline fallback. API responses and rendered files are never cached.
- Installing: Chromium's install prompt is a row on the Account screen, and a one-line hint on the capture
  screen (`/app`) and Monitors (`/app/watches`) offers the same prompt, or the Share → Add to Home Screen steps in
  iOS Safari. It is hidden in the installed app, in browsers that cannot install, and once closed on that device
  (remembered in `localStorage`). The logic is shared in `src/scripts/install.ts`; never on marketing pages.
- Change alerts as notifications: `sw.js` shows Web Push alerts and opens the monitor on a click — see *Web Push
  for browsers and the installed app* below.
- Fonts (Sora, IBM Plex Sans/Mono) are self-hosted latin subsets, so the shell renders offline and
  no third-party request is made.

## Abuse and cost controls

The free tier is generous (20 screenshots/month for new accounts; existing free accounts retain 200), so the limits that
matter are the ones protecting the render pool and storage rather than the monthly count.

- **Retention.** A cron trigger (`0 3 * * *`) sweeps captures past their plan's `historyDays`
  (free 7, Plus/Pro 30, Business 365), deleting the D1 rows and the R2 objects, and purging spent
  verification tokens and expired sessions. Each run is capped at 500 captures so a backlog is
  worked off over several nights rather than blowing a single invocation's budget.
  The handler lives in `src/worker.ts`, which re-exports the adapter's `fetch` and adds `scheduled`.
- **Burst limiting.** The monthly quota bounds the total; a per-user hourly limit bounds the burst
  (free 10/hour, Plus 60, Pro 120, Business 600), so one account cannot spend its allowance at once and
  monopolise the account's concurrent browsers — the genuinely scarce resource.
- **Browser sessions.** Every capture tries to connect to an already-running idle session before
  launching one, which is free — the session exists either way. Keeping sessions *warm* after a
  capture is not free and is off by default (`BROWSER_KEEP_ALIVE_MS=0`):

  | | |
  | --- | --- |
  | Launch skipped by reuse | ~3s |
  | Idle session billed at $0.09/browser-hour | $0.000025/s |
  | 60s idle session | $0.0015 — about 5× a whole full-page capture |

  So a warm session only pays for itself if the next capture arrives sooner than a launch takes —
  roughly **one capture every 3 seconds sustained**, or ~29,000/day. Below that it costs more than
  it saves. Set `BROWSER_KEEP_ALIVE_MS` (max 600000) once volume justifies it; the win at low volume
  is latency, not cost. If sessions are held open but not actually reused they accumulate against
  the concurrency cap, which surfaces as a `browser_unavailable` error naming the setting.

- **Free tools.** The public tools under `/tools` render without an account, so they have limits of their
  own: 5 renders per visitor a day, a daily cap across everyone (`FREE_TOOLS_DAILY_RENDERS`, default 300, `0`
  to switch them off), and they start only when the browser pool has sessions to spare. See *Free tools* below.

- **Email verification.** Optional and off by default. Set `REQUIRE_EMAIL_VERIFICATION=1` *and*
  configure a transport to require a confirmed address before capturing. The gate only engages when
  mail can actually be sent, so it can never lock accounts out of a deployment with no mailer. If a
  send fails, the link is written to the log so an operator can still complete the signup. Accounts
  that existed before the migration are grandfathered as verified.

- **Sending mail.** `EMAIL_FROM` sets the sender — an address, or `Name <address>`. Two transports,
  tried in that order:

  1. **Cloudflare Email Sending** (public beta), through the `EMAIL` binding. No API key: the Worker
     is authorised by the binding. Onboard the sending domain under *Email Service* in the dashboard
     and verify the sender address, **then** uncomment the `send_email` block in `wrangler.jsonc` —
     deploying the binding before the domain is onboarded can be rejected.
  2. **Resend** over REST, if the `RESEND_API_KEY` secret is set. Also the fallback when the binding
     is configured but rejects a send, which is what a half-finished domain onboarding looks like.

  With neither, nothing is sent and the verification link goes to the log. `/api/health` reports
  which transport is live and what it would send from.

- **Your own HTML.** `html` in place of `url` renders markup directly (`setContent`), up to 512 KB — OG images,
  social cards, receipts. Inline markup never passes through `assertPublicUrl`, because there is no address to
  check, so the renderer intercepts every subrequest and aborts private destinations instead: a page's own
  `<img src>` can point anywhere, and with no origin to compare against only the fetch itself can be judged.
  Needs the Browser Rendering binding; the REST fallback takes a URL and cannot do it.

- **Page facts.** `facts=1` returns a `page` object beside the files: title, description, canonical, OG and
  Twitter tags, headings, word count, link counts, JSON-LD types, CMS and framework, image-alt and form-label
  coverage, page weight, request count and load timings. Read from the rendered DOM — what a visitor got, not
  what the server shipped — and stored on the capture row as JSON.

  The derived half (`lib/page-facts.ts`) is adapted from `packages/shared-audit` in
  [radoslav1992/agency](https://github.com/radoslav1992/agency) (c1f5d68), where the same functions back the site
  analyzer and the research crawler. Kept string-in/value-out so `npm run facts:check` can exercise it with no
  browser and no network. The market-specific parts of that library — the Bulgarian page-role classifier, MX
  providers, hiring signals — were deliberately left behind.

- **Getting past what is in the way.** `dismiss_consent=1` clicks the first thing that looks like a consent
  button — an explicit id, then the common framework classes, then button text in five languages, only ever one
  of them, since clicking every match risks hitting "reject" after "accept". `actions` runs up to 10 steps of
  `click`, `wait_for`, `wait`, `scroll_to` and `type`, in either `verb:value;…` or JSON form. Deliberately not a
  scripting language: no expressions, no loops, nothing that turns a capture request into unbounded execution.
  A step that fails fails the request with `action_failed` naming the step.

- **Pages behind a login.** `headers`, `cookies` and `basic_auth` last for one capture and are never stored.
  `Host` and the hop-by-hop headers are refused — `Host` in particular would let a validated public URL be
  answered by a different origin than the one the SSRF check approved. Cookies are scoped to the captured
  host. Watches deliberately cannot carry credentials: keeping a customer's session cookie at rest needs an
  encryption key and a rotation story, and half of that is worse than none.

- **A list, or a whole sitemap.** `POST /v1/batch` (and `/api/batch`) takes `urls` or a `sitemap` URL, up to 25
  pages, sequentially — the session pool is the scarce resource and a parallel batch would starve everyone
  else's captures. Sitemap indexes are followed one level, no further; that way lies a crawler. The sitemap URL
  itself goes through the capture validator, and each URL it yields is validated again. The whole batch is
  charged against the hourly burst limit at once, otherwise a batch is the way around it. Anything larger goes
  to a background batch (below).

- **Slack and Discord alerts.** A watch webhook pointed at `hooks.slack.com` or Discord gets a message shaped
  for that app instead of raw JSON — one sentence and two links. Everything else, Zapier and n8n included,
  keeps the JSON payload. Host matching is exact, so `hooks.slack.com.evil.example` is not Slack.

- **Every size in one visit.** `sizes=desktop,tablet,mobile` shoots each viewport during a single page load,
  returning one file per device. One load rather than three: separate captures pay for three page loads, and a
  page that shows a cookie wall or an A/B variant on first visit does not behave the same way twice. Each file
  still counts against quota. Not valid with `mode=series` or `format=pdf`, which already mean several files.

- **Hiding and redacting.** `hide` and `blur` take CSS selectors (20 max); `redact_pii=1` walks the text nodes
  for emails, phone numbers, card numbers and IBANs and replaces the matches with covered spans. All of it runs
  in the page before the shutter, so the information is never in the file — a blur applied to finished pixels can
  be reversed. A redaction that fails fails the whole capture rather than quietly shipping an unredacted image.
  `npm run redact:check` drives the shipped function in local Chromium: emails, phones and cards go; a price of
  1999 and a year of 2019 stay.

- **What changed, in words.** A watch alert now carries a text diff alongside the percentage, and — where the
  Workers AI binding is present — one sentence saying what changed. Watch captures collect the page's visible
  text (capped at 8k) inside `facts` to make that possible. The diff is a set difference rather than a
  positional one, so a page that reorders its sections does not report every line as both added and removed.
  With no AI binding, or on any model failure, the alert falls back to the plain list of added and removed
  lines: an alert that arrives plain beats one that does not arrive.

  The `ai` binding is on in `wrangler.jsonc`; it uses the account's Workers AI, with nothing to create. An AI
  binding has no local implementation — with remote bindings on, the adapter proxies it to the real service and
  `astro build` and `astro dev` fail with *user auth missing api token* on any machine not logged into
  Cloudflare. So `astro.config.mjs` keeps remote bindings off unless `CLOUDFLARE_REMOTE_BINDINGS=1`: builds, dev
  servers and CI need no login, production gets the real binding at deploy time, and alerts made locally fall
  back to the plain list.

- **Compare two pages.** `POST /v1/compare` (and `/api/compare`) captures two URLs and measures how much of the
  picture differs, reusing the watch diff engine. Each side takes the usual capture parameters prefixed `a_` and
  `b_`; unprefixed keys apply to both. It costs two screenshots, refuses to start with fewer than two left, and
  draws two units from the burst limit rather than one.

- **Watches.** A saved capture that re-runs on a schedule and alerts when the page actually looks
  different. Every plan has them (`WATCH_LIMIT` and `WATCH_FREQUENCIES` in `plans.ts`): 3 on Free,
  weekly; 10 on Lite and 25 on Plus, daily or weekly; 100 on Pro and 300 on Business, down to hourly,
  and every 15 minutes (`quarter-hourly`) for rule-based watches. Weekly checks on Free's three cost at
  most about 12 screenshots a month, inside its 20.

  A visual watch's run is an ordinary capture and spends one screenshot from the monthly quota, counted
  separately as `via_watch` so a customer can see what ran without them. A rule-based watch reads its
  page first and renders only when that changed (see *Smart checks* below). The new capture is compared
  against the previous one and becomes the next baseline, so a watch reports "changed since last
  check" rather than drift from some distant original — unless the owner pins a baseline (see
  "Changed areas and pinned baselines" below). The retention sweep skips whatever a watch is
  currently using as its baseline — otherwise a weekly watch on the 7-day Free window could never
  compare anything.

  Comparison happens inside a Browser Rendering page (`lib/visual-diff.ts`): both images are drawn to
  canvases and the differing pixels counted, with a per-channel tolerance so compression and
  antialiasing do not read as a change, and downsampling above 2M pixels because the *share* of
  pixels that moved is just as accurate from a quarter of them. `npm run diff:check` runs that exact
  function in local Chromium against images whose answer is known in advance.

  The hourly cron runs every due watch; the minute cron also runs the 15-minute ones at :15, :30
  and :45, claimed under the same lease so the two never run one twice. Retention still runs once a day, gated on the
  03:00 UTC tick — `scheduled` cannot tell which expression woke it. Five consecutive failures pause
  a watch rather than spending quota for ever on a page that has moved.

  Watches are app-only for now (`/api/watches`, session-authenticated). Exposing them under `/v1`
  with bearer auth is the obvious next step.

- **Account deletion.** `DELETE /api/account`, from the account screen. It confirms with the
  password (or, for an account with none, the email address typed out), cancels any live Stripe
  subscription first — immediately, with no refund — then removes every R2 object under
  `captures/<user>/` and every row that names the user. Stripe invoices stay, because keeping them is
  a legal obligation; the webhook idempotency records stay too but stop naming the account.

## Security notes

- Passwords: PBKDF2-SHA256, 100k iterations, per-user salt. 100k is the Workers ceiling — the runtime
  throws above it, and the *local* runtime does not, so `/api/health` runs the real hash to catch it.
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

## Billing

Four plans: **Free** (200 shots/month, files carry an easyscreencapture.com mark), **Plus** $7 (500, no mark, PDF
and custom sizes), **Pro** $19 (2,000, API access), **Business** $79 (15,000).

Payments run on **Stripe Checkout**, called directly over REST — no SDK, no Node built-ins. The whole
feature is dormant until `STRIPE_SECRET_KEY` is set: the buy buttons do not render, `/api/billing/*`
answers `503`, and the app behaves exactly as it did before billing existed.

### Turning it on

1. Create the **products and recurring prices** — one monthly and one yearly per paid plan:

   ```bash
   STRIPE_SECRET_KEY=sk_test_… npm run stripe:setup
   ```

   The script reads the plan ladder straight out of `src/lib/plans.ts`, so the prices always match
   what the pricing page advertises. It is idempotent — every price carries a stable `lookup_key`
   (`esc_plus_monthly` and friends), which it looks up before creating anything, so a second run
   reports what exists rather than making duplicates. It prints the price ids formatted for the
   next step. Run it once per mode: Stripe's test and live worlds share nothing.

   Give every plan product a **tax code**: Stripe Managed Payments rejects checkout for a product
   without one (*Product tax code is required for Managed Payments*). With `STRIPE_TAX_CODE` set,
   setup puts it on new products and updates existing ones whose code is missing or different:

   ```bash
   STRIPE_SECRET_KEY=sk_test_… STRIPE_TAX_CODE=txcd_10103001 npm run stripe:setup
   ```

   `txcd_10103001` is SaaS for business use, `txcd_10103000` SaaS for personal use; check Stripe's
   Managed Payments eligibility list before choosing. `npm run stripe:check` fails for any plan
   product that still has none.

2. Add a webhook endpoint pointing at `https://<your-domain>/api/billing/webhook`, subscribed to
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`
   and `customer.subscription.deleted`. Copy its signing secret.
3. Enable the **customer portal** in Stripe (Settings → Billing → Customer portal) — the *Billing,
   card & invoices* row on the account screen opens it.
4. Set the secrets. Use secrets (or encrypted variables in the dashboard) rather than plain vars: a
   plain var declared in `wrangler.jsonc` is overwritten on every deploy, a secret is not.

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put STRIPE_PRICE_PLUS_MONTHLY      # …and _YEARLY
   npx wrangler secret put STRIPE_PRICE_PRO_MONTHLY       # …and _YEARLY
   npx wrangler secret put STRIPE_PRICE_BUSINESS_MONTHLY  # …and _YEARLY
   ```

   A plan with no price id configured is still listed on `/pricing` but is not purchasable, so you
   can launch one tier at a time. `GET /api/health` reports which ones are live under `billing`.

### When Stripe says no

A failed checkout or portal visit sends the customer back to `/pricing` or `/app/account` with a
short code (`?billing_error=checkout_unavailable`), and the page shows a fixed message for it from
`src/lib/billing-errors.ts`. Unknown codes get one generic message; nothing from the URL is ever
shown, so a crafted link cannot put words on the real pricing page. JSON callers keep
`{error:{type,message}}`.

When Stripe *rejects* the request (a 4xx — nearly always a dashboard setting, such as a product
with no tax code), the customer is told checkout isn't available and the site owner has been told,
and Stripe's own message goes to the log and by email to the operator: what Stripe said, the
request path, and the likely fix when the cause is a known one. At most one email per Stripe error
code per hour (throttled in the `RATE` KV, which fails open). The address is `BILLING_ALERT_EMAIL`,
falling back to the contact address in `src/lib/company.ts`; it needs a working mailer (see
*Sending mail*). Set it as a secret, since a deploy replaces plain-text variables with those in
`wrangler.jsonc`:

```bash
npx wrangler secret put BILLING_ALERT_EMAIL
```

`GET /api/billing/diagnose`, for the signed-in account owner, still shows Stripe's own wording for
a plan change that fails.

### Tax

Off unless `STRIPE_AUTOMATIC_TAX=1`. Activate Stripe Tax and set your origin address first
(Settings → Tax) — Stripe rejects a checkout session that asks for automatic tax on an account
that has not done that, which is exactly why this is opt-in rather than always on.

With it on, checkout gains three things that go together:

- `automatic_tax` works the rate out from the customer's address, so `billing_address_collection`
  becomes `required` — Stripe Tax has to know where it is taxing.
- `customer_update: { address: auto }` writes that address back onto the customer. Without it the
  address lives only on the checkout session, and every renewal after the first is untaxed.
- `tax_id_collection` gives a business the chance to enter a VAT number, which is what makes EU
  reverse charge work instead of charging VAT they then have to reclaim.

Let customers edit their address and tax id in the customer portal too (Settings → Billing →
Customer portal), or a company that moves or registers later has no way to correct it.

Prices are treated as tax-exclusive by default, so $7 becomes $7 + VAT. Set prices to tax-inclusive
in the Stripe dashboard if you would rather advertise a gross number — a normal choice for
consumer-facing EU pricing.

**Where you must register to collect is a question for an accountant.** Stripe Tax will tell you
where you have crossed a threshold (Settings → Tax → Monitoring); it will not register for you.

### The withdrawal right

Off unless `STRIPE_TOS_CONSENT=1`. Set a terms-of-service URL on the Stripe
account's public details first, or Stripe rejects the session — the same shape
of failure as automatic tax on an unconfigured account.

An EU consumer buying a digital service has fourteen days to withdraw. That
right *can* be waived, but only if the customer expressly asks for the service
to start immediately and acknowledges losing it, and the acknowledgement has to
be captured at the point of sale rather than written into the terms and assumed.
Without it, someone can buy the top plan, spend 15,000 captures and withdraw.

With the flag on, checkout shows a required checkbox and Stripe records the
acceptance against the session, which is the part that matters if it is ever
disputed. The wording is in `createCheckoutSession` — **have a lawyer read it
before it takes real money.** It is a reasonable draft of a standard
construction, not advice, and consumer law varies by country.

This does not cover chargebacks, which no wording prevents.

### Invoicing

Subscriptions invoice themselves — every renewal produces an invoice, and the customer portal
exposes the full history alongside the card and plan controls. Nothing extra to build. Set your
business name, support address, and terms/privacy links in Stripe's branding settings, because
those are what appear on the invoice PDF and the checkout page.

### How the plan actually changes

Stripe is the source of truth; the `users.plan` column mirrors it. Nothing about a plan changes on
the success redirect — only a **verified webhook** writes entitlements, so a forged return URL buys
nothing.

- Signatures are checked as HMAC-SHA256 over `<timestamp>.<raw body>` against the `v1` value in
  `Stripe-Signature`, compared in constant time, with Stripe's 5-minute timestamp tolerance. The body
  is read as text *before* parsing — re-serialising the JSON changes the bytes and every signature
  fails.
- Every event id is claimed in `billing_events` before it is applied, so Stripe's retries cannot
  replay an upgrade. If handling throws, the claim is released and a `500` invites the retry.
- `active` and `trialing` grant the plan. `past_due` keeps it (with a banner on the account screen)
  while Stripe retries the card. Anything else drops the account to Free.
- A cancelled subscription keeps its plan until `plan_period_end` — that is what was paid for.

### The free-plan mark

Free captures carry a small badge in the corner reading **easyscreencapture.com** — the domain
rather than the product name, because a screenshot is usually seen out of context and the domain is
the part someone can act on. It is injected into the page as a DOM element just before the
screenshot rather than composited onto the image afterwards: Workers have no image library, and
re-encoding a PNG in JS would cost more CPU than the capture itself. As a real element it also
scales with the device pixel ratio, so it stays crisp at 3x.

It is anchored `fixed` for `visible` and `series` captures (so every frame carries it) and `absolute`
at the document's bottom for `fullpage`, where a fixed element would land near the top of the
stitched image. It follows the account's plan and is not a request parameter — there is no way to ask
for an unmarked capture you have not paid for.

## Renaming the infrastructure

The app is Easy Screen Capture everywhere a user can see. The Cloudflare resources are still named
`screenify-*` because renaming them is a data migration, not a find-and-replace:

| Resource | To rename |
| --- | --- |
| Worker `screenify` | Deploy under the new name, move the custom domain and re-add every secret, confirm the cron fires, then delete the old Worker. Two Workers exist in between. |
| R2 `screenify-screenshots` | Create the new bucket, copy every object, switch the binding, delete the old one. Any capture whose files were missed 404s. |
| D1 `screenify-data` | Export, import into a new database, switch the binding. Anything written between export and switch is lost. |

None of it is visible to a customer, and each carries a real chance of losing files or sessions.
Worth doing only if the names bother you in the dashboard.

## Not included

- **OAuth.** The Google and GitHub buttons from the design are present and tell the user social
  sign-in is not connected yet. Email and password work fully.
- **Team seats** advertised on the Business plan.

## Project layout

```
migrations/           D1 migrations, applied by wrangler
db/                   console-pasteable schema (full) and per-migration upgrade scripts
public/               manifest, service worker, icons, self-hosted fonts
src/components/       Logo, TabBar, ShotCard, CodeBlock
src/layouts/          Base (head + PWA wiring), AppShell (tab bar)
src/lib/              auth, captures, renderer, capture-options, plans, billing, watermark, http
src/pages/            screens, /api/* (session), /v1/* (bearer), /f/* (files)
src/scripts/          progressive-enhancement modules
src/styles/           design tokens + component CSS, @font-face
src/middleware.ts     session loading, route guards, security headers
```


## Product direction and redesign

See [the product and growth plan](docs/PRODUCT-PLAN.md) for the agency positioning, shipped UX improvements, prioritized feature roadmap, validation milestones, and rollout checks. Run `npm run library:check` to verify owner-scoped search and pagination.


### Monitor health and schedule budgets

The Monitors page now shows capture success and average duration from retained captures in the last seven days, last successful checks, and the most recent alert status. Create/edit forms forecast aggregate scheduled usage before saving, including the remaining calendar-month allowance. Open a monitor to change its frequency; paused monitors stay paused when edited.

Comparison failures preserve the previous baseline and are recorded as errors. Email/webhook status is recorded per changed run; HTTP errors are failures and timeouts are unconfirmed. “Accepted by provider” is not proof of inbox delivery. Old runs have unknown notification status, and unconfirmed sends are not retried automatically. With migration 0009 applied, explicit failures receive up to two retries on later hourly scheduler runs.

No migration is required: versioned notification metadata uses the existing `watch_runs.detail` field and is decoded by `listRuns` and the dashboard. Direct SQL consumers should recognize the `esc-run-v1:` prefix. Rollbacks to older code will display that metadata as text.

Run `npm run monitor:check` with Node 22.13+ to test forecast boundaries, provider outcomes, SQLite-backed watch execution, and account isolation. Tests mock all external services and do not send email or webhooks.


### Monitor workflow update (0009)

Apply `migrations/0009_monitor_workflows.sql` before promoting this release in Cloudflare.
The three statements are additive and may be run separately in the D1 console. Existing capture data stays intact.
A successful Workers Build may only upload a version: manually promote the version associated with this commit to production.

- Library → Monitor screenshots: album covers, chronological comparisons, changed-only filtering and a screenshot gallery.
- In an album, select one or two comparisons and a project to create a private client report. Sharing remains an explicit action.
- Monitor setup: drag over the preview to watch one rectangle or ignore up to ten. Ignored areas require recapturing the preview, consuming another screenshot. Coordinates remain editable for keyboard use.
- Alert rules: visual threshold, page text changes, phrase appearance/disappearance, price numbers or selected-element text. Text rules require the Browser Rendering binding; CSS selection is edited as text. A newly selected element establishes its baseline on the next check. A missing element is an error, not a false change alert. Rectangles affect only visual comparison.
- Monitors → Import: up to 20 URLs or the first 20 same-origin URLs from a page sitemap. Sitemap indexes, redirects, DTDs and files above 512 KB are rejected. Existing URL/device pairs are skipped. Daily is the default. Imports respect monitor slots and the projected remaining/monthly screenshot budget; failures are listed separately. First baselines are captured on the next hourly scheduler tick.
- Explicit alert failures receive at most three total attempts, on the original run and later hourly ticks. Retries stop for paused/deleted monitors, expired captures, exhausted attempts, or runs older than 24 hours. Accepted and unknown outcomes are never resent. A process lost while sending is marked unknown to avoid duplicate delivery. No provider response bodies or webhook credentials are copied into the retry table.
- Use the existing Send test notification button on a monitor to verify configuration. Provider acceptance is not confirmation of inbox delivery.

The AI summary integration remains optional and configuration-dependent; this release does not enable an AI binding or change Stripe prices.

Validation: `npm run check`, `npm run workflows:check`, `npm run monitor:check`, `npm run library:check`, `npm run projects:check`, `npm run build`. Automated checks use SQLite and mocked external services; they do not send real alerts.


### SEO rules and real device identities (no migration)

- **SEO signals rule.** A monitor can alert when what search engines read changes: the title, meta
  description, canonical URL (resolved to absolute), robots `noindex`/`nofollow` from the robots and
  googlebot meta tags and the `X-Robots-Tag` header, the first visible `h1` and the count of them, hreflang
  alternates as a set, the Open Graph title/description/image, and the main document's HTTP status. All of
  them by default, or the ones ticked on the rule; the choice is a comma list in `monitor_rules.selector`
  (empty means all, including signals added later), so no column was added. The signals are read in the page
  only for SEO monitors and stored on the capture as `facts.seo`, next to the existing page facts.
- **What an alert says.** One line per change, joined by `; `: `HTTP status: 200 → 404; Robots: index →
  noindex; Title: "Old" → "New"`. A new noindex or a 4xx/5xx status comes first. Whitespace is collapsed; a
  canonical that differs only by a trailing slash, host case, a fragment or a protocol-relative form is the
  same URL; the X-Robots-Tag only counts when both captures saw the response. The webhook gets
  `rule: { kind: "seo", detail }`. Facts are redacted as before when `redact_pii` applies.
- **The first check records.** A baseline from before the rule has no `facts.seo`, so that check stores them
  and its history reads "SEO signals recorded; the next check compares them." — no alert. A baseline approved in
  monitor setup already records them. Bulk import can create SEO monitors (all signals).
- **Phones and tablets as Safari.** `mobile` sends an iPhone Safari user agent and `tablet` an iPad Safari
  one (the iPad's "mobile website" form: a default iPad sends the Mac string, which a server cannot tell from
  a desktop), with `isMobile` and `hasTouch` set together; the REST fallback sends the same `userAgent`.
  Safari was chosen because overriding the user agent drops Chrome's client hints, which Safari never sends.
  Desktop keeps the browser's own `HeadlessChrome` string: replacing it would drop those hints too and make
  the identity less consistent, and Browser Rendering's own headers identify every request regardless. With
  `sizes`, the page loads once as `device`.
- **Capture engine marker.** Every stored file records `engine` (`CAPTURE_ENGINE` in
  `src/lib/capture-engine.ts`, now 2) in the capture's `files` JSON; the API's file list is unchanged. A
  monitor whose baseline is from an older engine that a later change reaches (engine 2 reaches tablet and
  mobile) saves the new capture as its baseline without comparing: the run has `changed: 0`, no
  `baseline_capture_id`, the detail "Baseline refreshed after a capture engine update", and no email, push or
  webhook. Desktop monitors keep comparing. A future engine change adds an entry to `ENGINE_CHANGES`.

`npm run seo:check` covers the comparison, signal selection, extraction in local Chromium, first-check
recording and the engine refresh; `npm run capture:check` covers the device identities.

### Changed areas and pinned baselines (0014)

**Changed areas.** The page-side comparison (`lib/visual-diff-fn.ts`) marks changed pixels on a grid of
tiles while it counts them, clusters nearby tiles into boxes, merges boxes that touch and caps them at
eight. Boxes are fractions (0–1) of the after image. They come from the same per-pixel test as the
percentage, so ignore regions and hidden selectors — painted identically into both captures — never
produce one; the area a taller page added is a box, and a page that got shorter gets a band along its new
bottom edge. When a check meets its threshold the same page also draws a highlighted copy of the after
image (brand orange boxes with a thin dark edge, at most 1000 px wide and 3 megapixels, JPEG) and the
Worker stores it at `captures/<user>/<capture>/changes.jpg`.

- No migration: the boxes ride in the run's `esc-run-v1:` metadata (`decodeRunChanges`), and the
  highlight is served by the capture's token URL, `/f/<capture>/changes.jpg?t=…`.
- It is not in the capture's `files`, so `images` — what the iOS app downloads and shares — is unchanged.
  `deleteCapture` and the retention sweep delete it with its capture; account deletion takes the prefix.
- `GET /api/watches/:id` adds `regions` and `highlight_url` to every run. Alert emails say
  "Changed areas: N" and link the highlight; the JSON webhook adds `highlight_url` and `regions`; Slack,
  Teams, Google Chat and Discord messages link it. The monitor page, the library timeline and review
  reports created from monitor runs outline the boxes over the after image, with a "Show changes" toggle.

**Pinned baselines.** "Keep as baseline" on a monitor (or `POST /api/watches/:id` with
`{"action":"pin"}`, optionally `capture_id` of one of its earlier checks) makes every later check compare
against that capture until `{"action":"unpin"}`; no check replaces it. To keep one change from alerting
on every check after it, a pinned check alerts when the page first differs from the pinned version, and
again only when it also differs from the version last alerted about (a second comparison in the same
browser page, or the rule's own facts for text rules). Checks that still show the same difference are
recorded with `changed = 0`, their regions, and "No new change"; matching the pin again resets it.
Monitors gain `baseline_pinned`, `baseline_pinned_at` and `baseline_capture_id`. A pinned capture is still
the watch's baseline, so retention keeps it and deleting it answers `409 baseline_in_use`.
A capture engine change that reaches a pinned capture (see the engine marker above) refreshes the baseline
at the next check and releases the pin, saying so in the run, rather than keep a version nobody approved
pinned; a capture the engine has moved past cannot be pinned (`409 baseline_outdated`).

Pinning needs migration `0014_pinned_baseline.sql`, one nullable column on `watches`. Until it is
applied the column is probed and pinning stays hidden (`pin`/`unpin` answer `503 setup_required`), and
checks run exactly as before. Apply it with `npm run db:migrate`, or paste `db/0014-upgrade.sql` into
the D1 console. `npm run highlights:check` covers the clustering in Chromium and the check flow with and
without the column.

### Client approval pins the baseline (0022)

When a client approves a shared review report, every capture in it that one of the report owner's monitors
took becomes that monitor's pinned baseline, so later checks compare against exactly what was approved
(`pinApprovedCaptures` in `lib/approval-baseline.ts`, called by `POST /r/:token/signoff` once the decision
is saved).

- **Which monitor.** A capture is a monitor's when that monitor's check took it (`watch_runs.capture_id`) or
  it is or was its baseline (`watches.baseline_capture_id`, `watch_runs.baseline_capture_id`) — the test
  `pinBaseline` applies. Only monitors, runs and captures of the project's owner are read or written, so
  someone else's capture or monitor is never touched, even where a run names it.
- **Several from one monitor** (a before/after pair): the newest by `captures.created_at` is pinned, since
  approving accepts the "after". A monitor whose only capture is the "before" of a newer screenshot from
  elsewhere is not pinned: that would compare every check against the version the client moved away from.
- **Never fails a sign-off.** The decision is recorded first, and `pinBaseline`'s rules (`pinRefusal` in
  `lib/baseline-pin.ts`) skip a capture instead of throwing: its files are gone, it predates a capture engine
  update, its monitor was deleted, pinning is not set up (no 0014), or the write failed. Each skip has a reason.
- **Only `approved` pins.** Requesting changes and the owner's reset change nothing; an approval's pin stays until
  the owner unpins it, and a later approval of another report pins again. The same approval twice writes
  nothing the second time (the update is conditional), so the pinned-check alerting is not restarted.
- **Provenance.** Each pin an approval writes adds a `baseline_approvals` row (watch, capture, report, sign-off
  and `pinned_at`, exactly the `baseline_pinned_at` it wrote). The monitor page says "Pinned by client approval:
  Jane Doe approved “Homepage refresh” on 8 Oct 2026", with a link to the report, only while the baseline is
  still that capture with that pin time: a manual pin, an unpin or an engine refresh ends it.
  `GET /api/watches/:id` adds an optional `pinned_by_approval: {name, report_id, report_title, approved_at}` on
  the same rule; nothing else in the monitor JSON changes, so the iOS app decodes it as before.
- **Owner email.** On approval it lists each monitor whose baseline was pinned, with a link, says "Unpin it on
  the monitor page" to undo it, and lists any skipped and why. Plain text, as all mail here is.
- **Screens.** The shared page adds one neutral line beside Approve — "Approving makes these screenshots the
  reference that future checks compare against." — only when approving would pin at least one monitor; it names
  none. The owner's report page shows the same note, then "Pinned as the baseline on N monitors" linking to them
  (monitors now pinned to the capture the approval pins, whoever pinned it), and "Not pinned: …" while approved.

Migration `0022_baseline_approvals.sql` is optional. Without it an approval still pins (that needs only 0014),
and the monitor page and API just do not name the approval; without 0014 nothing is pinned and the shared page
says nothing about it. Apply it with `npm run db:migrate`, or paste `db/0022-upgrade.sql` into the D1 console.
Its rows go with their monitor, report or sign-off (`ON DELETE CASCADE`), and account deletion removes them by
name. `npm run approval:check` covers the mapping, newest-wins, owner isolation, every skip, idempotency,
provenance and what supersedes it, the email, the three pages rendered from their sources, account deletion,
and both no-migration fallbacks against SQLite.

### Accounts: password reset and confirmation emails

`/forgot-password` emails a single-use, one-hour reset link (tokens live hashed in the `RATE` KV, so no
migration is needed); completing it signs out every device. `/app/account` changes the password and signs
out other devices. Confirmation emails are sent at signup whenever the mailer is configured, even with
`REQUIRE_EMAIL_VERIFICATION=0` — that flag still only decides whether unconfirmed accounts may capture.
Without a mailer, the reset page points people to the support address. Sign-in, signup and reset requests
are rate limited per IP and per email (`429 rate_limited`).

Migration `0012_watch_runs_user_index.sql` only adds an index for the monitor dashboard; apply it with
`npm run db:migrate` whenever convenient — no code depends on it.

### Background captures and large batches (0013)

`POST /api/batches` (and `/v1/batches` with a key) queues a URL list or a sitemap and answers `202` at once;
`async=1` or `Prefer: respond-async` on `POST /api/captures` and `/v1/capture` does the same for one capture.
The `/app/batch` page uses it: preview, start, then a progress view that polls `GET /api/batches/:id` and a
list of recent batches. Cancel takes back whatever has not started.

- **No queue service.** Jobs are rows in `capture_jobs`. A second cron, `* * * * *`, works them; the hourly
  `0 * * * *` keeps the monitor sweep and retention exactly as before. At hh:00 both fire as separate
  invocations, and `src/worker.ts` tells them apart by `event.cron`. A claim is one `UPDATE … RETURNING` with
  a five-minute lease: a tick that dies leaves its jobs to lapse and be taken again, at most twice, then
  they fail and are refunded. A full browser pool is retried once, a minute later.
- **Bounded.** Two jobs render at once across every overlapping tick — one during the first ten minutes of
  the hour, while the monitor sweep has its three browsers out. A tick takes new work for 45 s and finishes
  what it started. The account with the fewest jobs running goes next, so one large batch does not hold
  everyone else's. Each busy tick logs `[jobs] due= claimed= done= failed= … backlog= late_max=`.
- **Quota.** A batch is parsed in full, then its whole cost is reserved at once — `sizes` count per file,
  a series its whole frame cap — and charged against the hourly capture limit at once, as `/api/batch` is.
  So the batch size per plan is the hourly limit, capped at 500: Free 10, Lite 30, Plus 60, Pro 120, Business
  500 (`batchLimit` in `lib/plans.ts`). Failed and cancelled captures are refunded; a short series gets the
  rest back. Credentials (`headers`, `cookies`, `basic_auth`) are refused — a queued capture is stored, and
  credentials never are. `/v1/capture` with credentials and `async=1` keeps the old in-request background
  render.
- **The iOS app never sees them.** A queued capture row says `queued`, then `running`; the default lists
  (`GET /api/captures`, `/v1/captures`, the library) leave both out unless `include_pending=1`, and the app
  never sends `async`, so `POST /api/captures` stays synchronous for it.
- **The public API keeps saying `pending`.** `/v1` has always documented an async capture as `pending` until
  `done` or `error`, so `/v1/capture`, `/v1/captures/:id` and `/v1/captures` report queued and running
  captures as `status: "pending"` with the finer state in `queue_status` (`toPublicDTO`).
- **Retention.** Finished jobs and batches are pruned after 30 days by the hourly tick; their captures follow
  the plan's own retention. Optional email on completion uses the existing mailer, once per batch.

**Before the migration** nothing changes: `/app/batch` is the synchronous 25-page queue, `async` captures run
inline (`/v1/capture` keeps its old background render), and `/api/batches` answers `503 setup_required`. Apply
it with `npm run db:migrate`, or paste `db/0013-upgrade.sql` into the D1 console; it is picked up within a
minute, without a redeploy. `npm run jobs:check` covers claims, leases, retries, quota, cancel, plan limits,
the list filter, the cron dispatch and the fallback.

### Smart checks for rule-based monitors (0016)

A text, phrase, price, element or SEO monitor watches a few values, and most checks find them unchanged.
So it now reads its page's HTML with a plain `fetch()` first (`lib/fast-checks.ts`, `lib/fast-extract.ts`)
and renders — spending a screenshot — only when what its rule watches changed. Visual monitors render
every check, exactly as before.

- **A gate, not a judge.** The reading takes only what the rule needs, with `HTMLRewriter`: whether the
  phrase is in the visible text (scripts, styles, templates and noscript left out), the selector's text,
  or the SEO signals `seo-signals.ts` compares, from the HTML, status and headers. Its normalised values
  are hashed, and the hash is only ever compared with the previous reading's, never with a browser's
  facts. Unchanged: the run is recorded with `capture_id` NULL, the current `baseline_capture_id`,
  `changed` 0 and "No change · read the page, no screenshot needed" — no capture, no quota, no alert.
  Changed: the full browser check runs unchanged, and only it decides an alert. A reading the browser does
  not confirm is not kept, so the change is looked for again.
- **Safe fetch.** `lib/safe-fetch.ts`, shared with sitemaps: `assertPublicCaptureUrl` (private addresses
  and `CAPTURE_HOST_DENYLIST`) on the start URL and every redirect hop, `redirect: 'manual'`, at most five
  hops, ten seconds in all, and nothing read past 3 MB. It asks with the user agent the monitor's device
  uses (`browserIdentity`); desktop says what it is. Monitors carry no credentials, so none are sent.
- **Unavailable, never a change.** Bot checks (`cf-mitigated: challenge`; 403/429/503 pages from
  Cloudflare, Imperva, DataDome, PerimeterX, Akamai, Sucuri, AWS WAF, DDoS-Guard), 401/403/407/429,
  network errors, timeouts, non-HTML, 5xx (except for an SEO rule watching the status, where it is news),
  selectors `HTMLRewriter` cannot use (`+`, `~`, `:has()`…) or does not find, and a page cut at 3 MB
  all fall back to the full check for that run.
- **Learning.** A monitor's row in `watch_fast_checks` starts `learning`: each check reads and renders.
  A check agrees when the reading changed exactly when the browser's facts did, and the reading said what
  the browser saw (the phrase there or not, the same price, the same SEO tags). Three agreements make it
  `fast`. A change the reading missed sends it to `browser` at once; two readings that disagree with the
  page, two unavailable readings, or three that changed when the page did not, do too — with a reason in
  plain words, such as "This page builds its content with JavaScript, so it needs a full browser", and
  one email.
- **Fast.** The gate, plus a full check once a week as a safety net, judged as a learning check is (on a
  weekly schedule every check is that full one). Three unavailable readings in a row move it to the browser;
  a reading that keeps disagreeing with the page sends it back to learning.
- **Owner override.** "Always use a full browser" (`{"action":"check_mode","force_browser":"1"}`) and
  "Try fast checks again" (`{"action":"retry_fast"}`) on `POST /api/watches/:id`, both answering the
  Monitor. Monitors gain `check_mode` (`fast`, `learning`, `browser`, `forced` or `visual`) and
  `check_reason`.
- **Quota.** A reading spends nothing; learning, safety-net and confirming renders spend one each. Out of
  screenshots, readings still run; a change spotted then keeps its signature, is recorded as "Change
  spotted, but no screenshots are left this month to confirm it; it is checked again after your allowance
  renews", and shares the monthly quota notice. Readings never count toward the auto-pause, and a network
  failure that falls back to a successful render is a success.
- **Every 15 minutes.** Pro and Business, rule-based monitors only, and only once 0016 exists (before it
  the schedule answers `503 setup_required`). A visual monitor cannot take it, nor switch to visual while on
  it (`400`). One that moves to the browser drops to hourly, said in the same email. `/api/mobile/profile`
  never offers it: the iOS app only creates visual monitors.
- **Sweeps.** The minute cron runs due 15-minute monitors at :15, :30 and :45; the hourly sweep runs
  everything at :00. Renders stay three at once; fast monitors get eight lanes of their own, up to 240 a
  tick within four minutes, and one that has to render waits for a render slot.
- **SEO notes.** On a browser check of an SEO monitor, a canonical or noindex that only JavaScript adds
  (or removes) adds a note to the run's detail. It never alerts.

**Before the migration** every monitor renders on every check exactly as before, and smart-check copy
stays hidden in the app. Apply it with `npm run db:migrate`, or paste `db/0016-upgrade.sql` into the D1
console; it is picked up within a minute. `npm run fast:check` runs the HTML reader in workerd (through
Miniflare, against the real `HTMLRewriter`) and the check flow against SQLite with and without the table.

### Free tools (no migration)

Four public pages under `/tools`, for anyone, with no account: a full-page screenshot, a responsive preview
(phone, tablet and desktop, first screen, side by side), an SEO tag checker, and a visual comparison of two
pages with the changed areas boxed. `/tools` lists them; they are in the sitemap (`/sitemap.xml`, with
`/robots.txt` pointing at it), the footer and the features page. Each result ends with "Monitor this page free",
linking to `/signup?next=/app/watches/setup?url=…&ref=tool-<name>` (signed in, straight to the setup page,
which takes the `url` prefill).

- **Plain forms first.** Each page posts to itself and comes back with the result in it; `scripts/tools.ts`
  posts the same form with `fetch()`, shows the seconds while it works, swaps in the result from the same
  markup and turns the inline images into object URLs. Same origin only: a POST needs an `Origin` that matches,
  or `Sec-Fetch-Site: same-origin`. There is no API and no key access.
- **Nothing stored.** Images go back inline in the response and nowhere else — no D1 row, no R2 object, no KV
  entry — and nothing logs the visitor or the page. The comparison hands the two images to the diff as data URLs.
- **Few renders per visitor.** `lib/free-tools.ts`: 5 renders per visitor per UTC day across the browser tools
  (a screenshot 1, a preview 3, a comparison 2) and 30 SEO checks an hour, counted in KV `RATE` under a SHA-256
  of the address (an IPv6 one by its /64) and the date, so no key holds an address and keys change daily.
  Counters fail open, as `rate-limit.ts` does.
- **Few renders in all.** A daily cap across every visitor, 300 by default, set with the optional
  `FREE_TOOLS_DAILY_RENDERS` var; `0` switches the browser tools off (the SEO checker stays). Past it visitors
  are told the tools are busy and offered a free account.
- **Customers first.** A free render starts only when the Browser Rendering pool has more than 2 sessions
  spare (`spareSessions`, from `limits()`), and it never waits for one: `acquireBrowser({ wait: false })`
  answers a full pool with "busy, try again in a minute" at once, and the renders drawn for it are given back.
  Nothing anonymous goes through the capture queue.
- **Bounded renders.** Built in `toolOptions` from the address and a preset device alone: scale 1 everywhere
  (`sizes` included), JPEG at quality 70, a full page cut at 8,000 px (the mark placed inside the cut), the
  free-plan mark on every image, the normal 100 s capture deadline, ads blocked and consent dismissed, and
  the same private-address and `CAPTURE_HOST_DENYLIST` checks. No credentials, headers, cookies, actions or
  other options exist on this path. The renderer reads these limits from `CaptureOptions.bounded`, which only
  this module sets.
- **SEO checker without a browser.** `lib/seo-check.ts` fetches with `safe-fetch.ts` (each redirect hop checked,
  10 s, 3 MB) and reads with `fast-extract.ts`'s `readSeoTags` — the SEO rule's HTMLRewriter reading plus
  Twitter tags, the viewport, `lang` and several h1s, which monitors never ask for — then words its findings
  (missing or long title and description, noindex in meta or `X-Robots-Tag`, a canonical elsewhere, several
  h1s, no `og:image`, redirect chains, hreflang without the page itself, …) with a Google and a share preview.

`npm run tools:check` covers the limits and their fail-open, the refusals, the cost weights, the bounded
render (through the real renderer against a fake page), same-origin enforcement and the `ref` on every call to
action, and runs the SEO checker in workerd against HTML fixtures and fixture redirects.

### Signup sources, referrals and the growth dashboard (0017)

Growth built into the product, for the freelancers and small agencies who look after client websites.

- **First-touch attribution** (`lib/attribution.ts`, `src/middleware.ts`). Where a signed-out visitor came
  from — `?ref=`, `utm_source`, `utm_medium`, `utm_campaign`, or a `Referer` from another site — is noted
  (the ref, the three UTM values, the landing path without its query, the referring host name, never a URL,
  and the time, each sanitised and capped) and saved to `signup_sources` when they sign up. **By default
  nothing is stored in the browser:** the landing page's links towards signing up (`/signup`, `/pricing`,
  `/client-sign-off`, `/sample-report`, `/features`, `/tools`) carry it in a `src` parameter, rewritten by the
  middleware with HTMLRewriter on signed-out GETs of HTML pages, and the signup form posts it in a hidden
  field. A cookie that is not strictly necessary needs consent under the EU's ePrivacy rules and the site asks
  for none, so a visitor who leaves and comes back later is not remembered. Set `ATTRIBUTION_COOKIE=1` to keep
  the first touch in a 30-day first-party cookie, `sf_src`, as well — only once the site asks for consent; the
  privacy page follows the setting. The app, the APIs, files, share links (`/r/…`), `/verify` and
  `/reset-password` are never landings. The iOS app signs up with JSON, no Origin and nothing carried: that is
  recorded as `source = 'ios'`, and the response is unchanged. Each signup also keeps a shortened SHA-256 of its
  IP address, used only by the referral rules below. No third-party analytics.
- **Referral programme** (`lib/growth.ts`). Every account gets a stable code and the link `/join/<code>`
  (`/r/` is taken by share links). The link redirects to `/signup`, which explains the offer, carrying
  `ref=referral:<code>` in its `src` (with the cookie on, it notes it there instead — over an earlier
  non-referral first touch, keeping its campaign and landing; the first referral link followed wins). `/join` is limited to 30 links an hour per address in KV.
  The referred account is rewarded once its email is confirmed (only asked for when this deployment can send
  mail) and it has a finished capture or monitor check: both sides get **100 bonus screenshots**, the referrer is
  emailed once. The check runs after every successful capture, on `/verify` and on the account page; most calls
  end at one indexed read.
- **Abuse rules.** One referral per referred account (`referrals.referred_id` is unique). Rejected at signup
  when the referrer has the same email domain *and* the same signup IP hash (`same_person`), or already has
  20 rewarded referrals (`limit_reached`, also enforced inside the reward batch). Deleting a referred account
  keeps the referrer's bonus and their row (pointing nowhere); a pending one is closed as `account_deleted`.
- **Bonus screenshots** (`lib/captures.ts`). A balance in `bonus_balances` that never expires and is spent only
  once the month's allowance is: `reserveQuota` tries the allowance alone first (unchanged), then takes what is
  left of it plus the rest from the bonus in one batch of conditional UPDATEs, coordinated by a token on the
  month's `bonus_usage` row. `refundQuota` gives back bonus screenshots first, up to what the month drew from it.
  `getUsage().remaining` includes the bonus, so every capture path, batches, the queue, monitors' quota skip and
  smart checks honour it; `quota` stays the plan's allowance and `used` its use. `/api/mobile/profile` adds
  `usage.bonus` and `referral_url`, both optional.
- **Report attribution.** "Shared with Easy Screen Capture" under a shared report links to
  `/client-sign-off?ref=report`; a white-labelled report still shows no line and no link. PDF exports carry no
  attribution, as before.
- **Landing page.** `/client-sign-off`: the monitor → highlight → branded report → client approval → proof
  workflow, the free offer (3 monitors checked weekly, from `lib/plans.ts`), the sample report and an FAQ. Its
  signup and pricing links carry `ref=client-sign-off`.
- **Owner dashboard.** `/app/growth`, for the emails in `OWNER_EMAILS` only (a 404 for everyone else): signups
  by ref, UTM and referring site, report-link and `tool-…` signups, referrals and rejection reasons, activation
  (a capture or a monitor) and paid plans by channel, over 7, 30 and 90 days. Every query reads at most 90
  days through a `created_at` index. Set the list as a secret:

  ```bash
  npx wrangler secret put OWNER_EMAILS   # e.g. you@example.com,partner@example.com
  ```

**Before the migration** nothing is saved (links still carry the touch, the cookie is still set where it is on), the invite section and the signup offer
stay hidden, `/join` just redirects to signup, quotas count the allowance alone, the landing page and report link
work, and `/app/growth` asks for 0017. Apply it with `npm run db:migrate`, or paste `db/0017-upgrade.sql` into
the D1 console; it is picked up within a minute. `npm run growth:check` covers all of it against SQLite.

### iOS push notifications

Native push support uses APNs and authenticated per-session device registrations. Apply `migrations/0010_mobile_push.sql` and configure `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `APNS_BUNDLE_ID` as Worker secrets. Setup and separate console SQL blocks: https://github.com/radoslav1992/screenshot-tool-ios/blob/main/PUSH_SETUP.md . Run `npm run push:check` for mocked-delivery and SQLite integration checks. No secrets means push stays dormant; email continues independently.

### Web Push for browsers and the installed app (0018)

The same monitor change alerts the iOS app gets, in Chrome, Edge, Firefox, Safari on macOS and, from iOS 16.4,
web apps added to the Home Screen. Standard Web Push, written on WebCrypto with no dependency
(`src/lib/web-push.ts`): a VAPID ES256 JWT per push service (RFC 8292) and the alert encrypted to the browser's
keys with `aes128gcm` (RFC 8291, RFC 8188). The alert carries the APNs wording, never the monitored URL, label or
page content: `{title, body, url: "/app/watches/<id>", watch_id, run_id}`.

- **Queue** (`src/lib/push.ts`). `web_push_deliveries` has `push_deliveries`' columns, so one queue serves both: a
  changed run commits one insert per kind of device in the same batch as the run, then is drained; the hourly
  cron sweeps retries. Claims stop double sends, three attempts at most, retries on the next hour, a day to
  deliver (`TTL` to match, `Urgency: normal`), and an unknown transport outcome is never resent. Push service
  answers: 201/202 delivered, 404/410 deletes the subscription, 429/5xx retried, anything else (413 included)
  failed and kept. `/api/mobile/push` and everything the iOS app uses are unchanged.
- **Subscriptions.** One per signed-in browser, tied to its session, so signing out removes it. Endpoints must be
  https on `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com` or `*.push.apple.com` (the
  server POSTs there); `p256dh` must be a 65-byte P-256 point on the curve and `auth` 16 bytes. Subscribing again
  re-binds the endpoint to whoever is signed in; past ten per account the oldest goes.
- **API** (same-origin, signed in): `GET /api/push/web` → `{available, publicKey, subscribed}`;
  `POST /api/push/web` with `PushSubscription.toJSON()`; `DELETE /api/push/web` with `{endpoint}`;
  `POST /api/push/web/test` sends a test alert to this browser, five an hour per account.
- **UI.** *Change alerts on this device* on the Account screen says whether this browser can't, needs the app
  installed first (iOS), is blocked in its settings, is off or on. Permission is asked only when *Turn on* is
  clicked. The monitor page's *Where alerts go* links to it.

**Turning it on.** Generate a key pair locally and set the three secrets (the script prints the commands, and
`.dev.vars` lines for local development):

```bash
npm run vapid:keys -- mailto:you@example.com
printf '%s' '<public>'  | npx wrangler secret put VAPID_PUBLIC_KEY   # base64url uncompressed P-256 point
printf '%s' '<private>' | npx wrangler secret put VAPID_PRIVATE_KEY  # base64url scalar, or a PKCS8 PEM
printf '%s' 'mailto:you@example.com' | npx wrangler secret put VAPID_SUBJECT
```

Then apply `npm run db:migrate`, or paste `db/0018-upgrade.sql` into the D1 console; it is picked up within a
minute. **Without the migration or any of the three secrets** nothing changes: the Account card and the monitor
page note are not rendered, `/api/push/web` reports `available: false` and refuses to subscribe, and nothing is
queued; APNs and email alerts carry on as before. Keep the key pair once it is in use: every subscription is tied
to the public key it was made with, so a new pair stops alerts to every browser until each turns them on again.
`npm run webpush:check` covers the RFC 8291 test vector, VAPID, subscriptions, delivery beside APNs, the test-alert
limit, dormancy and account deletion against SQLite with a mocked `fetch`.

### Pro trials (0019)

Free and Lite accounts can try Pro for 14 days, once, with no card, and go back to their own plan on their own
when it ends.

- **One plan decision** (`lib/trial-plan.ts`, `toSessionUser` in `lib/auth.ts`). Every user has two plans:
  `ownPlan`, what the account holds through Stripe or Apple (or Free), and `plan`, what it acts on — Pro while a
  trial runs on top of a plan below Pro. The trial is read with the user row by one `LEFT JOIN plan_trials` once
  the table exists (probed in `sqlite_master`, cached per isolate), so sessions, API keys (`authenticateApiKey`),
  the monitor sweep (`runWatch`), alert retries, queued captures and `/api/mobile/profile` all get the same plan;
  retention and report branding use the same rule in SQL (`planSql`). Everything that reads `plan` follows: the
  monthly quota, monitor limits and schedules, API access and its rate, PDF and custom sizes, the watermark,
  history days, batch and hourly limits, and the white label. `users.plan` is never written by a trial.
- **Billing keeps to the real plan.** The pricing page's "Current plan", the account screen's billing rows, the
  upgrade page and the plan-change diagnosis read `ownPlan`, so a trialing Free account can still buy Lite, Plus
  or Pro, and the Apple purchase check reads the database as before. A Stripe subscription to Pro or Business
  closes a running trial without its ended email.
- **Quota.** Pro's 2,000 for the month while the trial runs; when it ends mid-month the account's own allowance
  applies for the rest of it, and what was already used still counts.
- **Starting one.** `POST /api/trial` (same-origin, signed in) answers `201 {plan: "pro", ends_at}`, or
  `409 trial_used`, `409 already_paid` (not Free or Lite, or an active Stripe subscription), `403
  verification_required` (the email is not confirmed: required wherever mail can be sent, even with
  `REQUIRE_EMAIL_VERIFICATION` off, since two weeks of Pro would otherwise be worth a throwaway signup),
  `429 rate_limited` (5 an hour per account, 20 per address,
  in KV) or `429 trial_limit` (3 trials per hashed address in 30 days, hashed like the signup address in
  `lib/growth.ts`, checked in the same statement that inserts the row). A form post lands on the account screen.
- **The end.** The hourly cron (`runTrialLifecycle`) emails a reminder three days before the end and a note once
  it has ended, each claimed in `reminded_at` / `ended_at` before sending, so each goes at most once; both link
  to Pro on the pricing page. The plan itself changes the moment `ends_at` passes. On their next check, monitors
  beyond the own plan's limit pause ("Paused: your Pro trial ended; your plan includes 3 monitors.") and those on
  schedules it lacks pause too; API keys are kept but answer `403 plan_required`, saying the trial ended.
- **UI.** The pricing page's Pro card links to the trial under its orange button (signed out, to signup with
  `ref=trial` and `next=/app/upgrade#trial`); `/app/upgrade` and the account screen offer "Start your 14-day Pro
  trial" as their one orange action while it is on offer. During a trial the capture and account screens show
  "Pro trial · 9 days left · Keep Pro"; for a month after it, a notice that can be closed on that device. The iOS
  app offers nothing: `/api/mobile/profile` keeps `plan` as the plan acted on and adds an optional
  `trial: {plan, ends_at}` while a trial is what that plan reflects.
- **Owner dashboard.** `/app/growth` counts trials started and those now on a Stripe plan, by window.

**Before the migration** nothing changes: no account has a trial, nothing offers one, `POST /api/trial` answers
404 and the cron sends nothing. Apply it with `npm run db:migrate`, or paste `db/0019-upgrade.sql` into the D1
console; it is picked up within a minute. Deleting an account deletes its trial row. `npm run trial:check` covers
eligibility, the plan during and after a trial, quota, monitors, the API, checkout, both emails, paying during a
trial, the iOS profile, deletion and the no-migration fallback against SQLite.

### Site health checks (0020)

For every site behind an account's active monitors (each distinct `scheme://host` of a monitor with `status =
'active'`), the hourly sweep and the minute cron check uptime, the SSL certificate, the domain registration and the
links on each monitored page (`lib/site-health.ts`). None of it takes a screenshot or spends quota. The sites are kept
in step with the monitors in SQL, each hour: a new origin gets a row with its first checks due at once, the oldest
active monitor's page is the one uptime fetches, and a site nobody monitors any more stops being checked.

| Check | Free, Lite | Plus, Pro, Business |
| --- | --- | --- |
| Uptime of the first monitored page | hourly | every 15 minutes |
| SSL certificate | daily | daily |
| Domain registration (RDAP) | weekly | weekly |
| Broken links, per monitored page, at most 100 | weekly | weekly |

The tiers are `UPTIME_MINUTES`, `SSL_CHECK_HOURS`, `DOMAIN_CHECK_HOURS`, `LINK_CHECK_HOURS` and `LINKS_PER_PAGE` in
`lib/plans.ts`, read through the plan an account acts on, so a Pro trial gets 15-minute uptime.

- **Uptime.** A GET of the page through `fetchPublic` (every redirect hop checked, 10 s). Down: no answer, a timeout,
  a TLS failure or a 5xx. A 4xx is "up but erroring": shown, never downtime. A bot check (`isChallenge`) is up. Two
  down checks in a row open an incident, dated from the first; the first up check closes it. Every check adds to its
  hour's row in `site_uptime_hourly` (checks, down, total ms), so a month's uptime is at most 720 small rows. Runs at
  :15, :30 and :45 on the minute cron and on the hour, 300 sites a tick, eight at a time, taken under a short lease.
- **SSL** (`lib/tls-probe.ts`). Workers' `fetch` validates a certificate but reveals nothing about it, so the probe
  opens a plain socket (`connect()` from `cloudflare:sockets`, `secureTransport: 'off'`), sends a TLS 1.2 ClientHello
  (SNI, ECDHE/RSA suites, groups, point formats, signature algorithms), reads the ServerHello and the Certificate
  message, which TLS 1.2 sends in the clear, and closes the socket without finishing the handshake. A small DER parser
  reads the leaf's validity, issuer and subjectAltName names; it reads at most 64 KB in 10 s and checks every length.
  A HEAD over HTTPS says whether the chain is trusted (a 525/526 or a TLS error means it is not). States: `ok`,
  `expiring` (14 days or less), `expired`, `invalid` (untrusted, the wrong name, not yet valid), `no_https` (a site
  monitored over plain HTTP whose host has no working HTTPS, never an error) and `unknown` (no answer at all).
- **What the probe cannot read.** A server that only speaks TLS 1.3 answers the hello with an alert, and Workers may
  not open sockets to Cloudflare's own addresses, so sites behind Cloudflare cannot be read either. Then the HEAD is
  the answer: HTTPS works and the certificate is trusted, with the expiry shown as unknown and the reason said
  plainly. A Certificate Transparency lookup was considered and left out: it lists certificates issued, not the one
  served, so it cannot tell that a server still serves the old one after a renewal, it needs a paid key to be
  dependable, and it would send customers' host names to a third party.
- **Domain** (`lib/rdap.ts`). RDAP, with IANA's bootstrap (`data.iana.org/rdap/dns.json`) cached in KV for a day and
  `rdap.org` when it cannot be had. With no Public Suffix List here, the last two labels are asked for and a 404 means
  try three, with common two-label suffixes (`co.uk`, `com.au`, …) known up front. Reads the `expiration` event, the
  registrar and the status. `expiring` at 30 days; a registry that publishes no expiry (`.de`) is `unknown`, said so.
  One lookup per registration a sweep: `www.` and `shop.` share it. A registry that could not be asked is asked again
  the next day.
- **Broken links** (`lib/link-check.ts`). The page's `<a href>` links (comments, scripts, styles and templates left
  out), resolved against the final URL or `<base>`, http(s) only, deduplicated, the first 100. Each is asked with HEAD,
  GET (cut off at the headers) when HEAD answers 405 or 501, six at a time, 8 s each. Broken: 404, 410, 5xx, a dead
  host or a redirect loop. Couldn't verify: 401, 403, 429, bot checks, timeouts. Private addresses are never asked.
  `site_broken_links` keeps each breakage with when it was first seen and when a later check found it working or gone
  from the page, so a report can say "3 fixed this month". Up to 30 pages and 2,000 requests per hourly sweep.
- **Shared requests.** Within a tick, identical requests are made once: fifty accounts on one site cost one uptime
  request, one certificate read, one registry lookup and one request per link. Each account keeps its own results.
- **Alerts** (plain-text email, linking to the monitor page's panel): an incident opening and closing (with how long
  it lasted); a certificate at 14 days, again at 3, and when expired or invalid; a domain at 30 days and again at 7.
  Each is claimed in the database before it is sent, so it goes once per change of state; a renewal starts the
  warnings afresh. They go to the owner when any active monitor on the site has email alerts on (`notify_email`).
  Broken links are never emailed.
- **UI.** A Site health panel on the monitor page (uptime over 24 hours, 7 and 30 days and the last incident; when the
  certificate expires and its issuer; the domain's expiry and registrar; this page's broken links and how many links
  were checked), in pending, healthy, needs-a-look and problem states, and a small tag per monitor on the list.
- **For the care report.** `siteHealthForWatches(userId, watchIds, from, to)` in `lib/site-health-summary.ts`: one
  entry per origin with uptime and incidents in the window, the latest SSL and domain state, the latest broken links
  and how many were fixed in the window. Seven indexed queries, the account's own rows only.
- **Retention.** Rollups, closed incidents and fixed links older than 13 months, and sites unused for as long, are
  pruned in the hourly sweep in bounded batches. Deleting an account deletes its rows; deleting a monitor its link
  results.

**Before the migration** nothing is checked, fetched or sent, the panel and the tags are not rendered and the summary
is empty. Apply it with `npm run db:migrate`, or paste `db/0020-upgrade.sql` into the D1 console; it is picked up within
a minute, and the first checks run within the hour. `npm run health:check` covers the ClientHello, a real TLS 1.2
handshake against a `node:tls` server with certificates built in the test (and a TLS 1.3-only one), corrupted and
truncated certificates, RDAP, uptime and incidents, links, alerts, the summary, pruning, deletion and dormancy against
SQLite with a mocked network.

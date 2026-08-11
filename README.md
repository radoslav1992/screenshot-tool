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
`width`×`height` (paid plans). Output frames land on an exact pixel size without cropping:
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
   Storage & Databases → D1 → *screenify-data* → Console) and run it. It contains the same schema
   plus the `d1_migrations` bookkeeping rows, so a later `npm run db:migrate` reports *No migrations
   to apply* rather than trying to create the tables twice. It is idempotent — safe to re-run.

   **Upgrading a database that already has an older schema?** Run the matching `db/000N-upgrade.sql`
   files in order (`0002-upgrade.sql`, then `0003-upgrade.sql`) — `apply-manually.sql` creates tables
   but cannot add columns to existing ones.

   The D1 console flattens pasted SQL onto one line, which makes `--` comments swallow everything
   after them. The `db/000N-upgrade.sql` files are therefore comment-free and safe to paste as-is.
   `ALTER TABLE … ADD COLUMN` is not idempotent in SQLite: if a re-run reports *duplicate column
   name*, that column is already there — drop that line and run the rest.

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
  -H "Authorization: Bearer $ESC_API_KEY" \
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
  `share_target` so sharing a URL to Easy Screen Capture opens the capture form pre-filled.
- `public/sw.js` — cache-first for fonts/icons/hashed assets, network-first for documents with an
  offline fallback. API responses and rendered files are never cached.
- Install prompt is surfaced as a row on the Account screen.
- Fonts (Sora, IBM Plex Sans/Mono) are self-hosted latin subsets, so the shell renders offline and
  no third-party request is made.

## Abuse and cost controls

The free tier is generous (200 screenshots/month, about $0.06 of infrastructure), so the limits that
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

# Easy Screen Capture: product and growth plan

Prepared 12 September 2026. This is a prioritized proposal, not a promise of revenue. Implementation status is tracked below and in WORKSPACE-RELEASE.md. Existing prices are unchanged.

## Positioning

**The visual record and website monitoring workspace for small web agencies.**

Start with freelancers and agencies managing 5–30 client websites. Their recurring job is to check launches, catch unexpected changes, and show clients what they delivered. Lead with “see what changed and send the evidence.” Keep screenshot capture as the free entry point and the API as a secondary distribution channel.

Use Kova's own client maintenance workflow as an initial test case, followed by independent agencies so the product does not become tailored to one business. Keep the main product English for a wider market; validate a Bulgarian agency landing page before localizing the whole app.

## Competitive context

[Visualping](https://visualping.io/) already presents visual/text comparisons, notifications, AI change assessment, and team management. [Pagescreen](https://pagescreen.io/) presents visual archives, collections, collaboration, and API/webhook integrations. These official product pages were reviewed on 12 September 2026; their marketing claims are not independent evidence of efficacy.

Inference: generic “AI website monitoring” is not a sufficient differentiator. Test whether an agency can go from a client URL to a useful, branded before-and-after deliverable in under five minutes. Compete on that workflow and reliable evidence, rather than feature count or the lowest screenshot price.

## What the repository already supports

- Desktop, tablet, mobile, social output frames; visible, full-page and scroll-series captures.
- PNG/JPG; PDF and custom sizes on eligible paid plans.
- Retained capture library, downloads and tokenized file links.
- Scheduled watches, visual differences, text/page facts, and optional AI summaries (requires configuration).
- Email and Slack/Discord/custom webhook notifications.
- API capture, compare, batches and sitemaps; some advanced capabilities are primarily API-facing.
- Ad blocking, hide/blur selectors, best-effort personal-data masking, bounded pre-capture actions and transient capture credentials.
- Plan enforcement, billing, quotas, rate limits and retention cleanup.

Availability depends on the configured Cloudflare services and email/billing integrations. Code presence does not prove live operational readiness.

## Included in this improvement

- New homepage focused on capture → monitor → compare → share, with an explicitly illustrative product example.
- Shared paper/charcoal/lime theme, desktop navigation, clearer hierarchy and responsive styles.
- Capture presets for website reviews, mobile checks, social posts and privacy checks.
- Live configuration summary, explicit quota/verification states, accessible error reporting and protected busy state.
- UI controls for the existing personal-data masking and element-hiding capabilities.
- Account-scoped URL search across retained history, capture-mode filtering, and pagination.
- “Monitor this page” handoff from a capture, preserving its URL.
- Removal of unconnected OAuth buttons and unsupported team-seat/SLA claims from pricing features.

## First feature release: monitor health and budget forecasting

Implemented after the redesign:

- Capture success rate, pending/failure counts and average successful capture duration over retained history from the last seven days.
- Per-monitor latest result and last successful check; baseline creation, unavailable comparisons and skipped checks no longer read as unchanged pages.
- Persisted email/webhook acceptance or failure on new changed runs, with the most recent alert still visible after later checks. Historical delivery is unknown; provider acceptance is not inbox confirmation. Automatic notification retries remain future work.
- Aggregate 30-day and before-reset forecasts, excluding paused monitors, with affordable slower-frequency suggestions where available.
- Schedule editing with ownership and plan checks. Paused monitors remain paused. The detail forecast shows the hypothetical resumed schedule.
- Comparison failure keeps the last good baseline and counts toward the existing five-error auto-pause policy. If retention has deleted the old capture, a new baseline is established.

No database migration is needed. Metrics are derived from retained capture/run records rather than permanent telemetry. Deleted records are excluded. Forecasts are estimates, not reservations; other captures, delayed execution and concurrent activity can change actual usage. Live provider delivery and visual browser inspection must still be verified in the deployed environment.

## Client workspace release

Projects, saved batch settings, before/after reports and paid PDF export, batch/desktop-mobile launch capture, revocable report links, Business team invitations and comments, opt-in weekly digests, and guided monitor setup with baseline previews and ignore regions are now implemented in code. See [WORKSPACE-RELEASE.md](WORKSPACE-RELEASE.md) for boundaries, billing rules, tests, and the three required migrations. Live deployment and provider checks are still required. This is a first implementation of each workflow, not evidence of product-market fit.

The roadmap table below preserves the original priorities and acceptance goals; richer annotation, automatic delivery retries, and wider team permissions remain possible follow-ups after pilot validation.

## Prioritized roadmap

Effort is a rough estimate in focused engineering days, excluding external dependencies and pilot feedback.

| Priority | Deliverable                                   | Why users would pay                                     | Acceptance criteria                                                                                                                                        | Effort    |
| -------- | --------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| P0       | Capture and alert reliability dashboard       | Trust that a missing alert means no change              | Measure capture success/latency; distinguish failed checks from unchanged pages; visible last-success and delivery state; quota exhaustion warning         | 3–5 days  |
| P0       | Monitor usage forecast                        | Avoid a monitor quietly exhausting the account          | Show total scheduled monthly demand, remaining allowance, and suggested lower frequency before saving; warn when demand exceeds quota                      | 2–3 days  |
| P1       | Client projects and reusable capture settings | Find and repeat client work without rebuilding settings | Owner-scoped project CRUD; assign captures/watches; save named presets; never persist credentials in presets                                               | 4–6 days  |
| P1       | Before-and-after review report                | Deliver evidence clients understand                     | Pick two captures; annotate changes; export branded PDF containing URLs, viewport, timestamps, and images; preserve source captures                        | 5–8 days  |
| P1       | Monitor setup wizard and noise controls       | Fewer irrelevant alerts                                 | URL → baseline preview → device/region → threshold → schedule/budget → destination; support ignore regions and test notification                           | 5–8 days  |
| P1       | Batch capture UI                              | Review a whole site instead of one URL at a time        | Reuse existing batch API; preview URL/sitemap list and quota impact; show per-page success/error; recover partial results without repeating completed work | 4–6 days  |
| P2       | Weekly client digest                          | A reason to keep using the product every week           | Opt-in grouped summary of changes, failures, and completed checks; timezone and recipients; deduplicated sends                                             | 3–5 days  |
| P2       | Desktop/mobile launch checklist               | Faster client launch reviews                            | Capture both sizes; choose a baseline; record review status; export one report; charge actual capture count visibly                                        | 4–6 days  |
| P2       | Revocable review links                        | Share with clients without permanent exposure           | Separate report token, expiration, revoke action and clear access label; retained private originals; audit basic access events                             | 3–5 days  |
| P3       | Team seats and comments                       | Agency collaboration                                    | Membership, roles, invitations, tenant isolation tests and billing rules before advertising seats                                                          | 7–12 days |

Reliability and usage clarity shipped first. The subsequent workspace release implements the remaining workflows at a bounded initial scope. Roll it out to a small pilot and use observed customer friction to prioritize refinements.

## Packaging and unit economics

Keep the current $7 Plus, $19 Pro and $79 Business pricing while learning. Do not change Stripe prices or existing entitlements as part of the redesign.

- Free: first successful capture and share; protect the render budget with existing rate limits.
- Plus: clean exports and a small number of daily monitors.
- Pro: freelancers using monitors, API and repeat client work. Projects and reports are now implemented; PDF exports follow existing paid-plan eligibility.
- Business: higher volume and retention today. The workspace release includes three project collaborators with explicit roles and owner-paid capture usage; Stripe prices are unchanged.

**Monitor slots are not a promise that every slot can run hourly all month.** A 30-day estimate is 30 screenshots for one daily monitor and 720 for one hourly monitor. Twenty-five hourly monitors would require 18,000 checks against Pro's 2,000-screenshot allowance; 100 hourly monitors would require 72,000 against Business's 15,000. Capture modes producing multiple files may use more. Explain this prominently and implement aggregate forecasting before promoting large monitor counts.

Track browser seconds, retries, storage byte-days, notification volume and support time by active account. Proposed gate: at least 70% contribution margin after these variable costs before scaling acquisition. This is a target to test, not the current margin. Avoid unlimited plans and lifetime deals with unbounded rendering.

If interviews show that reports drive purchase, test a prospective agency package around $29–$39/month using a clearly labeled offer before implementing new billing. Do not imply that price or demand is established.

## First 90 days

### Days 1–14: establish activation

- Verify the production build branch, D1 migrations, rendering, verification mail, one scheduled monitor and one paid checkout flow in the appropriate test environment.
- Instrument: signup → verification → capture success → first download/share → monitor created → first comparison viewed.
- Record event names, timing, plan and coarse error category. Keep captured URLs, query strings, images, credentials and personal text out of analytics.
- Conduct 8–10 agency/freelancer interviews about their last site launch or client report. Ask to see the current workflow and how often the task occurs.
- Publish a 45–60 second demo: capture a client page, compare a change, send the evidence. Use an owned demo site.
- Proposed initial goal: at least half of verified pilot users complete a capture within their first session. Investigate the biggest drop-off before buying traffic.

### Days 15–45: prove repeat value

- Invite 5 agencies to use the app on real, authorized client work; aim for 3 weekly active pilots, not hundreds of free signups.
- Build projects plus the smallest useful review report. Observe a client handoff end to end.
- Have pilots identify which alerts mattered and which were noise. Fix noisy monitors before adding more AI.
- Measure time to first useful report, weekly recurring project activity, and willingness to pay at the existing Pro price.
- Gate: at least 3 independent agencies repeat the workflow weekly for four weeks and can identify a concrete saved task or avoided problem. If not, revisit the use case.

### Days 46–90: test acquisition

- Publish focused pages: website change monitoring for agencies, before-and-after website reports, and mobile website screenshot reviews.
- Produce short demos from the same real workflows for LinkedIn, YouTube and founder/agency communities. Publish only with appropriate permission for client content.
- Offer a small n8n example using the existing API/webhook integration; no credentials in the shared template.
- Start a tightly capped paid search test only after conversion tracking and retention are credible. Suggested experiment budget: $150–$300 total, requiring a separate spending decision; no ads are launched by this plan.
- Measure visitor → verified user → successful capture → activated monitor/report → paid account. Stop channels that bring registrations without repeat usage.
- A useful early business milestone is 10 paying, returning agencies. It is a validation goal, not a forecast.

## Weekly scorecard

| Metric               | Definition / decision                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Activation           | Verified accounts completing a successful capture in their first session                            |
| Time to value        | Median and p95 time from starting the task to downloadable capture or report                        |
| Capture reliability  | Successful captures / valid capture attempts; split target-site failures from service faults        |
| Useful alert rate    | Alerts pilots marked useful / alerts they reviewed; include a way to report noise                   |
| Weekly recurring use | Agencies reviewing monitors, creating captures or sharing reports in at least 3 of the last 4 weeks |
| Paid conversion      | New paid accounts / activated accounts by cohort, with the observation window stated                |
| Contribution margin  | Revenue less rendering, storage, notification, payment and attributable support costs               |

## Explicitly defer

A generic AI chat, native desktop recorder, browser extension, white-label portal, enterprise SLA, and unlimited storage. Each adds cost or support obligations without proving the first recurring workflow. Best-effort redaction is not a guarantee of anonymization; screenshot archives are not certified legal evidence.

## Release notes and verification

The initial redesign/library release required no migration. The subsequent workspace release requires migrations 0006–0008; see WORKSPACE-RELEASE.md. No new secrets are required. Existing API cursor behavior remains supported.

- Run `npm run check`, `npm run build`, and `npm run library:check` (Node 22.13+ for the SQLite check).
- Verify capture presets, privacy settings, quota/verification gating, search and filters, signup URL handoff, and monitor URL handoff.
- Manually inspect desktop and 390px mobile layouts before a production campaign. Check keyboard focus, menu close/Escape, loading/error states, and long URLs.
- Confirm deployment tracks `main`: the repository's default branch at review time was `claude/screenshot-pwa-astro-xojpc7`. Committing to `main` does not change the default or deployment branch.

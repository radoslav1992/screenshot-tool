# Client workspace release

## Rollout

Apply the additive D1 migrations before deploying this version:

```sh
npm ci
npm run db:migrate
npm run check
npm run library:check
npm run monitor:check
npm run projects:check
npm run build
```

New migrations are `0006_projects.sql`, `0007_collaboration.sql`, and `0008_monitor_noise.sql`. Use `npm run db:migrate:local` for a local D1 instance. The new tables use foreign keys and cascading deletion; D1 must retain its normal foreign-key enforcement. No existing capture data is rewritten. Existing capture and monitor flows work without the new tables; new feature pages explain that setup is pending.

Committing to `main` does not prove production deployment. Check the actual build branch and apply migrations to the same D1 database used by that deployment. Live Browser Rendering, email delivery, cron execution, and desktop/mobile visual inspection remain deployment checks. No secrets or Stripe prices change in this release.

## Delivered workflows

- **Projects:** owner-scoped create, rename, delete, brand name, retained capture and monitor assignment, reusable batch capture settings. Up to 100 projects/account, 30 presets/project and 100 reports/project. Removing a project does not delete source captures or monitors.
- **Batch capture:** list or bounded sitemap preview, URL deduplication, quota estimate, one sequential capture per request, per-page results, stop after current page, retry failed pages only, and separate retry for project attachment. Unknown request outcomes stop the queue and require a library check; they are never automatically recaptured. Queue state lives in the open tab. Commas in URLs are preserved through `url_lines=1`.
- **Launch checks:** desktop/mobile pairs, explicitly charged as two screenshots per page. Up to 12 pages in one launch queue; normal batches allow 25. Attach previous baselines, set manual review status, and select desktop/mobile before-and-after pairs in one report. Status is a human assessment, not an automated pass/fail result.
- **Review reports:** selected retained PNG/JPG captures, client-facing notes, viewport/URL/timestamp metadata, current project brand name, private owner notes and separate team discussion. Image captures are referenced, not modified or copied. Reports do not extend retention; missing originals are visibly marked unavailable.
- **PDF export:** paid plans, up to six exports/hour, no screenshot-quota charge. Uses the existing Browser Rendering binding to render a self-contained report with scripts and external requests disabled. Up to 16 MB of source images; images scale to fit A4 pages. Missing source images block export instead of silently producing an incomplete document. Provider/browser usage still costs the service money. Exports use the brand name; custom logos and freehand image markup are future enhancements.
- **Review links:** one separate hashed token per report, 1/7/30-day expiry, replacement and revocation, page-view count and latest access time. Public report images revalidate the token and send `no-store`. No original capture share tokens are exposed in reports. Links are bearer access; downloaded copies cannot be recalled. Owner notes and team comments are excluded from public links and PDFs.
- **Business collaboration:** up to three collaborators per project, including unexpired pending invitations, included in the existing Business price. Invitation links last seven days, bind to an independently verified email and become unusable after acceptance. Viewer: read project reports. Editor: read reports and add team comments. Owner: manage all project data, billing, captures, monitors and sharing. Invite links are generated for the owner to distribute; the app does not automatically email them. Downgrading from Business pauses member access without deleting records. Capture usage stays with the owner; members cannot spend the owner’s quota. Change a role by revoking and reinviting.
- **Weekly digests:** owner/member opt-in to their own verified email, IANA timezone, Monday after 09:00 local time, grouped completed/changed/failed/skipped monitor checks. Current project monitor assignments determine inclusion; owner-only notes and images are excluded. The existing hourly cron drains the oldest due subscriptions in batches of 50. Send attempts use unique per-project/recipient/week claims, with accepted/failed/unknown status and 90-day delivery-record retention. Ambiguous/failed sends are not retried automatically, so a crash can lose an attempt rather than duplicate it. Provider acceptance is not inbox confirmation. Recipients can disable their own subscription; revoked members cannot receive later digests. Email transport must be configured.
- **Guided monitor setup:** page/device/area → hide selectors and rectangular ignore regions → quota-charged baseline preview → threshold/schedule/budget/destination. A 15-minute owner-bound preview receipt ensures the saved monitor uses the same URL, viewport, area and masks. The existing preview is reused as the baseline; the first scheduled comparison waits one selected interval. Ignore rectangles use page-relative CSS coordinates and affect visual comparison only; page facts can still contain underlying text. Existing monitors retain their existing settings. Test notification buttons send only on an explicit user click, rate limited to five/hour.

## Verification

`projects:check` applies all migrations to SQLite and runs production project/report/collaboration code with mocked external services. It covers account isolation, preset credential exclusion, invalid report pairs, report retention/deletion, owner and team comments, token rotation/expiry/revocation, no-cache image responses, PDF HTML escaping and blocked network/scripts, verified invitation identity, roles, seats, downgrade/revocation, digest scheduling/deduplication, and ignore-region validation.

`monitor:check` covers existing reliability/budget behavior and passes stored hide selectors/ignore rectangles through actual monitor execution. Batch form behavior was additionally exercised in a DOM harness, including retrying failed pages without repeating successes and retrying attachment without recapture. External mail/webhooks and Browser Rendering were mocked; no test notifications were sent to real recipients.

Before broad rollout, verify a real preview and scheduled comparison with masks, an A4 PDF download, a second-account invite acceptance/revocation, a public link after revocation, and one opt-in digest on the deployed environment. Test 390px and desktop layouts and keyboard focus. Pilot feedback should guide changes before adding automatic notification retries, arbitrary digest recipients, richer image annotation, or collaborator capture permissions.

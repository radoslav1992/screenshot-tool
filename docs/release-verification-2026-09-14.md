# Workspace release verification

## Live checks

- Created an explicitly labeled release-verification project and desktop/mobile screenshots of example.com. Both completed and appeared in a report.
- Opened a temporary public report link with both images visible. Revoked it; owner UI confirmed no active link. Browser infrastructure blocked the subsequent navigation, so the revoked-link HTTP response was not verified.
- Monitor preview completed and was accepted as baseline. The daily schedule showed the next day as its first comparison.
- Manual comparison captured an image but failed during comparison. The previous baseline was preserved. The test monitor was paused to prevent unattended quota use.
- The notification test reported email not configured and webhook off. Delivery is not verified.
- PDF download automation failed with a browser protocol error (`Fetch domain is not enabled`). Actual downloaded PDF contents are not verified.
- Team invitation acceptance requires a second verified account; not verified live.
- The signed-in account already has an active yearly Business subscription. No plan change or new charge was attempted. Checkout and webhook completion require a separate test setup.

## Changes prompted by verification

Token-authorized image responses now allow anonymous cross-origin reads, which the canvas comparison browser requires. Cookie-only image responses do not gain cross-origin access. A route regression check covers unauthorized access, owner-only privacy, and valid-token 200/206/304 responses. A successful live comparison is still required after deployment to confirm this resolves the observed failure.

The empty monitor history now uses its actual scheduled date or paused state. New monitor setup clearly indicates unavailable email delivery and defaults email off when no mail transport is configured.

## Product work

Added an account-scoped onboarding page at `/app/start`, a public illustrative report at `/sample-report`, and `/features`. Pricing and shared feature descriptions now disclose output counting, UTC calendar-month resets, monitor quota consumption, image retention, report link expiry, and existing team limits. Removed the unsupported priority-rendering claim. No new migrations or entitlement changes.

## Remaining launch checks

1. After deployment, check the example.com monitor manually, confirm a completed comparison, and leave the test monitor paused.
2. Configure an existing supported mail transport and verified sender, then verify receipt of the account's test alert.
3. Use a designated second verified account to accept a project invitation and check viewer/editor permissions.
4. Complete Stripe test-mode checkout in an isolated deployment and verify webhook-driven plan activation.
5. Download and inspect a branded PDF in a normal browser.

# Easy Screen Capture: live Stripe launch

This guide matches the repository configuration on 14 September 2026. No new database migration is needed for this release.

## 1. Confirm the production Worker
In Cloudflare, select the Worker actually serving easyscreencapture.com. Check its custom domain and production deployment; the repository configuration calls the Worker screenify, while the GitHub build integration has appeared as screenshot-tool. Do not infer the destination from the build label alone.
Deploy main and confirm the pricing page contains the workload estimator.

## 2. Finish sandbox verification first
Use a separate test deployment and D1 database for test customers. Check checkout, webhook-driven activation, cancellation and the customer portal before changing production keys.
A stored test customer or subscription cannot be used with a live key. The existing Business account may contain test billing IDs; inspect them in Stripe before switching. Do not bulk-clear billing columns or paid entitlements. Use a fresh application account for the first live purchase, and resolve any old test records individually after identifying their mode.

## 3. Activate Stripe and select live mode
Complete Stripe's business activation and payout information. Select the correct business account and live mode, outside any sandbox. Complete public business details, support information, branding and statement descriptor. Set:
- Website: https://easyscreencapture.com
- Terms: https://easyscreencapture.com/terms
- Privacy: https://easyscreencapture.com/privacy

## 4. Create the live catalog
Create three products, each with two fixed recurring prices in USD. Use quantity 1, not metered or tiered prices.

| Product | Monthly | Yearly total |
| --- | ---: | ---: |
| Easy Screen Capture Plus | $7 | $67 |
| Easy Screen Capture Pro | $19 | $182 |
| Easy Screen Capture Business | $79 | $758 |

The yearly amount is the full charge once per year, not a monthly equivalent. Copy the six price_ IDs, not prod_ IDs. Sandbox IDs will not work.
Alternatively, with Node 24 and a securely supplied live STRIPE_SECRET_KEY, run npm run stripe:setup. This creates catalog objects but does not charge anyone. It now stops if a reused lookup-key price differs from the storefront. Do not overwrite a mismatched price blindly: inspect it first.

## 5. Create the live webhook
In Stripe Workbench / Webhooks, create an event destination for this account (not connected accounts).
URL: https://easyscreencapture.com/api/billing/webhook

Select:
- checkout.session.completed
- customer.subscription.created
- customer.subscription.updated
- customer.subscription.deleted

Save and copy this endpoint's whsec_ signing secret. The CLI listener and sandbox endpoint have different secrets.

## 6. Configure the live customer portal
In Settings > Billing > Customer portal, save a live configuration.
Enable payment-method updates, invoices, plan changes and cancellation. Include the three live products and their monthly/yearly prices among the allowed changes. Set cancellation to the end of the current billing period to match the site's access promise. Review proration and effective-date settings.
Return URL: https://easyscreencapture.com/app/account
The application already creates portal sessions; you do not need to embed a portal widget or create a separate Payment Link.

## 7. Set production secrets
In Cloudflare > the production Worker > Settings > Variables and Secrets, add these using type Secret:

| Name | Value |
| --- | --- |
| STRIPE_SECRET_KEY | The live account secret key, sk_live_… |
| STRIPE_WEBHOOK_SECRET | The new live endpoint signing secret, whsec_… |
| STRIPE_PRICE_PLUS_MONTHLY | Plus $7/month price_… |
| STRIPE_PRICE_PLUS_YEARLY | Plus $67/year price_… |
| STRIPE_PRICE_PRO_MONTHLY | Pro $19/month price_… |
| STRIPE_PRICE_PRO_YEARLY | Pro $182/year price_… |
| STRIPE_PRICE_BUSINESS_MONTHLY | Business $79/month price_… |
| STRIPE_PRICE_BUSINESS_YEARLY | Business $758/year price_… |

Publish the configuration together. These are runtime secrets, not only build environment variables.
The current hosted Checkout integration does not use a publishable pk_live_ key.
Never put secret values in GitHub, screenshots or support messages.

STRIPE_AUTOMATIC_TAX is optional. Enable it with value 1 only after configuring Stripe Tax for the business. Otherwise leave unset/0. Do not turn on STRIPE_TOS_CONSENT until you have reviewed the existing checkout consent wording for your service and configured the terms URL; the flag does not by itself establish legal compliance.

## 8. Run the read-only check
With Node 24, supply the same eight values securely in your local environment, then run:
```sh
npm ci
npm run commerce:check
npm run stripe:check
```
The Stripe check makes GET requests only: it checks the supplied prices, live/test consistency and matching webhook URL/events. It does not verify the Worker has those values, test signatures against the deployed secret, validate portal settings, or complete a payment. Restricted keys need read access to Prices, Products and Webhook Endpoints for this script.

## 9. Verify the first real purchase
Use a fresh application account and a real payment method for an intended live purchase; this charges real money. Do not use Stripe test cards in live mode.
Choose Plus monthly, confirm the USD amount and product in Stripe, then complete checkout. In Stripe, verify payment success and successful webhook deliveries. In the app, verify Plus access and quota after refreshing the account page.
A return URL alone does not confirm payment. Check the webhook result and actual account plan.
Open Billing, card & invoices and verify invoices, payment settings and cancellation are reachable. Confirm all six plan buttons open the correct price before promoting the site; opening Checkout does not require completing each payment.

## Troubleshooting
- No such price/customer: check account and test/live mode; existing test IDs do not become live IDs.
- Signature verification failed: use the deployed endpoint's signing secret, not the CLI or sandbox secret.
- Payment succeeded but account stayed Free: inspect failed webhook deliveries and Worker logs; fix the cause, then resend the event.
- Plan switch opens the portal home: ensure live portal plan switching is enabled with the six prices.
- Automatic tax error: finish Tax setup or leave STRIPE_AUTOMATIC_TAX off until configured.
- Build succeeded but page stayed old: inspect the active deployment on the custom-domain Worker.

## References
- [Stripe go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)
- [Stripe API keys and separate test/live objects](https://docs.stripe.com/keys)
- [Stripe webhook signatures](https://docs.stripe.com/webhooks)
- [Configure the customer portal](https://docs.stripe.com/customer-management/configure-portal)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Verification for this change
The production estimator and price validator passed their regression assertions in the available JavaScript runtime. The setup and preflight scripts passed JavaScript syntax checks. The local coding environment was unavailable, so Astro compilation and visual browser checks were not run locally. Cloudflare's GitHub build is the deployment build gate; live payment verification remains an operator step.

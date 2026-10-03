/** Shared by setup and the read-only launch check. Never prints credentials. */
export function validateStripePrice(price, expected) {
  const errors = [];
  if (!price?.active) errors.push('price is inactive');
  if (price?.type !== 'recurring') errors.push('price is not recurring');
  if (price?.currency !== expected.currency) errors.push('currency differs from the storefront');
  if (price?.unit_amount !== expected.amount) errors.push('amount differs from the storefront');
  if (price?.recurring?.interval !== expected.interval || price?.recurring?.interval_count !== 1)
    errors.push('billing interval differs from the storefront');
  if (price?.billing_scheme !== 'per_unit' || price?.recurring?.usage_type !== 'licensed')
    errors.push('price must be a fixed recurring amount, not tiered or metered');
  if (typeof expected.live === 'boolean' && price?.livemode !== expected.live) errors.push('test/live mode mismatch');
  if (price?.product && typeof price.product === 'object' && (!price.product.active || price.product.deleted))
    errors.push('product is inactive or deleted');
  return errors;
}

/** Stripe tax codes look like txcd_10103001. */
export const TAX_CODE_PATTERN = /^txcd_\d{8}$/;

/** A product's tax code id, whether Stripe sent it as an id or expanded. */
export function productTaxCode(product) {
  const code = product?.tax_code;
  return typeof code === 'string' ? code : (code?.id ?? null);
}

/**
 * What setup should do about a plan product's tax code: null when nothing was
 * asked for or it already has that code, otherwise the change to make.
 */
export function taxCodeUpdate(product, wanted) {
  if (!wanted) return null;
  const current = productTaxCode(product);
  return current === wanted ? null : { from: current, to: wanted };
}

/**
 * Why a plan product cannot be sold as it stands, or null. Only judged on an
 * expanded product; a bare id says nothing either way.
 */
export function productTaxCodeIssue(product) {
  if (!product || typeof product !== 'object' || productTaxCode(product)) return null;
  return (
    'product has no tax code. Stripe Managed Payments rejects checkout for it ' +
    '("Product tax code is required for Managed Payments"), so customers cannot subscribe. ' +
    'Set one in Stripe → Product catalog, or run STRIPE_TAX_CODE=txcd_… npm run stripe:setup ' +
    '(txcd_10103001 is SaaS for business use, txcd_10103000 SaaS for personal use; ' +
    "check Stripe's Managed Payments eligibility list first)"
  );
}

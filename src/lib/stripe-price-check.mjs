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

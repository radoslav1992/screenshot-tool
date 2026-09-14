/** Explicit allowlist: credentials, URLs, HTML and input actions never enter saved presets. */
export function presetSettings(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['device', 'mode', 'format', 'block_ads', 'dark_mode', 'hide', 'redact_pii']) {
    if (typeof input[key] === 'string') result[key] = input[key];
  }
  return result;
}
export const REVIEW_STATES = ['pending', 'approved', 'changes'] as const;
export function reportExpired(expires: string, now = Date.now()): boolean {
  return !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= now;
}

/**
 * Where to send someone after they sign in.
 *
 * `next` arrives from the query string, so it is attacker-controlled. Checking
 * that it starts with one slash is not enough: browsers read `/\evil.com` and
 * `/\t/evil.com` (tabs and newlines are stripped while parsing) as
 * `//evil.com`, which is another site. So the value is resolved the way a
 * browser would resolve it, and kept only if it lands on this origin.
 *
 * No Workers or DOM APIs: the sign-in form script imports this too.
 */
export function safeNext(value: string | null | undefined, origin: string, fallback = '/app'): string {
  const raw = value ?? '';
  if (!raw || raw.length > 2048) return fallback;

  // A path, never a scheme or a protocol-relative host.
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;

  // Backslashes and control characters are where parsers disagree; nothing we
  // link to needs either.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;

  let base: URL;
  let target: URL;
  try {
    base = new URL(origin);
    target = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (target.origin !== base.origin) return fallback;

  // `/.//evil.com` normalises to a pathname of `//evil.com`, which would read as
  // a host if it were ever echoed back on its own.
  const path = `${target.pathname}${target.search}${target.hash}`;
  if (path.startsWith('//')) return fallback;
  return path;
}

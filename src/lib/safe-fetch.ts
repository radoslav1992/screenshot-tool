import { assertPublicCaptureUrl } from './capture-options';

/**
 * Fetching an address someone gave us, from the Worker itself.
 *
 * A sitemap and a monitored page are both addresses a customer typed, and
 * both are fetched here rather than in the browser, so both need what the
 * browser's request interception gives a capture: no private destinations,
 * on the first request or after any redirect. Letting fetch follow redirects
 * would skip that check on every hop but the first, so they are followed one
 * at a time and each destination passes the same public-address and denylist
 * check (assertPublicCaptureUrl) the first URL did.
 */

export type FetchProblem =
  | 'unreachable'
  | 'timeout'
  | 'too_many_redirects'
  | 'bad_redirect'
  | 'blocked_redirect'
  | 'too_large'
  | 'interrupted';

/** Why an address could not be read, for the caller to word in its own terms. */
export class FetchFailure extends Error {
  readonly problem: FetchProblem;
  constructor(problem: FetchProblem, message: string) {
    super(message);
    this.name = 'FetchFailure';
    this.problem = problem;
  }
}

export interface PublicFetchOptions {
  /** Redirects followed after the first request; one more than this is a loop. */
  maxRedirects: number;
  /**
   * The signal each hop is sent with: a fresh timeout per hop, or one deadline
   * shared by every hop and the body.
   */
  signal: () => AbortSignal;
  headers?: Record<string, string>;
  /** Told of each redirect followed, before the next hop is asked: the SEO checker lists them. */
  onRedirect?: (hop: { url: string; status: number }) => void;
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * The first response that is not a redirect, with the address it came from.
 * Its body is left unread. The starting address is checked as a capture URL
 * is, and throws as one does when it fails.
 */
export async function fetchPublic(raw: string, options: PublicFetchOptions): Promise<{ response: Response; url: URL }> {
  let url = assertPublicCaptureUrl(raw);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetch(url.toString(), { redirect: 'manual', signal: options.signal(), headers: options.headers });
    } catch (error) {
      // DNS failures, refused connections and the timeout all land here, and
      // all of them are about the address given, not about this service.
      throw timedOut(error)
        ? new FetchFailure('timeout', 'The address took too long to answer.')
        : new FetchFailure('unreachable', 'The address could not be reached.');
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return { response, url };
    await response.body?.cancel().catch(() => undefined);
    if (hop >= options.maxRedirects) throw new FetchFailure('too_many_redirects', 'The address redirected too many times.');
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new FetchFailure('bad_redirect', 'The address redirected to something that is not a URL.');
    }
    try {
      next = assertPublicCaptureUrl(next.toString());
    } catch {
      throw new FetchFailure('blocked_redirect', 'The address redirected somewhere that cannot be fetched.');
    }
    options.onRedirect?.({ url: url.toString(), status: response.status });
    url = next;
  }
}

/**
 * A response body as text, reading no more than `maxBytes`. Past the cap,
 * `error` refuses the whole body and `truncate` keeps what fits and stops
 * reading. Null when there is no body at all.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
  overflow: 'error' | 'truncate',
  charset = 'utf-8',
): Promise<{ text: string; truncated: boolean } | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    // A label the runtime does not know reads as UTF-8: the same bytes give the same text every time.
    decoder = new TextDecoder();
  }
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        if (overflow === 'error') throw new FetchFailure('too_large', 'The response is larger than allowed.');
        text += decoder.decode(value.subarray(0, maxBytes - size), { stream: true });
        return { text: text + decoder.decode(), truncated: true };
      }
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), truncated: false };
  } catch (error) {
    if (error instanceof FetchFailure) throw error;
    // The timeout covers the body too; a stalled or dropped download ends here.
    throw new FetchFailure('interrupted', 'The address stopped answering partway through.');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The charset a Content-Type names, or UTF-8. */
export function charsetOf(contentType: string | null): string {
  return /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase() ?? 'utf-8';
}

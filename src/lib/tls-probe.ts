import { connect } from 'cloudflare:sockets';

/**
 * The certificate a site actually serves, read without a TLS library.
 *
 * Workers' fetch() checks a certificate and tells us nothing about it, so the
 * expiry date has to be read off the wire. In TLS 1.2 the server's
 * Certificate message travels in the clear, right after its ServerHello, in
 * answer to the very first thing a client sends. So this opens a plain TCP
 * socket, sends a minimal TLS 1.2 ClientHello, reads until the Certificate
 * message has arrived and closes the socket: the handshake is never completed,
 * no key is agreed and nothing is encrypted or sent after the hello.
 *
 * Everything read is a stranger's bytes. Reading stops at TLS_READ_LIMIT and
 * after TLS_TIMEOUT_MS, every length is checked against what is actually
 * there, and anything unexpected ends the read as "malformed" rather than
 * being guessed at. Only the leaf certificate is parsed, and only as far as
 * its validity dates, issuer and subject names and subjectAltName.
 *
 * What this cannot do: talk to a server that accepts only TLS 1.3 (it answers
 * with an alert, and the certificate is encrypted there), and reach sites
 * behind Cloudflare, since Workers may not open sockets to Cloudflare's own
 * addresses. Callers fall back to whether HTTPS works at all (site-health.ts).
 */

export const TLS_READ_LIMIT = 64 * 1024;
export const TLS_TIMEOUT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* The ClientHello                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The cipher suites browsers offer for TLS 1.2, ECDHE first, plus plain RSA
 * for old servers and the renegotiation SCSV. Offering what a browser offers
 * is what makes a server pick the certificate a browser would get.
 */
export const CIPHER_SUITES = [
  0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc009, 0xc013, 0xc00a, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035,
  0x00ff,
];
/** x25519, secp256r1, secp384r1. */
export const GROUPS = [0x001d, 0x0017, 0x0018];
/** ECDSA and RSA-PSS/PKCS#1 with SHA-256, -384 and -512, and SHA-1 for the oldest servers. */
export const SIGNATURE_ALGORITHMS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201, 0x0203];

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const extension = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];

/** An address rather than a name: SNI must not carry one (RFC 6066). */
export function isIpLiteral(host: string): boolean {
  return host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** A TLS 1.2 ClientHello for `host`, as one handshake record. `random` is fixed only by tests. */
export function clientHello(host: string, random: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): Uint8Array {
  const name = host.toLowerCase().replace(/\.+$/, '');
  const extensions: number[] = [];
  if (!isIpLiteral(name) && name.length > 0 && name.length <= 253 && /^[\x21-\x7e]+$/.test(name)) {
    const bytes = [...new TextEncoder().encode(name)];
    extensions.push(...extension(0x0000, [...u16(bytes.length + 3), 0x00, ...u16(bytes.length), ...bytes]));
  }
  const groups = GROUPS.flatMap(u16);
  extensions.push(...extension(0x000a, [...u16(groups.length), ...groups]));
  extensions.push(...extension(0x000b, [0x01, 0x00]));
  const algorithms = SIGNATURE_ALGORITHMS.flatMap(u16);
  extensions.push(...extension(0x000d, [...u16(algorithms.length), ...algorithms]));

  const suites = CIPHER_SUITES.flatMap(u16);
  const body = [
    0x03, 0x03,
    ...random.subarray(0, 32),
    0x00,
    ...u16(suites.length), ...suites,
    0x01, 0x00,
    ...u16(extensions.length), ...extensions,
  ];
  const handshake = [0x01, ...u24(body.length), ...body];
  return new Uint8Array([0x16, 0x03, 0x01, ...u16(handshake.length), ...handshake]);
}

/* -------------------------------------------------------------------------- */
/* What the server sends back                                                  */
/* -------------------------------------------------------------------------- */

export type HandshakeRead =
  | { kind: 'more' }
  | { kind: 'certificate'; der: Uint8Array; version: number }
  | { kind: 'alert'; level: number; description: number }
  | { kind: 'error'; reason: string };

/** A TLS record may carry at most 2^14 bytes plus expansion. */
const MAX_RECORD = 16_384 + 2_048;

/**
 * Reads the server's first flight from everything received so far: the
 * ServerHello, then the Certificate message, reassembled across records.
 * "more" means the bytes so far are a valid start and the rest has not
 * arrived. Called again with the whole buffer after each read, which at
 * TLS_READ_LIMIT bytes at most costs nothing worth keeping state for.
 */
export function readServerHandshake(bytes: Uint8Array): HandshakeRead {
  const fragments: Uint8Array[] = [];
  let at = 0;
  while (at + 5 <= bytes.length) {
    const type = bytes[at]!;
    const length = (bytes[at + 3]! << 8) | bytes[at + 4]!;
    if (bytes[at + 1] !== 0x03) return { kind: 'error', reason: 'The server did not answer with TLS.' };
    if (length === 0 || length > MAX_RECORD) return { kind: 'error', reason: 'The server sent a TLS record of an impossible size.' };
    if (at + 5 + length > bytes.length) break;
    const fragment = bytes.subarray(at + 5, at + 5 + length);
    if (type === 21) {
      if (length < 2) return { kind: 'error', reason: 'The server sent a truncated alert.' };
      return { kind: 'alert', level: fragment[0]!, description: fragment[1]! };
    }
    if (type !== 22) return { kind: 'error', reason: 'The server sent something other than a handshake.' };
    fragments.push(fragment);
    at += 5 + length;
  }
  if (at < bytes.length && at + 5 > bytes.length && bytes[at] !== 22 && bytes[at] !== 21) {
    return { kind: 'error', reason: 'The server did not answer with TLS.' };
  }

  const size = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
  const stream = new Uint8Array(size);
  let offset = 0;
  for (const fragment of fragments) {
    stream.set(fragment, offset);
    offset += fragment.length;
  }

  let version = 0;
  for (let p = 0; p + 4 <= stream.length; ) {
    const type = stream[p]!;
    const length = (stream[p + 1]! << 16) | (stream[p + 2]! << 8) | stream[p + 3]!;
    if (p + 4 + length > stream.length) return { kind: 'more' };
    const body = stream.subarray(p + 4, p + 4 + length);
    if (type === 2) {
      if (version || length < 2) return { kind: 'error', reason: 'The server sent an unexpected ServerHello.' };
      version = (body[0]! << 8) | body[1]!;
      if (version < 0x0301 || version > 0x0303) return { kind: 'error', reason: 'The server chose a TLS version this check does not read.' };
    } else if (type === 11) {
      if (!version) return { kind: 'error', reason: 'The server sent its certificate before saying hello.' };
      return leafCertificate(body, version);
    } else {
      // A ServerKeyExchange or ServerHelloDone before any Certificate means there is no certificate to read.
      return { kind: 'error', reason: version ? 'The server sent no certificate.' : 'The server did not start with a ServerHello.' };
    }
    p += 4 + length;
  }
  return { kind: 'more' };
}

function leafCertificate(body: Uint8Array, version: number): HandshakeRead {
  if (body.length < 6) return { kind: 'error', reason: 'The server sent an empty certificate list.' };
  const total = (body[0]! << 16) | (body[1]! << 8) | body[2]!;
  const first = (body[3]! << 16) | (body[4]! << 8) | body[5]!;
  if (total + 3 !== body.length || first === 0 || first + 3 > total) {
    return { kind: 'error', reason: 'The server sent a malformed certificate list.' };
  }
  return { kind: 'certificate', der: body.slice(6, 6 + first), version };
}

/* -------------------------------------------------------------------------- */
/* X.509, as far as it is needed                                               */
/* -------------------------------------------------------------------------- */

export class CertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateError';
  }
}

export interface Certificate {
  notBefore: Date;
  notAfter: Date;
  issuer: { commonName: string | null; organization: string | null };
  subject: { commonName: string | null };
  /** subjectAltName dNSName entries, lowercased. */
  dnsNames: string[];
  /** subjectAltName iPAddress entries, as text. */
  ipAddresses: string[];
  /** Issued by itself: the issuer and subject names are the same bytes. */
  selfSigned: boolean;
}

interface Tlv {
  tag: number;
  /** Where the contents start and end. */
  start: number;
  end: number;
  /** Where the next TLV starts: the end of this one's header and contents. */
  next: number;
}

/** One DER TLV at `at`, which must end by `limit`. Throws on anything DER does not allow. */
function tlv(bytes: Uint8Array, at: number, limit: number): Tlv {
  if (at + 2 > limit) throw new CertificateError('Truncated certificate.');
  const tag = bytes[at]!;
  if ((tag & 0x1f) === 0x1f) throw new CertificateError('Unsupported tag in the certificate.');
  let length = bytes[at + 1]!;
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 3) throw new CertificateError('Unsupported length in the certificate.');
    if (at + 2 + count > limit) throw new CertificateError('Truncated certificate.');
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[at + 2 + i]!;
    header += count;
  }
  const start = at + header;
  const end = start + length;
  if (end > limit) throw new CertificateError('Truncated certificate.');
  return { tag, start, end, next: end };
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = tlv(bytes, at, parent.end);
    out.push(child);
    at = child.next;
  }
  return out;
}

function expect(node: Tlv | undefined, tag: number, what: string): Tlv {
  if (!node || node.tag !== tag) throw new CertificateError(`The certificate's ${what} is missing or malformed.`);
  return node;
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const OID_COMMON_NAME = new Uint8Array([0x55, 0x04, 0x03]);
const OID_ORGANIZATION = new Uint8Array([0x55, 0x04, 0x0a]);
const OID_SUBJECT_ALT_NAME = new Uint8Array([0x55, 0x1d, 0x11]);

/** The text of a directory string, cleaned of control characters and capped. */
function text(bytes: Uint8Array, node: Tlv): string {
  const raw = bytes.subarray(node.start, node.end);
  let value: string;
  if (node.tag === 0x0c) value = new TextDecoder().decode(raw);
  else if (node.tag === 0x1e) {
    value = '';
    for (let i = 0; i + 1 < raw.length; i += 2) value += String.fromCharCode((raw[i]! << 8) | raw[i + 1]!);
  } else if ([0x13, 0x16, 0x14, 0x1a].includes(node.tag)) value = String.fromCharCode(...raw.subarray(0, 512));
  else throw new CertificateError('Unsupported string in the certificate.');
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

function nameParts(bytes: Uint8Array, name: Tlv): { commonName: string | null; organization: string | null } {
  let commonName: string | null = null;
  let organization: string | null = null;
  for (const set of children(bytes, name)) {
    expect(set, 0x31, 'name');
    for (const pair of children(bytes, set)) {
      const [oid, value] = children(bytes, expect(pair, 0x30, 'name'));
      const id = bytes.subarray(expect(oid, 0x06, 'name').start, oid!.end);
      if (!value) throw new CertificateError("The certificate's name is malformed.");
      if (equalBytes(id, OID_COMMON_NAME)) commonName ??= text(bytes, value);
      else if (equalBytes(id, OID_ORGANIZATION)) organization ??= text(bytes, value);
    }
  }
  return { commonName, organization };
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSS[.fff]Z), as DER writes them. */
function time(bytes: Uint8Array, node: Tlv): Date {
  const raw = String.fromCharCode(...bytes.subarray(node.start, Math.min(node.end, node.start + 32)));
  const match =
    node.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(raw)
      : node.tag === 0x18
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d{1,6})?Z$/.exec(raw)
        : null;
  if (!match) throw new CertificateError("The certificate's validity dates are malformed.");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  // RFC 5280: a two-digit year of 50 or more is 19xx.
  const fullYear = node.tag === 0x17 ? (year >= 50 ? 1900 + year : 2000 + year) : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day, hour, minute, second));
  if (
    fullYear < 1950 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 ||
    date.getUTCDate() !== day || date.getUTCMonth() !== month - 1
  ) {
    throw new CertificateError("The certificate's validity dates are malformed.");
  }
  return date;
}

function ipText(raw: Uint8Array): string | null {
  if (raw.length === 4) return [...raw].join('.');
  if (raw.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(((raw[i]! << 8) | raw[i + 1]!).toString(16));
    return groups.join(':');
  }
  return null;
}

/**
 * The parts of a DER certificate a health check needs. Throws CertificateError
 * for anything malformed; never reads outside `der`.
 */
export function parseCertificate(der: Uint8Array): Certificate {
  const certificate = expect(tlv(der, 0, der.length), 0x30, 'outer structure');
  if (certificate.end !== der.length) throw new CertificateError('The certificate has trailing bytes.');
  const tbs = expect(children(der, certificate)[0], 0x30, 'body');
  const fields = children(der, tbs);
  const at = fields[0]?.tag === 0xa0 ? 1 : 0;
  expect(fields[at], 0x02, 'serial number');
  expect(fields[at + 1], 0x30, 'signature algorithm');
  const issuer = expect(fields[at + 2], 0x30, 'issuer');
  const validity = children(der, expect(fields[at + 3], 0x30, 'validity'));
  const subject = expect(fields[at + 4], 0x30, 'subject');
  expect(fields[at + 5], 0x30, 'public key');
  if (validity.length !== 2) throw new CertificateError("The certificate's validity is malformed.");

  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  const extensions = fields.slice(at + 6).find((field) => field.tag === 0xa3);
  if (extensions) {
    for (const entry of children(der, expect(children(der, extensions)[0], 0x30, 'extensions'))) {
      const parts = children(der, expect(entry, 0x30, 'extension'));
      const oid = expect(parts[0], 0x06, 'extension');
      if (!equalBytes(der.subarray(oid.start, oid.end), OID_SUBJECT_ALT_NAME)) continue;
      const value = expect(parts[parts.length - 1], 0x04, 'subjectAltName');
      const names = expect(tlv(der, value.start, value.end), 0x30, 'subjectAltName');
      for (const name of children(der, names)) {
        if (dnsNames.length + ipAddresses.length >= 500) break;
        const raw = der.subarray(name.start, name.end);
        if (name.tag === 0x82) dnsNames.push(String.fromCharCode(...raw.subarray(0, 253)).toLowerCase());
        else if (name.tag === 0x87) {
          const ip = ipText(raw);
          if (ip) ipAddresses.push(ip);
        }
      }
    }
  }

  return {
    notBefore: time(der, validity[0]!),
    notAfter: time(der, validity[1]!),
    issuer: nameParts(der, issuer),
    subject: { commonName: nameParts(der, subject).commonName },
    dnsNames,
    ipAddresses,
    selfSigned: equalBytes(der.subarray(issuer.start, issuer.end), der.subarray(subject.start, subject.end)),
  };
}

/** Whether a certificate's names cover `host`. A wildcard covers exactly one label, as browsers apply it. */
export function certificateCovers(certificate: Pick<Certificate, 'dnsNames' | 'ipAddresses' | 'subject'>, host: string): boolean {
  const target = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIpLiteral(target)) return certificate.ipAddresses.includes(target);
  // Only a certificate with no DNS names at all is matched on its common name, the way browsers used to.
  const names = certificate.dnsNames.length ? certificate.dnsNames : certificate.subject.commonName ? [certificate.subject.commonName.toLowerCase()] : [];
  return names.some((raw) => {
    const name = raw.replace(/\.+$/, '');
    if (name === target) return true;
    if (!name.startsWith('*.')) return false;
    const suffix = name.slice(1);
    const label = target.slice(0, -suffix.length);
    return target.endsWith(suffix) && label.length > 0 && !label.includes('.');
  });
}

/** Who issued it, as people name a certificate authority: "Let's Encrypt (R11)". */
export function issuerName(certificate: Pick<Certificate, 'issuer'>): string | null {
  const { organization, commonName } = certificate.issuer;
  if (organization && commonName && organization !== commonName) return `${organization} (${commonName})`;
  return organization ?? commonName;
}

/* -------------------------------------------------------------------------- */
/* Reading it from a server                                                    */
/* -------------------------------------------------------------------------- */

export type ProbeFailure = {
  ok: false;
  /** alert: the server refused TLS 1.2; blocked: no socket could be opened; the rest are what they say. */
  reason: 'alert' | 'blocked' | 'timeout' | 'closed' | 'malformed' | 'too_large';
  detail: string;
  alert?: number;
};
export type ProbeResult = { ok: true; certificate: Certificate; version: number } | ProbeFailure;

const ALERTS: Record<number, string> = {
  40: 'the server refused the TLS 1.2 settings offered, so it may only accept TLS 1.3',
  70: 'the server only accepts TLS 1.3, which keeps the certificate encrypted',
  71: 'the server only accepts newer TLS settings',
  112: 'the server does not recognise this host name',
};

const fail = (reason: ProbeFailure['reason'], detail: string, alert?: number): ProbeFailure => ({
  ok: false,
  reason,
  detail,
  ...(alert === undefined ? {} : { alert }),
});

/**
 * Opens a socket to `host:port`, sends the ClientHello and reads the leaf
 * certificate. Never throws, and always closes the socket.
 */
export async function probeCertificate(
  host: string,
  port = 443,
  limits: { timeoutMs: number; maxBytes: number } = { timeoutMs: TLS_TIMEOUT_MS, maxBytes: TLS_READ_LIMIT },
): Promise<ProbeResult> {
  const hostname = host.replace(/^\[|\]$/g, '');
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async (): Promise<ProbeResult> => {
    try {
      socket = connect({ hostname, port }, { secureTransport: 'off', allowHalfOpen: false });
      await socket.opened;
    } catch (error) {
      return fail('blocked', blockedDetail(error));
    }
    try {
      const writer = socket.writable.getWriter();
      await writer.write(clientHello(hostname));
      writer.releaseLock();
      const reader = socket.readable.getReader();
      let buffer = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return fail('closed', 'the server closed the connection before sending its certificate');
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
        if (buffer.length + chunk.length > limits.maxBytes) return fail('too_large', 'the server sent more than a certificate is worth');
        const next = new Uint8Array(buffer.length + chunk.length);
        next.set(buffer);
        next.set(chunk, buffer.length);
        buffer = next;
        const answer = readServerHandshake(buffer);
        if (answer.kind === 'more') continue;
        if (answer.kind === 'alert') {
          return fail('alert', ALERTS[answer.description] ?? `the server ended the handshake (TLS alert ${answer.description})`, answer.description);
        }
        if (answer.kind === 'error') return fail('malformed', answer.reason.replace(/^\w/, (c) => c.toLowerCase()).replace(/\.$/, ''));
        try {
          return { ok: true, certificate: parseCertificate(answer.der), version: answer.version };
        } catch (error) {
          return fail('malformed', error instanceof CertificateError ? error.message.replace(/^\w/, (c) => c.toLowerCase()).replace(/\.$/, '') : 'the certificate could not be read');
        }
      }
    } catch {
      return fail('closed', 'the connection dropped before the certificate arrived');
    }
  };

  try {
    return await Promise.race([
      read(),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => resolve(fail('timeout', `the server did not send its certificate within ${Math.round(limits.timeoutMs / 1000)} seconds`)), limits.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Closing also ends a read still waiting after a timeout.
    try {
      await socket?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

function blockedDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Workers refuse sockets to Cloudflare's own addresses: the site is behind Cloudflare.
  if (/cannot connect to the specified address|disallowed|prohibited/i.test(message)) {
    return 'the site is behind a network that does not allow reading its certificate directly (often Cloudflare)';
  }
  return 'a direct connection to the site could not be opened';
}

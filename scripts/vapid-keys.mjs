#!/usr/bin/env node
/*
 * Makes a VAPID key pair for Web Push with Node's WebCrypto, and prints the
 * commands that store it as Worker secrets. Nothing is written to disk or sent
 * anywhere; the private key exists only in this terminal's output.
 *
 *   npm run vapid:keys
 *   npm run vapid:keys -- mailto:alerts@example.com
 *
 * The subject is how a push service can reach whoever sends the alerts: a
 * mailto: or https: address, the company address when none is given.
 *
 * Keep the pair once it is in use. Every browser subscription is tied to the
 * public key it was made with, so a new pair silently stops alerts to every
 * subscribed browser until each one turns alerts on again.
 */

const subject = process.argv[2] ?? 'mailto:hello@easyscreencapture.com';
if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) {
  console.error(`The subject must be a mailto: or https: address, not "${subject}".`);
  process.exit(1);
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
// The public key as browsers take it (applicationServerKey): the 65-byte
// uncompressed point. The private key as its 32-byte scalar, which the Worker
// pairs with the public key; a PKCS8 PEM works there too.
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const { d: privateKey } = await crypto.subtle.exportKey('jwk', pair.privateKey);

const put = (name, value) => `printf '%s' '${value}' | npx wrangler secret put ${name}`;
console.log(`A new VAPID key pair for Web Push. Set all three as secrets:

${put('VAPID_PUBLIC_KEY', publicKey)}
${put('VAPID_PRIVATE_KEY', privateKey)}
${put('VAPID_SUBJECT', subject)}

For a local dev server, put the same three lines in .dev.vars instead:

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=${subject}

Web push stays off until all three are set and migration 0018 is applied.`);

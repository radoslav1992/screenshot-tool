import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const row = { id: 'capture', user_id: 'owner', share_token: 'valid-token', host: 'example.test', files: '[]', source: 'watch' };
let reads = 0;
let mode = 'body';
let lastKey = '';
globalThis.__fileAccess = {
  getCapture: async () => row,
  safeParseFiles: () => [{ name: 'capture.png', key: 'private.png', contentType: 'image/png' }],
  env: {
    SHOTS: {
      get: async (key) => {
        reads++;
        lastKey = key;
        return {
          writeHttpMetadata() {},
          httpEtag: '"test"',
          size: 4,
          ...(mode === 'conditional' ? {} : { body: 'test' }),
          ...(mode === 'range' ? { range: { offset: 0, length: 4 } } : {}),
          ...(mode === 'suffix' ? { range: { suffix: 2 } } : {}),
        };
      },
    },
  },
};
const source = readFileSync(new URL('../src/pages/f/[id]/[name].ts', import.meta.url), 'utf8')
  .replace("import { env } from 'cloudflare:workers';", 'const {env} = globalThis.__fileAccess;')
  .replace(
    "import { getCapture, safeParseFiles } from '../../../lib/captures';",
    'const {getCapture,safeParseFiles} = globalThis.__fileAccess;',
  )
  .replace(
    "import { HIGHLIGHT_NAME, highlightFile } from '../../../lib/change-highlights';",
    "const HIGHLIGHT_NAME = 'changes.jpg'; const highlightFile = (r) => ({ name: HIGHLIGHT_NAME, key: `captures/${r.user_id}/${r.id}/${HIGHLIGHT_NAME}`, contentType: 'image/jpeg' });",
  )
  .replace(
    "import { timingSafeEqual } from '../../../lib/ids';",
    `import { timingSafeEqual } from '${new URL('../src/lib/ids.ts', import.meta.url).href}';`,
  );
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { GET } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const get = (token = '', user, range = false, name = 'capture.png') => {
  const url = new URL(`https://example.test/f/capture/${name}`);
  if (token) url.searchParams.set('t', token);
  return GET({
    params: { id: 'capture', name },
    locals: { user: user ? { id: user } : null },
    url,
    request: new Request(url, { headers: range ? { range: range === true ? 'bytes=0-3' : range } : {} }),
  });
};
for (const [token, user] of [
  ['', undefined],
  ['wrong-token', undefined],
  ['', 'other'],
]) {
  const response = await get(token, user);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}
assert.equal(reads, 0, 'Unauthorized requests must never read storage');
assert.equal((await get('', 'owner')).headers.get('access-control-allow-origin'), null);
for (const [nextMode, expected, contentRange] of [
  ['body', 200, null],
  ['conditional', 304, null],
  ['range', 206, 'bytes 0-3/4'],
  // `bytes=-2`: the last two bytes are still a partial response.
  ['suffix', 206, 'bytes 2-3/4'],
]) {
  mode = nextMode;
  const range = mode === 'range' ? true : mode === 'suffix' ? 'bytes=-2' : false;
  const response = await get('valid-token', undefined, range);
  assert.equal(response.status, expected);
  assert.equal(response.headers.get('content-range'), contentRange);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}
// A monitor check's highlighted copy is not in its manifest, yet loads from the same token URL.
mode = 'body';
let response = await get('valid-token', undefined, false, 'changes.jpg');
assert.equal(response.status, 200);
assert.equal(lastKey, 'captures/owner/capture/changes.jpg');
assert.equal(response.headers.get('content-type'), 'image/jpeg');
const readsBefore = reads;
assert.equal((await get('wrong-token', undefined, false, 'changes.jpg')).status, 404, 'the highlight needs the token too');
assert.equal((await get('valid-token', undefined, false, 'other.jpg')).status, 404, 'no other name falls through');
row.source = 'app';
assert.equal((await get('valid-token', undefined, false, 'changes.jpg')).status, 404, 'only monitor captures have one');
assert.equal(reads, readsBefore, 'refused names never read storage');
delete globalThis.__fileAccess;
console.log('File access checks passed: unauthorized requests, owner privacy, token CORS for 200/206/304, suffix ranges, and monitor change highlights.');

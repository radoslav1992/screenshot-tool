import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const row = { id: 'capture', user_id: 'owner', share_token: 'valid-token', host: 'example.test', files: '[]' };
let reads = 0;
let mode = 'body';
globalThis.__fileAccess = {
  getCapture: async () => row,
  safeParseFiles: () => [{ name: 'capture.png', key: 'private.png', contentType: 'image/png' }],
  env: {
    SHOTS: {
      get: async () => {
        reads++;
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
    "import { timingSafeEqual } from '../../../lib/ids';",
    `import { timingSafeEqual } from '${new URL('../src/lib/ids.ts', import.meta.url).href}';`,
  );
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { GET } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const get = (token = '', user, range = false) => {
  const url = new URL('https://example.test/f/capture/capture.png');
  if (token) url.searchParams.set('t', token);
  return GET({
    params: { id: 'capture', name: 'capture.png' },
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
delete globalThis.__fileAccess;
console.log('File access checks passed: unauthorized requests, owner privacy, and token CORS for 200/206/304, and suffix ranges.');

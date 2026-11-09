import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

// Returns count distinct free ports. All servers stay open until every port is
// allocated, otherwise the OS may hand out the same port twice.
async function unusedPorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map((server) =>
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}

const mokapiConfig = (apiPort, filenames) => `api:
  port: ${apiPort}
health:
  enabled: false
mcp:
  server:
    enabled: false
providers:
  file:
    filenames:
${filenames.map((filename) => `      - ${filename}`).join('\n')}
javascript:
  modules:
    aliases:
      msw: mokapi-msw-adapter
`;

async function linkAdapter(directory) {
  await mkdir(join(directory, 'node_modules'));
  await symlink(fileURLToPath(new URL('../', import.meta.url)),
    join(directory, 'node_modules/mokapi-msw-adapter'), 'dir');
}

// Starts Mokapi in directory and waits until isReady() passes, i.e. the mock script has registered.
async function startMokapi(directory, isReady) {
  const require = createRequire(import.meta.url);
  const mokapiRequire = createRequire(require.resolve('go-mokapi/package.json'));
  const binary = mokapiRequire(`@go-mokapi/${process.platform}-${process.arch}`);
  const child = spawn(binary, [], { cwd: directory, stdio: ['inherit', 'pipe', 'pipe'] });
  let output = '';
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { output += chunk; target.write(chunk); });
  }
  let startupError;
  child.on('error', (error) => { startupError = error; });
  const stopped = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('close', resolve); // after the output streams are drained
  });
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await stopped;
  };
  stop.output = () => output;
  const deadline = Date.now() + 15000;
  while (true) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Mokapi exited with code ${child.exitCode}`);
    try {
      await isReady();
      return stop;
    } catch (error) {
      if (Date.now() >= deadline) {
        await stop();
        throw new Error(`Mokapi startup failed\n${output}`, { cause: error });
      }
      await setTimeout(100);
    }
  }
}

const getJson = async (url, timeout = 1000) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  assert.equal(response.status, 200, url);
  return response.json();
};

test('without api, handlers apply to every API; with api, only to that API', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-adapter-'));
  let stop;
  try {
    const [port, apiPort] = await unusedPorts(2);
    // Both APIs share one port and are told apart by host name. Separate ports
    // would hit a Mokapi 0.56.0 startup race that stops one of the servers.
    const baseA = `http://localhost:${port}`;
    const baseB = `http://127.0.0.1:${port}`;
    const operation = { get: { responses: { 200: {
      description: 'Mock response',
      content: { 'application/json': { schema: {
        type: 'object', required: ['source'], properties: { source: { type: 'string' } },
      } } },
    } } } };
    for (const [name, base] of [['A', baseA], ['B', baseB]]) {
      await writeFile(join(directory, `contract-${name}.json`), JSON.stringify({
        openapi: '3.1.0',
        info: { title: `API ${name}`, version: '1.0.0' },
        servers: [{ url: base }],
        paths: { '/shared': operation, '/scoped': operation },
      }));
    }
    await linkAdapter(directory);
    await writeFile(join(directory, 'mocks.js'), `
import { http, HttpResponse } from 'msw';
import { register } from 'mokapi-msw-adapter/register';
export default function () {
  register({ success: [http.get('/shared', () => HttpResponse.json({ source: 'adapter' }))] });
  register(
    { success: [http.get('/scoped', () => HttpResponse.json({ source: 'adapter' }))] },
    { api: 'API A' },
  );
}`);
    await writeFile(join(directory, 'mokapi.yaml'),
      mokapiConfig(apiPort, ['contract-A.json', 'contract-B.json', 'mocks.js']));

    stop = await startMokapi(directory, async () => {
      assert.deepEqual(await getJson(`${baseA}/scoped`), { source: 'adapter' });
    });

    assert.deepEqual(await getJson(`${baseA}/shared`), { source: 'adapter' });
    assert.deepEqual(await getJson(`${baseB}/shared`), { source: 'adapter' });
    assert.notDeepEqual(await getJson(`${baseB}/scoped`), { source: 'adapter' });
  } finally {
    if (stop) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenarioParameter of ['__mockScenario', 'example']) {
  test(`native Mokapi with aliases and scenario parameter ${scenarioParameter}`, { timeout: 45000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mokapi-adapter-'));
    let stop;
    try {
      const [port, apiPort] = await unusedPorts(2);
      const base = `http://localhost:${port}`;
      const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'QUERY', 'PURGE'];
      const operation = {
        responses: {
          200: {
            description: 'Mock response',
            content: { 'application/json': { schema: {
              type: 'object', required: ['method'], properties: { method: { type: 'string' } },
            } } },
          },
        },
      };
      const path = Object.fromEntries(methods.filter((method) => method !== 'PURGE')
        .map((method) => [method.toLowerCase(), operation]));
      path.additionalOperations = { PURGE: operation };
      await writeFile(join(directory, 'contract.json'), JSON.stringify({
        openapi: '3.2.0',
        info: { title: 'Adapter integration', version: '1.0.0' },
        servers: [{ url: base }],
        paths: { '/test': path },
      }));
      await linkAdapter(directory);
      await writeFile(join(directory, 'mocks.js'), `
import { http, HttpHandler, HttpResponse } from 'msw';
import { register } from 'mokapi-msw-adapter/register';
export default function () {
  const resolver = ({ request }) => {
    console.log('adapter integration log');
    return HttpResponse.json({ method: request.method });
  };
  register({
    success: [${methods.map((method) => ['QUERY', 'PURGE'].includes(method)
      ? `new HttpHandler('${method}', '/test', resolver)`
      : `http.${method.toLowerCase()}('/test', resolver)`).join(',')}],
    all: [http.all('/test', resolver)],
    pattern: [new HttpHandler(/POST|QUERY/, '/test', resolver)],
    invalid: [http.get('/test', () => HttpResponse.json({ method: 123 }))],
  }, { api: 'Adapter integration', scenarioParameter: ${JSON.stringify(scenarioParameter)} });
}`);
      await writeFile(join(directory, 'mokapi.yaml'), mokapiConfig(apiPort, ['contract.json', 'mocks.js']));
      stop = await startMokapi(directory, async () => {
        assert.deepEqual(await getJson(`${base}/test`), { method: 'GET' });
      });
      for (const method of methods) {
        for (const scenario of ['success', 'all', ...(['POST', 'QUERY'].includes(method) ? ['pattern'] : [])]) {
          const response = await fetch(`${base}/test?${scenarioParameter}=${scenario}`, {
            method, signal: AbortSignal.timeout(3000),
          });
          assert.equal(response.status, 200, `${method} / ${scenario}`);
          if (method !== 'HEAD') assert.deepEqual(await response.json(), { method });
        }
      }
      const response = await fetch(`${base}/test?${scenarioParameter}=%69nvalid`);
      assert.equal(response.status, 500);
      assert.match(await response.text(), /expected string but got integer/);
      const events = await fetch(`http://localhost:${apiPort}/api/events?traits%5Bnamespace%5D=http&size=100`);
      assert.equal(events.status, 200);
      assert.match(JSON.stringify(await events.json()), /adapter integration log/);
    } finally {
      if (stop) await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// Fetches url and returns the body with the elapsed milliseconds. The timeout is
// longer than in getJson because delayed responses are expected.
async function getTimedJson(url) {
  const start = performance.now();
  const body = await getJson(url, 5000);
  return { body, elapsed: performance.now() - start };
}

test('await delay() in a resolver delays only that response', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-adapter-'));
  let stop;
  try {
    const [port, apiPort] = await unusedPorts(2);
    const base = `http://localhost:${port}`;
    const operation = { get: { responses: { 200: {
      description: 'Mock response',
      content: { 'application/json': { schema: {
        type: 'object', required: ['source'], properties: { source: { type: 'string' } },
      } } },
    } } } };
    await writeFile(join(directory, 'contract.json'), JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Adapter delay', version: '1.0.0' },
      servers: [{ url: base }],
      paths: { '/profile': operation, '/status': operation },
    }));
    await linkAdapter(directory);
    await writeFile(join(directory, 'mocks.js'), `
import { http, HttpResponse, delay } from 'msw';
import { register } from 'mokapi-msw-adapter/register';
const respond = (path, beforeResponse = () => {}) => http.get(path, async () => {
  await beforeResponse();
  return HttpResponse.json({ source: 'adapter' });
});
export default function () {
  register({
    success: [respond('/profile'), respond('/status')],
    fixed: [respond('/profile', () => delay(300))],
    random: [respond('/profile', () => delay())],
    real: [respond('/profile', () => delay('real'))],
    slow: [respond('/profile', () => delay(2000))],
    unawaited: [respond('/profile', () => { delay(2000); })],
    invalid: [respond('/profile', () => delay('foo'))],
    infinite: [respond('/profile', () => delay('infinite'))],
    tooLarge: [respond('/profile', () => delay(2147483648))],
  });
}`);
    await writeFile(join(directory, 'mokapi.yaml'), mokapiConfig(apiPort, ['contract.json', 'mocks.js']));

    stop = await startMokapi(directory, async () => {
      assert.deepEqual(await getJson(`${base}/profile`), { source: 'adapter' });
    });

    const adapter = { source: 'adapter' };
    const profile = (scenario) => getTimedJson(`${base}/profile?__mockScenario=${scenario}`);

    const fixed = await profile('fixed');
    assert.deepEqual(fixed.body, adapter);
    assert.ok(fixed.elapsed >= 300, `fixed: ${fixed.elapsed} ms`);

    for (const scenario of ['random', 'real']) {
      const { body, elapsed } = await profile(scenario);
      assert.deepEqual(body, adapter);
      assert.ok(elapsed >= 100 && elapsed < 3000, `${scenario}: ${elapsed} ms`);
    }

    const [slow, status] = await Promise.all([
      profile('slow'),
      setTimeout(100).then(() => getTimedJson(`${base}/status`)),
    ]);
    assert.deepEqual(slow.body, adapter);
    assert.ok(slow.elapsed >= 2000, `slow: ${slow.elapsed} ms`);
    assert.deepEqual(status.body, adapter);
    assert.ok(status.elapsed < 1000, `status while another request waits: ${status.elapsed} ms`);

    const unawaited = await profile('unawaited');
    assert.deepEqual(unawaited.body, adapter);
    assert.ok(unawaited.elapsed < 1000, `unawaited: ${unawaited.elapsed} ms`);

    for (const scenario of ['invalid', 'infinite', 'tooLarge']) {
      assert.notDeepEqual((await profile(scenario)).body, adapter, scenario);
    }
  } finally {
    if (stop) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});

const basePathCases = [
  { name: 'a handler written for the request path matches when the server URL has a base path',
    basePath: '/v1', handlerPath: '/v1/users', answeredByAdapter: true },
  { name: 'a handler matches when the server URL has a base path with several segments',
    basePath: '/api/v1', handlerPath: '/api/v1/users', answeredByAdapter: true },
  { name: 'a handler written without the base path is not matched and logs no error',
    basePath: '/v1', handlerPath: '/users', answeredByAdapter: false },
];

for (const { name, basePath, handlerPath, answeredByAdapter } of basePathCases) {
  test(name, { timeout: 45000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mokapi-adapter-'));
    let stop;
    try {
      const [port, apiPort] = await unusedPorts(2);
      const base = `http://localhost:${port}${basePath}`;
      const operation = { get: { responses: { 200: {
        description: 'Mock response',
        content: { 'application/json': { schema: {
          type: 'object', required: ['source'], properties: { source: { type: 'string' } },
        } } },
      } } } };
      await writeFile(join(directory, 'contract.json'), JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Adapter base path', version: '1.0.0' },
        servers: [{ url: base }],
        paths: { '/users': operation, '/status': operation },
      }));
      await linkAdapter(directory);
      await writeFile(join(directory, 'mocks.js'), `
import { http, HttpResponse } from 'msw';
import { app } from 'mokapi';
import { register } from 'mokapi-msw-adapter/register';
export default function () {
  // Native route, so readiness does not depend on the adapter under test.
  app.http().get('/status', (request, response) => { response.data = { source: 'ready' }; });
  register({ success: [http.get('${handlerPath}', () => HttpResponse.json({ source: 'adapter' }))] });
}`);
      await writeFile(join(directory, 'mokapi.yaml'), mokapiConfig(apiPort, ['contract.json', 'mocks.js']));

      stop = await startMokapi(directory, async () => {
        assert.deepEqual(await getJson(`${base}/status`), { source: 'ready' });
      });

      // Generated data is a random string, so it never equals 'adapter'.
      const users = await getJson(`${base}/users`);
      if (answeredByAdapter) assert.deepEqual(users, { source: 'adapter' });
      else assert.notDeepEqual(users, { source: 'adapter' });
      await stop();
      assert.doesNotMatch(stop.output(), /No shared mock/);
    } finally {
      if (stop) await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// [request path, handler that answers (with its params), or undefined for generated data]
const handlerPathCases = [
  ['/v1/users/42', { handler: 'user', params: { id: '42' } }],
  ['/v1/users/me', { handler: 'me', params: {} }],
  ['/v1/files/a/b.txt', { handler: 'file', params: { 0: 'a/b.txt' } }],
  ['/v1/orders', { handler: 'order', params: {} }],
  ['/v1/reports/42', { handler: 'report', params: {} }],
  ['/v1/search/a%20b', { handler: 'search', params: { term: 'a b' } }],
  ['/v1/archive', undefined],
  ['/v1/other', undefined],
];

test('handler paths with parameters, wildcards, absolute URLs and RegExp answer requests in real Mokapi', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mokapi-adapter-'));
  let stop;
  try {
    const [port, apiPort] = await unusedPorts(2);
    const base = `http://localhost:${port}/v1`;
    const operation = { get: { responses: { 200: {
      description: 'Mock response',
      content: { 'application/json': { schema: {
        type: 'object', required: ['handler'], properties: { handler: { type: 'string' }, params: { type: 'object' } },
      } } },
    } } } };
    await writeFile(join(directory, 'contract.json'), JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Adapter handler paths', version: '1.0.0' },
      servers: [{ url: base }],
      paths: Object.fromEntries(['/users/me', '/users/{id}', '/files/{dir}/{name}', '/orders',
        '/reports/{id}', '/search/{term}', '/archive', '/other', '/hidden', '/status']
        .map((path) => [path, operation])),
    }));
    await linkAdapter(directory);
    await writeFile(join(directory, 'mocks.js'), `
import { http, HttpResponse } from 'msw';
import { app } from 'mokapi';
import { register } from 'mokapi-msw-adapter/register';
const answer = (handler) => ({ params }) => HttpResponse.json({ handler, params });
export default function () {
  // Native route, so readiness does not depend on the adapter under test.
  app.http().get('/status', (request, response) => { response.data = { handler: 'ready' }; });
  register({
    success: [
      http.get('/v1/users/me', answer('me')),
      http.get('/v1/users/:id', answer('user')),
      http.get('/v1/files/*', answer('file')),
      http.get('https://api.example.com/v1/orders', answer('order')),
      http.get(/\\/v1\\/reports\\/\\d+$/, answer('report')),
      http.get(/^https:\\/\\/api\\.example\\.com\\//, answer('origin-regexp')),
      http.get('/v1/search/:term', answer('search')),
    ],
    other: [http.get('/v1/hidden', answer('hidden'))],
  });
}`);
    await writeFile(join(directory, 'mokapi.yaml'), mokapiConfig(apiPort, ['contract.json', 'mocks.js']));

    stop = await startMokapi(directory, async () => {
      assert.equal((await getJson(`${base}/status`)).handler, 'ready');
    });

    for (const [path, expected] of handlerPathCases) {
      const body = await getJson(`http://localhost:${port}${path}`);
      // Generated data is random, so it never equals an adapter answer.
      if (expected) assert.deepEqual(body, expected, path);
      else assert.ok(!['me', 'user', 'file', 'order', 'report', 'origin-regexp', 'search'].includes(body.handler), path);
    }
    await getJson(`${base}/hidden`);
    await stop();
    assert.doesNotMatch(stop.output(), /No shared mock for GET \/v1\/(users|files|orders|reports|search|archive|other)/);
    assert.match(stop.output(), /No shared mock for GET \/v1\/hidden/);
  } finally {
    if (stop) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});

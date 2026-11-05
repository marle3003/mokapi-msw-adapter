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
  const child = spawn(binary, [], { cwd: directory, stdio: 'inherit' });
  let startupError;
  child.on('error', (error) => { startupError = error; });
  const stopped = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  });
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await stopped;
  };
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
        throw new Error('Mokapi startup failed', { cause: error });
      }
      await setTimeout(100);
    }
  }
}

const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { delay, http, HttpHandler, HttpResponse } from '../index.js';
import { selectScenario } from '../scenario.js';

test('registers a resolver without executing it at build time', () => {
  const resolver = () => HttpResponse.json({ name: 'Jane' });
  assert.deepEqual({ ...http.get('/api/profile', resolver) }, {
    method: 'GET', path: '/api/profile', resolver,
  });
});

test('preserves JSON serialization, status and headers', () => {
  const data = { name: 'Jane', omitted: undefined, date: new Date('2026-01-01T00:00:00Z') };
  assert.deepEqual(HttpResponse.json(data, { status: 201, headers: { 'X-Demo': 'yes' } }), {
    status: 201,
    data: JSON.parse(JSON.stringify(data)),
    headers: { 'Content-Type': 'application/json', 'X-Demo': 'yes' },
  });
});

test('rejects unsupported routes and invalid JSON responses explicitly', () => {
  for (const path of ['/api/:id', '/api/*', 'https://example.com/api']) {
    assert.throws(() => http.get(path, () => undefined), /exact relative paths/);
  }
  assert.throws(() => HttpResponse.json(undefined), /requires a JSON body/);
  assert.throws(() => HttpResponse.json({}, { status: 204 }), /cannot include a JSON body/);
  assert.throws(() => HttpResponse.json({}, { status: 0 }), /Unsupported HTTP status/);
  assert.throws(() => HttpResponse.json({}, { headers: [] }), /plain header objects/);
});

test('supports every MSW HTTP helper and generic string or RegExp methods', () => {
  const resolver = () => HttpResponse.json({});
  for (const name of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
    assert.equal(http[name]('/test', resolver).method, name.toUpperCase());
  }
  assert(http.all('/test', resolver).method.test('QUERY'));
  assert.equal(new HttpHandler('Custom-Method', '/test', resolver).method, 'Custom-Method');
  assert.equal(new HttpHandler('QUERY', '/test', resolver).method, 'QUERY');
  assert(new HttpHandler(/GET|QUERY/, '/test', resolver).method.test('QUERY'));
});

test('selects scenarios from the raw URL query without OpenAPI declaration', () => {
  const request = { url: { query: '__mockScenario=error' }, query: {} };
  assert.equal(selectScenario(request), 'error');
  assert.equal(selectScenario({ ...request, query: { __mockScenario: 'ignored' } }), 'error');
  assert.equal(selectScenario({ url: { query: '' } }), 'success');
  assert.equal(selectScenario({ url: { query: 'other=value' } }, { defaultScenario: 'fallback' }), 'fallback');
  assert.equal(selectScenario(
    { url: { query: 'example=error' } },
    { scenarioParameter: 'example' },
  ), 'error');
});

test('decodes query keys and values and preserves explicit empty scenarios', () => {
  const select = (query, options) => selectScenario({ url: { query } }, options);
  assert.equal(select('other=x&%5F_mockScenario=error%20%2B+%C3%A4%3D%26'), 'error + \u00e4=&');
  assert.equal(select('scenario+name=server%45rror', { scenarioParameter: 'scenario name' }), 'serverError');
  assert.equal(select('__mockScenario=first&__mockScenario=second'), 'first');
  assert.equal(select('__mockScenario='), '');
  assert.equal(select('__mockScenario'), '');
  assert.equal(select('__mockScenario=value=with=equals'), 'value=with=equals');
  assert.throws(() => select('__mockScenario=%ZZ'), URIError);
});

// Milliseconds on the mocked clock until the promise returned by start() resolves.
async function waitedMs(t, start) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const promise = start();
  promise.then(() => { settled = true; });
  for (let elapsed = 0; elapsed <= 1000; elapsed++) {
    t.mock.timers.tick(elapsed === 0 ? 0 : 1);
    await new Promise((resolve) => setImmediate(resolve));
    if (settled) return elapsed;
  }
  throw new Error('delay() did not resolve within 1000 ms');
}

test('delay resolves to undefined after the given milliseconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const promise = delay(500);
  promise.then(() => { settled = true; });
  t.mock.timers.tick(499);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await promise, undefined);
});

test('delay rounds fractions to whole milliseconds and treats negative numbers as 0', async (t) => {
  assert.equal(await waitedMs(t, () => delay(1.6)), 2);
  assert.equal(await waitedMs(t, () => delay(-1)), 0);
  assert.equal(await waitedMs(t, () => delay(-0.4)), 0);
});

test('delay() and delay(\'real\') wait a random 100 to 399 ms', async (t) => {
  const random = t.mock.method(Math, 'random');
  for (const start of [() => delay(), () => delay('real')]) {
    random.mock.mockImplementation(() => 0);
    assert.equal(await waitedMs(t, start), 100);
    random.mock.mockImplementation(() => 0.999);
    assert.equal(await waitedMs(t, start), 399);
  }
});

test('delay accepts the maximum of 2147483647 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.doesNotThrow(() => delay(2147483647));
});

test('delay rejects invalid arguments synchronously', () => {
  assert.throws(() => delay('infinite'), /^Error: mokapi-msw-adapter does not support delay\('infinite'\)\./);
  for (const value of ['foo', '500', NaN, Infinity, -Infinity, {}, null]) {
    assert.throws(() => delay(value), /^Error: mokapi-msw-adapter: delay\(\) expects a number of milliseconds or 'real'\./);
  }
  assert.throws(() => delay(2147483648), /^Error: mokapi-msw-adapter: delay\(\) supports at most 2147483647 ms\./);
});

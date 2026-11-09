import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRequestUrl } from 'msw';
import { compilePath, normalizeOrigin, requestUrl } from '../path.js';

const ORIGIN = 'http://localhost';
const API_ORIGIN = 'https://api.example.com';

// [handler path, request URL, expected params or null for no match]
// Real MSW answers the same, so these are the semantics the adapter has to keep.
const parityCases = [
  ['/users', `${ORIGIN}/users`, {}],
  ['/users', `${ORIGIN}/other`, null],
  ['/users/:id', `${ORIGIN}/users/42`, { id: '42' }],
  ['/users/:id', `${ORIGIN}/users`, null],
  ['/users/:id', `${ORIGIN}/users/42/orders`, null],
  ['/orders/:id?', `${ORIGIN}/orders`, {}],
  ['/orders/:id?', `${ORIGIN}/orders/5`, { id: '5' }],
  ['/items-:id?', `${ORIGIN}/items-`, {}],
  ['/items-:id?', `${ORIGIN}/items-5`, { id: '5' }],
  ['/items-:id?', `${ORIGIN}/items`, null],
  ['/r/:rest+', `${ORIGIN}/r/a/b`, { rest: 'a/b' }],
  ['/r/:rest+', `${ORIGIN}/r`, null],
  ['/r/:rest*', `${ORIGIN}/r`, {}],
  ['/r/:rest*', `${ORIGIN}/r/a/b`, { rest: 'a/b' }],
  ['/files/*', `${ORIGIN}/files/a/b.txt`, { 0: 'a/b.txt' }],
  ['/files/*', `${ORIGIN}/files/a/`, { 0: 'a/' }],
  ['/r/:rest+', `${ORIGIN}/r/a/b/`, { rest: 'a/b' }],
  ['/r/:rest*', `${ORIGIN}/r/a/`, { rest: 'a' }],
  ['/a/*/b', `${ORIGIN}/a/x/y/b`, { 0: 'x/y' }],
  ['/a/*/c/*', `${ORIGIN}/a/x/c/y`, { 0: 'x', 1: 'y' }],
  ['/a/*/c/*', `${ORIGIN}/a/x/c/d/c/y`, { 0: 'x', 1: 'd/c/y' }],
  ['/Users', `${ORIGIN}/users`, null],
  ['/users', `${ORIGIN}/users/`, {}],
  ['/users/', `${ORIGIN}/users`, null],
  ['/users/', `${ORIGIN}/users/`, {}],
  ['/search/:term', `${ORIGIN}/search/a%20b`, { term: 'a b' }],
  ['/files/a b', `${ORIGIN}/files/a%20b`, {}],
  ['/files/a%20b', `${ORIGIN}/files/a%20b`, {}],
  ['https://api.example.com/v1/users', 'https://api.example.com/v1/users', {}],
  ['https://api.example.com/v1/users/:id', 'https://api.example.com/v1/users/7', { id: '7' }],
  [/\/v1\/reports\/\d+$/, `${ORIGIN}/v1/reports/42`, {}],
  [/\/v1\/reports\/\d+$/, `${ORIGIN}/v1/reports/x`, null],
  [/^https:\/\/api\.example\.com\//, `${ORIGIN}/v1/users`, null],
  [/\/(?<id>\d+)\/(\w+)/, `${ORIGIN}/42/ab`, { 0: '42', 1: 'ab' }],
  [/\/v1\/\d+/g, `${ORIGIN}/v1/42`, {}],
];

// [handler path, request path, expected params or null, origin the browser calls]
// MSW matches the handler against origin + path, so these are the semantics of the origin option.
const originParityCases = [
  ['/v1/users/:id', '/v1/users/7', { id: '7' }],
  ['https://api.example.com/v1/users', '/v1/users', {}],
  ['https://api.example.com/v1/users', '/v1/other', null],
  ['https://other.example.com/v1/users', '/v1/users', null],
  ['http://api.example.com/v1/users', '/v1/users', null],
  ['https://:tenant.example.com/v1/t', '/v1/t', { tenant: 'api' }],
  ['https://*.example.com/v1', '/v1', { 0: 'api' }],
  ['https://*/v1', '/v1', { 0: 'api.example.com' }],
  ['https://:sub.:rest.com/v1', '/v1', { sub: 'a', rest: 'b.c' }, 'https://a.b.c.com'],
  ['*', '/a/b', { 0: 'https://api.example.com/a/b' }],
  ['**', '/a/b', { 1: 'https://api.example.com/a/b' }],
  ['/a/**', '/a/x/c/y', { 1: 'x/c/y' }],
  ['*/users', '/users', { 0: 'https://api.example.com' }],
  ['*/*', '/v1/x', { 0: 'https:', 1: '/api.example.com/v1/x' }],
  ['*.json', '/data/a.json', { 0: 'https://api.example.com/data/a' }],
  ['https://api.example.com:8443/v1/users', '/v1/users', {}, 'https://api.example.com:8443'],
  ['https://api.example.com:8443/v1/users', '/v1/users', null],
  ['https://api.example.com:443/v1/users', '/v1/users', null],
  ['https://api.example.com', '/', {}],
  ['https://api.example.com/', '/', {}],
  ['https://API.example.com/v1', '/v1', {}],
  ['https://api.example.com:port/v1', '/v1', { port: ':8443' }, 'https://api.example.com:8443'],
  ['https://api.example.com:port/v1', '/v1', null],
  [/^https:\/\/api\.example\.com\/v1\/\d+$/, '/v1/42', {}],
  [/^https:\/\/api\.example\.com\/v1\/\d+$/, '/v1/x', null],
  [/^https:\/\/other\.example\.com\//, '/v1/42', null],
  [/api\.example\.com\/v1\/(\d+)/, '/v1/42', { 0: '42' }],
];

// Documented deviations: the adapter ignores the origin of the handler path.
const deviationCases = [
  ['absolute URL with another origin matches by path', 'https://api.example.com/v1/users', `${ORIGIN}/v1/users`, {}],
  ['absolute URL on another port matches by path', 'https://api.example.com:8443/v1/users', `${ORIGIN}:8080/v1/users`, {}],
  ['absolute URL with a parameter in the origin has no origin params', 'https://:tenant.example.com/v1/users/:id', `${ORIGIN}/v1/users/7`, { id: '7' }],
  ['leading wildcard before a path is ignored', '*/users', `${ORIGIN}/users`, {}],
  ['a wildcard alone spans the path only', '*', `${ORIGIN}/a/b`, { 0: 'a/b' }],
  ['two wildcards alone span the path only', '**', `${ORIGIN}/a/b`, { 1: 'a/b' }],
  ['a wildcard in front of a suffix is kept', '*.json', `${ORIGIN}/data/a.json`, { 0: '/data/a' }],
  ['origin only is the root path', 'https://api.example.com', `${ORIGIN}/`, {}],
  ['origin only with a slash is the root path', 'https://api.example.com/', `${ORIGIN}/`, {}],
  ['an optional parameter in the middle skips its segment', '/a/:x?/b', `${ORIGIN}/a/b`, {}],
  ['an optional parameter in the middle takes a segment', '/a/:x?/b', `${ORIGIN}/a/1/b`, { x: '1' }],
  ['an optional parameter in the middle does not skip the literal after it', '/a/:x?/b', `${ORIGIN}/a/c`, null],
  ['a repeated optional parameter in the middle skips its segments', '/a/:x*/b', `${ORIGIN}/a/b`, {}],
  ['a repeated optional parameter in the middle takes several segments', '/a/:x*/b', `${ORIGIN}/a/1/2/b`, { x: '1/2' }],
  ['two optional parameters in the middle skip their segments', '/a/:x?/b/:y?/c', `${ORIGIN}/a/b/c`, {}],
  ['two optional parameters in the middle take segments', '/a/:x?/b/:y?/c', `${ORIGIN}/a/1/b/2/c`, { x: '1', y: '2' }],
];

for (const [path, url, expected] of parityCases) {
  test(`parity with MSW: ${path} on ${url} ${expected ? 'matches' : 'does not match'}`, () => {
    const fromMsw = matchRequestUrl(new URL(url), path, ORIGIN);
    assert.equal(fromMsw.matches, expected !== null, 'MSW');
    if (expected) assert.deepEqual({ ...fromMsw.params }, expected, 'MSW params');

    const matcher = compilePath(path);
    assert.deepEqual(matcher(url), expected, 'adapter');
    assert.deepEqual(matcher(url), expected, 'adapter, second call');
  });
}

for (const [path, url, expected] of parityCases) {
  test(`origin mode keeps the parity: ${path} on ${url} ${expected ? 'matches' : 'does not match'}`, () => {
    const matcher = compilePath(path);
    assert.deepEqual(matcher(url, true), expected);
    assert.deepEqual(matcher(url, true), expected, 'second call');
    assert.deepEqual(matcher(url), expected, 'without origin mode');
  });
}

for (const [path, requestPath, expected, origin = API_ORIGIN] of originParityCases) {
  test(`parity with MSW at origin ${origin}: ${path} on ${requestPath} ${expected ? 'matches' : 'does not match'}`, () => {
    const fromMsw = matchRequestUrl(new URL(origin + requestPath), path, origin);
    assert.equal(fromMsw.matches, expected !== null, 'MSW');
    if (expected) assert.deepEqual({ ...fromMsw.params }, expected, 'MSW params');

    // Mokapi listens on another host and port than the browser calls.
    const url = requestUrl({ scheme: 'http', host: 'localhost', port: 8080, path: requestPath }, origin);
    const matcher = compilePath(path);
    assert.deepEqual(matcher(url, true), expected, 'adapter');
    assert.deepEqual(matcher(url, true), expected, 'adapter, second call');
  });
}

for (const [name, path, url, expected] of deviationCases) {
  test(`deviation from MSW: ${name}`, () => {
    assert.deepEqual(compilePath(path)(url), expected);
  });
}

test('matches the path only, the origin of the request does not matter', () => {
  const matcher = compilePath('/users/:id');
  assert.deepEqual(matcher('https://example.org:8443/users/1'), { id: '1' });
  assert.equal(matcher('https://example.org/prefix/users/1'), null);
});

test('RegExp paths are not changed by a g or y flag and see the full URL', () => {
  const matcher = compilePath(/example\.org:8443\/v1\/(\d+)/gy);
  assert.deepEqual(matcher('https://example.org:8443/v1/7'), { 0: '7' });
  assert.deepEqual(matcher('https://example.org:8443/v1/7'), { 0: '7' });
});

test('parameter values that are not valid percent-encoding stay as they are', () => {
  assert.deepEqual(compilePath('/s/:t')('http://localhost/s/100%'), { t: '100%' });
});

test('special characters in a handler path match literally', () => {
  assert.deepEqual(compilePath('/v1.0/a+b$')('http://localhost/v1.0/a+b$'), {});
  assert.equal(compilePath('/v1.0')('http://localhost/v1x0'), null);
});

test('rejects a query string in a string path', () => {
  assert.throws(() => compilePath('/users?page=1'),
    new Error('mokapi-msw-adapter does not match query parameters in handler paths: /users?page=1'));
  assert.throws(() => compilePath('/users/:id?page=1'), /does not match query parameters/);
  assert.throws(() => compilePath('/a/:x?-b'), /does not match query parameters/);
  assert.throws(() => compilePath('https://api.example.com/users?x'), /does not match query parameters/);
});

test('rejects a hash in a string path', () => {
  assert.throws(() => compilePath('/users#top'),
    new Error('mokapi-msw-adapter does not match hash fragments in handler paths: /users#top'));
});

test('rejects path-to-regexp syntax that MSW does not document', () => {
  for (const path of ['/u/:id(\\d+)', '/u{/:x}', '/u/\\:x', '/u/:', '/u/:1']) {
    assert.throws(() => compilePath(path),
      new Error(`mokapi-msw-adapter does not support path-to-regexp syntax in handler paths: ${path}`));
  }
});

test('rejects relative paths without a leading slash and values that are not paths', () => {
  for (const path of ['users', '', 123, null, undefined, {}]) {
    assert.throws(() => compilePath(path), /^Error: mokapi-msw-adapter supports exact relative paths only\./);
  }
});

test('builds the request URL from scheme, host, port and path without query', () => {
  assert.equal(requestUrl({ scheme: 'http', host: 'localhost', port: 8080, path: '/v1/users', query: 'a=1' }),
    'http://localhost:8080/v1/users');
  assert.equal(requestUrl({ scheme: 'https', host: 'example.org', port: 8443, path: '/' }),
    'https://example.org:8443/');
});

test('omits the default port of the scheme', () => {
  assert.equal(requestUrl({ scheme: 'http', host: 'localhost', port: 80, path: '/a' }), 'http://localhost/a');
  assert.equal(requestUrl({ scheme: 'https', host: 'localhost', port: 443, path: '/a' }), 'https://localhost/a');
  assert.equal(requestUrl({ scheme: 'http', host: 'localhost', port: 443, path: '/a' }), 'http://localhost:443/a');
});

test('encodes the decoded request path like a browser URL', () => {
  assert.equal(requestUrl({ scheme: 'http', host: 'localhost', port: 80, path: '/a b/100%' }),
    'http://localhost/a%20b/100%25');
  assert.deepEqual(compilePath('/search/:term')(
    requestUrl({ scheme: 'http', host: 'localhost', port: 80, path: '/search/a b' })), { term: 'a b' });
});

test('requestUrl with an origin replaces scheme, host and port and encodes the path', () => {
  assert.equal(requestUrl({ scheme: 'http', host: 'localhost', port: 8080, path: '/a b/100%' }, 'https://api.example.com'),
    'https://api.example.com/a%20b/100%25');
  assert.equal(requestUrl({ scheme: 'http', host: 'localhost', port: 80, path: '/v1' }, 'http://localhost:3000'),
    'http://localhost:3000/v1');
});

test('normalizeOrigin returns the origin of a URL and leaves undefined alone', () => {
  assert.equal(normalizeOrigin(undefined), undefined);
  assert.equal(normalizeOrigin('https://api.example.com'), 'https://api.example.com');
  assert.equal(normalizeOrigin('https://api.example.com:443'), 'https://api.example.com');
  assert.equal(normalizeOrigin('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeOrigin('HTTPS://API.example.com'), 'https://api.example.com');
  assert.equal(normalizeOrigin('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(normalizeOrigin('http://localhost:80'), 'http://localhost');
  assert.equal(normalizeOrigin('http://[::1]:8080'), 'http://[::1]:8080');
  assert.equal(normalizeOrigin('HTTP://[::1]:80/'), 'http://[::1]');
});

test('normalizeOrigin rejects everything but a URL origin', () => {
  assert.throws(() => normalizeOrigin('https://api.example.com/v1'), new Error(
    'mokapi-msw-adapter origin must be a URL origin such as https://api.example.com: https://api.example.com/v1'));
  for (const value of ['https://api.example.com?x=1', 'https://api.example.com/?', 'https://api.example.com#top', '?',
    '/v1', 'api.example.com', '', 123, null, {}, 'https://user@api.example.com', 'mailto:a@example.com', 'foo://x', 'https://',
    'https://api.example.com:65536', 'https://:8080']) {
    assert.throws(() => normalizeOrigin(value), /^Error: mokapi-msw-adapter origin must be a URL origin/, String(value));
  }
});

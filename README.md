# mokapi-msw-adapter

Run your existing [MSW](https://mswjs.io) handlers in [Mokapi](https://mokapi.io).

You already describe mock responses with MSW for the browser, for example, in
Storybook. With this adapter, Mokapi serves the **same handlers** as a real HTTP
mock server and validates every response against your OpenAPI contract. You
keep one set of mocks and find out early when they drift from the API.

- **No code changes:** your handlers keep `import { http, HttpResponse } from 'msw'`.
- **Contract-checked:** responses that don't match the OpenAPI schema fail.
- **Scenarios per request:** a query parameter selects which set of handlers answers.
- **No build step:** no bundling, no code generation.

## How it works

```
                  ┌──────────────────────────────┐
                  │  src/mocks/profile.js        │
                  │  import … from 'msw'         │
                  └──────────────┬───────────────┘
                 ┌───────────────┴────────────────┐
                 ▼                                ▼
     Browser / Storybook                       Mokapi
     'msw' → real MSW package       'msw' → mokapi-msw-adapter (alias)
                                    register() → native Mokapi routes
                                    responses validated against OpenAPI
```

Browser tools resolve `msw` to the real MSW package. Mokapi uses a module alias
to resolve `msw` to this adapter. The module's default export calls
`register()`, which turns your handlers into Mokapi routes. Mokapi runs that
export when it loads the file. The browser never does.

## Requirements

- [Mokapi](https://mokapi.io/docs/get-started/installation) 0.56.0 or newer
- Node.js 22.12.0 or newer

## Quick start

### 1. Install

```sh
npm install --save-dev mokapi-msw-adapter
```

Install Mokapi as well if you don't have it yet, for example, with
`npm install --save-dev go-mokapi`.

### 2. Write your handlers as scenarios

Group your MSW handlers into named scenarios and export a default function
that registers them with Mokapi:

```js
// src/mocks/profile.js
import { http, HttpResponse } from 'msw';
import { register } from 'mokapi-msw-adapter/register';

export const scenarios = {
  success: [
    http.get('/api/profile', () =>
      HttpResponse.json({ name: 'Jane Doe', email: 'jane.doe@example.com' }),
    ),
  ],
  error: [
    http.get('/api/profile', () =>
      HttpResponse.json({ message: 'Internal error' }, { status: 500 }),
    ),
  ],
};

// Executed by Mokapi only. Storybook and the browser only use `scenarios`.
export default function () {
  register(scenarios);
}
```

The same works in TypeScript (`profile.ts`): Mokapi loads TypeScript modules
natively, and the package ships its own type definitions.

### 3. Configure Mokapi

Create `mokapi.yaml` in your project root:

```yaml
javascript:
  modules:
    aliases:
      msw: mokapi-msw-adapter
providers:
  file:
    directories:
      - src/mocks
```

The alias makes Mokapi load this adapter wherever your code imports `msw`. The
file provider loads your handlers and your OpenAPI contract. In this example the
contract is in `src/mocks` too:

```yaml
# src/mocks/openapi.yaml
openapi: 3.1.0
info:
  title: My API
  version: 1.0.0
servers:
  - url: http://localhost:3000
paths:
  /api/profile:
    get:
      responses:
        '200':
          description: Profile
          content:
            application/json:
              schema:
                type: object
                required: [name, email]
                properties:
                  name: { type: string }
                  email: { type: string }
        '500':
          description: Error
          content:
            application/json:
              schema:
                type: object
                properties:
                  message: { type: string }
```

If the folder contains other files, filter them with `include` and `exclude`.
See [File provider](https://mokapi.io/docs/configuration/dynamic/file).

### 4. Start Mokapi

Run Mokapi from the project root. It reads `mokapi.yaml` automatically:

```sh
npx mokapi
```

### 5. Call your API

```sh
curl http://localhost:3000/api/profile
# {"name":"Jane Doe","email":"jane.doe@example.com"}

curl "http://localhost:3000/api/profile?__mockScenario=error"
# HTTP 500 {"message":"Internal error"}
```

## Scenarios

A scenario is a named list of handlers. Each request selects its scenario with a
query parameter, so parallel requests (for example from different stories) can
use different scenarios without interfering with each other.

| Request                                | Scenario used                       |
|----------------------------------------|-------------------------------------|
| `/api/profile`                         | `defaultScenario` (`success`)       |
| `/api/profile?__mockScenario=error`    | `error`                             |
| `/api/profile?__mockScenario=unknown`  | none, error `Unknown mock scenario` |
| `/api/profile?__mockScenario=`         | none, error `Unknown mock scenario` |

- You don't need to declare the parameter in your OpenAPI contract.
- Names and values are URL-decoded, `+` counts as a space. If the parameter
  appears more than once, the first one wins.
- If the selected scenario has no handler for the request's method and path,
  the adapter throws `No shared mock for <method> <path>`.

When the adapter throws, Mokapi logs the error and answers the request with data generated from your OpenAPI
contract. If you get random data instead of your mock, check the log for these
errors.

If you switch scenarios from Storybook, configure the same parameter name there
as in `register()`.

## Multiple APIs

By default, `register()` applies your handlers to every API that Mokapi mocks.
If Mokapi mocks several OpenAPI contracts that share a path, for example
`/api/profile`, pass the contract's `info.title` as `api`. The handlers then
only answer requests to that API:

```js
export default function () {
  register(scenarios, { api: 'My API' });
}
```

Requests to other APIs keep Mokapi's usual behavior.

If your APIs live on different origins, call `register()` once per API, each
with its own `api` and [`origin`](#origin):

```js
export default function () {
  register(shopScenarios, { api: 'Shop API', origin: 'https://shop.example.com' });
  register(authScenarios, { api: 'Auth API', origin: 'https://auth.example.com' });
}
```

## Origin

By default, the adapter ignores the origin of absolute handler URLs, because
Mokapi doesn't know which origin the browser called. Set `origin` to the origin
your browser uses and the adapter matches handlers like MSW does in the browser:

```js
// Mokapi script
export default function () {
  register(scenarios, { api: 'Shop API', origin: 'https://api.example.com' });
}
```

```js
// mocks.js, shared with the browser
export const scenarios = {
  success: [
    // matches by path
    http.get('/v1/users/:id', ({ params }) => HttpResponse.json({ id: params.id })),
    // matches, same origin
    http.get('https://api.example.com/v1/orders', () => HttpResponse.json([])),
    // doesn't match, different origin
    http.get('https://other.example.com/v1/orders', () => HttpResponse.json([])),
    // matches, params.tenant is 'api'
    http.get('https://:tenant.example.com/v1/tenant', ({ params }) =>
      HttpResponse.json({ tenant: params.tenant }),
    ),
    // matches
    http.get(/^https:\/\/api\.example\.com\/v1\/reports\/\d+$/, () => HttpResponse.json({})),
  ],
};
```

Set `origin` when your handlers use absolute URLs, parameters in the origin, or
a RegExp anchored to the origin. Without these, you don't need it.

With `origin`, the adapter builds the request URL as the origin plus the path
Mokapi received (including a base path of the `servers` URL, without the query)
and tests every handler of this `register()` call against it:

- Relative paths match by path.
- An absolute URL matches only if its origin is the same. A handler with a
  different origin doesn't answer.
- Parameters and wildcards in the origin of a handler URL are set in `params`,
  as in MSW.
- A RegExp is tested against the origin plus the path. Mokapi's own host and
  port don't matter.

Mokapi reports the scheme of every request as `http`. With `origin` set, this
doesn't affect matching, because the adapter uses the scheme of `origin`.

The value must be an origin only: `scheme://host[:port]` with `http` or
`https`, optionally with a trailing `/`. The adapter normalizes it, so
`https://api.example.com:443/` becomes `https://api.example.com`. A path, query,
hash, relative URL or a value that isn't a string makes `register()` throw
`mokapi-msw-adapter origin must be a URL origin such as https://api.example.com`.
Don't put the base path of the `servers` URL into `origin`. It is already part
of the request path, so write it in your handler paths.

## API

### `register(scenarios, options)`

Imported from `mokapi-msw-adapter/register`. Call it in the module's default
export.

| Parameter                   | Type                              | Default            | Description                                         |
|-----------------------------|-----------------------------------|--------------------|-----------------------------------------------------|
| `scenarios`                 | `Record<string, HttpHandler[]>`   | –                  | Handlers grouped by scenario name                   |
| `options.api`               | `string`                          | all APIs           | `info.title` of the OpenAPI contract to restrict the handlers to, see [Multiple APIs](#multiple-apis) |
| `options.origin`            | `string`                          | none               | Origin the browser calls, for example `https://api.example.com`, see [Origin](#origin) |
| `options.scenarioParameter` | `string`                          | `'__mockScenario'` | Query parameter that selects the scenario           |
| `options.defaultScenario`   | `string`                          | `'success'`        | Scenario used when the parameter is missing         |

Handler paths are request paths, as the browser sends them. If the `servers`
URL of your contract has a base path such as `/v1`, write `http.get('/v1/users', ...)`.
Calling `register()` in the browser throws an error.

### TypeScript

Type definitions are included for `mokapi-msw-adapter` and
`mokapi-msw-adapter/register`. In your project, `msw` still resolves to the real
MSW package and its types, so `register()` accepts handlers created by MSW.

### Supported MSW API

Imported from `msw` (aliased to this package in Mokapi):

- `http.get`, `http.post`, `http.put`, `http.patch`, `http.delete`,
  `http.head`, `http.options` and `http.all`
- `new HttpHandler(method, path, resolver)` with a string or RegExp method,
  for example `QUERY` or custom methods. Methods match case-insensitively, as in MSW.
- handler paths, see below
- synchronous and asynchronous resolvers
- `HttpResponse.json(body, { status, headers })` with plain-object headers
- resolver argument: `params` and a `request` with `url` (string), `method`,
  `headers.get()`, `json()` and `text()`
- `delay(durationOrMode)`, see below

#### Handler paths

The path matching follows MSW 3.x. A handler path is a string or a RegExp:

| Path                               | Matches                            | `params`                   |
|------------------------------------|------------------------------------|----------------------------|
| `/users/:id`                       | `/users/42`                        | `{ id: '42' }`             |
| `/orders/:id?`                     | `/orders` and `/orders/5`          | `{}` and `{ id: '5' }`     |
| `/r/:rest+`                        | `/r/a/b`, but not `/r`             | `{ rest: 'a/b' }`          |
| `/r/:rest*`                        | `/r` and `/r/a/b`                  | `{}` and `{ rest: 'a/b' }` |
| `/files/*`                         | `/files/a/b.txt`                   | `{ 0: 'a/b.txt' }`         |
| `https://api.example.com/v1/users` | `/v1/users`, the origin is ignored without `origin` | `{}`      |
| `https://:tenant.example.com/v1/users` | with `origin: 'https://api.example.com'`: `/v1/users` | `{ tenant: 'api' }` |
| `/\/v1\/reports\/\d+$/`            | `/v1/reports/42`                   | `{}`                       |

`:name+` and `:name*` give one string, `'a/b'` for several segments. Each `*`
gets an index key (`'0'`, `'1'`, ...). Parameter values are URL-decoded. A RegExp
puts every group, named or unnamed, under its index. Matching is case-sensitive,
and `/users` matches `/users/`, while `/users/` doesn't match `/users`.

```js
http.get('/users/:id', ({ params }) =>
  HttpResponse.json({ id: params.id, name: 'Jane Doe' }),
),
```

#### `delay()`

`delay()` returns a Promise that resolves after the given time. Await it in an
async resolver to delay the response:

```js
import { http, HttpResponse, delay } from 'msw';

export const scenarios = {
  success: [
    http.get('/api/profile', async () => {
      await delay(500);
      return HttpResponse.json({ name: 'Jane Doe', email: 'jane.doe@example.com' });
    }),
  ],
};
```

| Call                        | Behavior                                         |
|-----------------------------|--------------------------------------------------|
| `delay(500)`                | waits 500 ms                                     |
| `delay()` or `delay('real')`| waits a random 100-399 ms                        |

Fractions are rounded to whole milliseconds and negative numbers count as 0. The
maximum is 2147483647 ms. Only the request whose handler awaits the delay waits.
Mokapi answers other requests to the same module in the meantime. A `delay()`
that you don't await doesn't delay the response.

Invalid arguments throw when you call `delay()`, for example
`mokapi-msw-adapter: delay() expects a number of milliseconds or 'real'.`

## Differences to MSW

- `delay('infinite')` throws `mokapi-msw-adapter does not support delay('infinite')`,
  because the request would never be answered. It is also a type error in this
  package's `index.d.ts`. If a module shared with the browser calls
  `delay('infinite')`, remove it for Mokapi.
- `delay('real')` and `delay()` always wait 100-399 ms. MSW uses 5 ms in Node.
- Without [`origin`](#origin), Mokapi doesn't know the origin the client used,
  so the adapter ignores the origin of an absolute URL and matches by path
  only. Parameters in the origin (`https://:tenant.example.com/...`) give no
  params. A wildcard that spans the origin gives the path instead of the full
  URL: for `http.get('*', ...)` the param `0` is `a/b`, not
  `http://localhost/a/b`. A leading `*` before a path (`*/users`) is ignored.
- Without `origin`, a RegExp is tested against the URL Mokapi received, for
  example `http://localhost:8080/v1/users`, without the query. The default port
  of the scheme (80, 443) is omitted. A RegExp with the origin of your real API
  doesn't match.
- With `origin`, these three differences don't apply. `request.url` in the
  resolver is still the URL Mokapi received (for example
  `http://localhost:8080/v1/users`), not the origin you set.
- With `origin`, a handler with a different origin doesn't count as a match.
  If no handler of any scenario matches the request, the adapter steps aside
  and Mokapi generates the response from your OpenAPI contract, without a
  `No shared mock` error.
- An optional parameter in the middle of a path, such as `/a/:x?/b`, follows
  path-to-regexp: it matches `/a/b` and `/a/1/b`. MSW 3.0.4 matches this
  differently (`/a/1/b` doesn't match there).
- A query or hash in a string path, such as `/users?page=1`, throws. MSW
  ignores the query and hash of a handler path. The adapter throws so that a
  handler that looks query-specific isn't silently treated as path-only.
  `:name?` is an optional parameter and works.
- Unsupported path-to-regexp syntax throws, for example `/u/:id(\\d+)` or
  `/u{/:x}`. MSW doesn't throw, the handler just never matches.
- `params` contains only the parameters of the handler path, not the OpenAPI
  path parameters of your contract.
- A handler with a catch-all path such as `http.all('*', ...)` matches every
  request of the API, so all of them go through the scenario logic. A scenario
  without a matching handler then throws `No shared mock` for requests that
  Mokapi would otherwise answer on its own.

## Limitations

This is not a full implementation of MSW. Not supported:

- path-to-regexp syntax beyond `:name`, `:name?`, `:name+`, `:name*` and `*`,
  for example custom regular expressions (`:id(\\d+)`), groups and escapes
- telling an encoded slash `%2F` from `/` in a request path. Mokapi hands the
  adapter the decoded path, so `/files/a%2Fb` matches like `/files/a/b`.
- responses other than `HttpResponse.json()`, and status codes without a body
  (204, 205, 304)
- cookies, streaming, network errors and `passthrough()`
- complete Web API implementations of `Request`, `Response`, `Headers` and `URL`
- any other MSW export

Unsupported usage throws an error that names the problem, and Mokapi logs it.
Before you move an existing mock suite to Mokapi, check that it only uses the
supported API.

## License

[MIT](LICENSE)

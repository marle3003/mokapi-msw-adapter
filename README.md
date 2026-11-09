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

## API

### `register(scenarios, options)`

Imported from `mokapi-msw-adapter/register`. Call it in the module's default
export.

| Parameter                   | Type                              | Default            | Description                                         |
|-----------------------------|-----------------------------------|--------------------|-----------------------------------------------------|
| `scenarios`                 | `Record<string, HttpHandler[]>`   | –                  | Handlers grouped by scenario name                   |
| `options.api`               | `string`                          | all APIs           | `info.title` of the OpenAPI contract to restrict the handlers to, see [Multiple APIs](#multiple-apis) |
| `options.scenarioParameter` | `string`                          | `'__mockScenario'` | Query parameter that selects the scenario           |
| `options.defaultScenario`   | `string`                          | `'success'`        | Scenario used when the parameter is missing         |

`register()` creates one Mokapi route per distinct path. Calling it in the
browser throws an error.

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
- synchronous and asynchronous resolvers
- `HttpResponse.json(body, { status, headers })` with plain-object headers
- resolver argument: `params` and a `request` with `url` (string), `method`,
  `headers.get()`, `json()` and `text()`
- `delay(durationOrMode)`, see below

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

## Limitations

This is not a full implementation of MSW. Not supported:

- path patterns such as `/users/:id` or `/files/*`, and absolute URLs. Only
  exact relative paths work.
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

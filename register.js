import { app } from 'mokapi';
import { normalizeOrigin, requestUrl } from './path.js';
import { selectScenario } from './scenario.js';

export function register(scenarios, options = {}) {
  const origin = normalizeOrigin(options.origin);
  const { api, scenarioParameter = '__mockScenario', defaultScenario = 'success' } = options;
  // Without api, the routes apply to every API that Mokapi mocks.
  const router = api === undefined ? app.http() : app.api(api).http();
  const matchOrigin = origin !== undefined;
  const allHandlers = Object.values(scenarios).flat();
  // Handler paths are request paths (incl. a base path of the servers URL), so they are
  // matched here and not by a Mokapi route, which only knows the path without the base path.
  router.use(async (request, response) => {
    const url = requestUrl(request.url, origin);
    if (!allHandlers.some((handler) => handler.matches(url, matchOrigin))) return;

    const scenario = selectScenario(request, { scenarioParameter, defaultScenario });
    const handlers = Object.hasOwn(scenarios, scenario) ? scenarios[scenario] : undefined;
    if (!handlers) throw new Error(`Unknown mock scenario: ${scenario}`);

    const match = firstMatch(handlers, request.method, url, matchOrigin);
    if (!match) throw new Error(`No shared mock for ${request.method} ${request.url.path}`);
    const { handler, params } = match;

    const result = await handler.resolver({
      params,
      request: {
        url: request.url.toString(),
        method: request.method,
        headers: {
          get(name) {
            const key = Object.keys(request.header).find(
              (key) => key.toLowerCase() === name.toLowerCase(),
            );
            return key ? String(request.header[key]) : null;
          },
        },
        async json() {
          return request.body;
        },
        async text() {
          return typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        },
      },
    });
    if (!result || !result.headers || !Object.hasOwn(result, 'data')) {
      throw new Error('mokapi-msw-adapter requires a HttpResponse.json() return value.');
    }

    response.statusCode = result.status;
    response.headers = result.headers;
    // Raw response.body bypasses Mokapi's schema validation.
    response.data = result.data;
  });
}

function firstMatch(handlers, method, url, matchOrigin) {
  for (const handler of handlers) {
    const params = handler.matches(url, matchOrigin);
    if (params && isMethodMatch(handler.method, method)) return { handler, params };
  }
  return undefined;
}

function isMethodMatch(handlerMethod, method) {
  return handlerMethod instanceof RegExp
    ? new RegExp(handlerMethod.source, handlerMethod.flags).test(method)
    : handlerMethod.toLowerCase() === method.toLowerCase();
}

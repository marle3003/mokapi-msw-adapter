import { app } from 'mokapi';
import { selectScenario } from './scenario.js';

export function register(scenarios, { api, scenarioParameter = '__mockScenario', defaultScenario = 'success' } = {}) {
  // Without api, the routes apply to every API that Mokapi mocks.
  const router = api === undefined ? app.http() : app.api(api).http();
  const paths = new Set(Object.values(scenarios).flat().map((handler) => handler.path));
  // Handler paths are request paths (incl. a base path of the servers URL), so they are
  // matched here and not by a Mokapi route, which only knows the path without the base path.
  router.use(async (request, response) => {
    if (!paths.has(request.url.path)) return;

    const scenario = selectScenario(request, { scenarioParameter, defaultScenario });
    const handlers = Object.hasOwn(scenarios, scenario) ? scenarios[scenario] : undefined;
    if (!handlers) throw new Error(`Unknown mock scenario: ${scenario}`);

    const handler = handlers.find(
      (candidate) =>
        (candidate.method instanceof RegExp
          ? new RegExp(candidate.method.source, candidate.method.flags).test(request.method)
          : candidate.method.toLowerCase() === request.method.toLowerCase()) &&
        candidate.path === request.url.path,
    );
    if (!handler) throw new Error(`No shared mock for ${request.method} ${request.url.path}`);

    const result = await handler.resolver({
      params: request.path,
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

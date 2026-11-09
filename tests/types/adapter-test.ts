// Imports through the package name to check the "types" conditions in package.json exports.
import { delay, http, HttpHandler, HttpResponse, type JsonResponse } from 'mokapi-msw-adapter';
import { register } from 'mokapi-msw-adapter/register';

const handler: HttpHandler = http.get('/api/profile', () => HttpResponse.json({ name: 'Jane' }));
http.all('/api/profile', async ({ request, params }) => {
  const contentType: string | null = request.headers.get('Content-Type');
  const body = await request.json();
  const text: string = await request.text();
  const url: string = request.url;
  const method: string = request.method;
  return HttpResponse.json({ contentType, body, text, url, method, params });
});
new HttpHandler('QUERY', '/search', () => HttpResponse.json([]));
new HttpHandler(/GET|QUERY/, '/search', () => HttpResponse.json([]));
new HttpHandler('GET', /\/x/, () => HttpResponse.json([]));
http.get(/\/x/, () => HttpResponse.json([]));
http.get('/u/:id', ({ params }) => {
  const id: string = params.id;
  return HttpResponse.json({ id });
});
const pathOfHandler: string | RegExp = http.get(/\/x/, () => HttpResponse.json([])).path;

const response: JsonResponse<{ name: string }> = HttpResponse.json(
  { name: 'Jane' },
  { status: 201, headers: { 'X-Demo': 'yes' } },
);
const name: string = response.data.name;

// @ts-expect-error path must be a string or RegExp
http.get(123, () => HttpResponse.json({}));
// @ts-expect-error resolver must return HttpResponse.json()
http.get('/api/profile', () => 'text');
// @ts-expect-error headers must be a plain object of strings
HttpResponse.json({}, { headers: [['X-Demo', 'yes']] });
// @ts-expect-error status must be a number
HttpResponse.json({}, { status: '200' });

const delayed: Promise<void> = delay(100);
delay();
delay('real');
http.get('/api/profile', async () => {
  await delay(500);
  return HttpResponse.json({ name: 'Jane' });
});

// @ts-expect-error 'infinite' is not supported
delay('infinite');
// @ts-expect-error unknown mode
delay('foo');
// @ts-expect-error duration must be a number
delay({});
// @ts-expect-error duration must be a number
delay(true);

register({ success: [handler] });
register({ success: [handler], error: [] }, { api: 'My API' });
register({ success: [handler] }, {
  api: 'My API',
  scenarioParameter: 'scenario',
  defaultScenario: 'success',
});
register({ success: [handler] }, { api: 'Shop API', origin: 'https://api.example.com' });
// Handlers typed by the real msw package are accepted as well.
register({ success: [{ info: { method: 'GET', path: '/api/profile' } }] });

// @ts-expect-error scenarios must be lists of handlers
register({ success: handler });
// @ts-expect-error api must be a string
register({ success: [handler] }, { api: 123 });
// @ts-expect-error origin must be a string
register({ success: [handler] }, { origin: 123 });
// @ts-expect-error unknown option
register({ success: [handler] }, { scenario: 'success' });

export { name, delayed, pathOfHandler };

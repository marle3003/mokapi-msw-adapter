// Mokapi's module alias maps MSW imports to this implementation.
export class HttpHandler {
  constructor(method, path, resolver) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[:*?{}#]/.test(path)) {
      throw new Error('mokapi-msw-adapter supports exact relative paths only.');
    }
    this.method = method;
    this.path = path;
    this.resolver = resolver;
  }
}

export const http = Object.fromEntries([
  ['all', /.+/], ['head', 'HEAD'], ['get', 'GET'], ['post', 'POST'],
  ['put', 'PUT'], ['delete', 'DELETE'], ['patch', 'PATCH'], ['options', 'OPTIONS'],
].map(([name, method]) => [name, (path, resolver) => new HttpHandler(method, path, resolver)]));

export class HttpResponse {
  static json(data, init = {}) {
    const status = init.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new Error(`Unsupported HTTP status: ${status}`);
    }
    if ([204, 205, 304].includes(status)) {
      throw new Error(`HTTP status ${status} cannot include a JSON body.`);
    }
    if (init.headers && Object.getPrototypeOf(init.headers) !== Object.prototype) {
      throw new Error('mokapi-msw-adapter supports plain header objects only.');
    }
    const body = JSON.stringify(data);
    if (body === undefined) throw new Error('HttpResponse.json() requires a JSON body.');
    return {
      status,
      data: JSON.parse(body),
      headers: { 'Content-Type': 'application/json', ...init.headers },
    };
  }
}

// Mokapi's module alias maps MSW imports to this implementation.
const ERROR_PREFIX = 'mokapi-msw-adapter';
const MAX_DELAY = 2147483647;
const REAL_MIN = 100;
const REAL_RANGE = 300;

export class HttpHandler {
  constructor(method, path, resolver) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[:*?{}#]/.test(path)) {
      throw new Error(`${ERROR_PREFIX} supports exact relative paths only.`);
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
      throw new Error(`${ERROR_PREFIX} supports plain header objects only.`);
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

// Like MSW's delay(), but without 'infinite': that request would never be answered.
export function delay(durationOrMode) {
  const milliseconds = delayInMilliseconds(durationOrMode);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function delayInMilliseconds(durationOrMode) {
  if (durationOrMode === undefined || durationOrMode === 'real') {
    return Math.floor(Math.random() * REAL_RANGE) + REAL_MIN;
  }
  if (durationOrMode === 'infinite') {
    throw new Error(`${ERROR_PREFIX} does not support delay('infinite').`);
  }
  if (!Number.isFinite(durationOrMode)) {
    throw new Error(`${ERROR_PREFIX}: delay() expects a number of milliseconds or 'real'.`);
  }
  if (durationOrMode > MAX_DELAY) {
    throw new Error(`${ERROR_PREFIX}: delay() supports at most ${MAX_DELAY} ms.`);
  }
  return Math.max(0, Math.round(durationOrMode));
}

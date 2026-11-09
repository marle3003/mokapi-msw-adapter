/**
 * The subset of the MSW API that mokapi-msw-adapter supports. In Mokapi, the
 * module alias `msw: mokapi-msw-adapter` maps MSW imports to this module.
 */

/** Request passed to a resolver. */
export interface ResolverRequest {
  /** Full request URL. */
  readonly url: string;
  /** HTTP method as sent by the client. */
  readonly method: string;
  readonly headers: {
    /** Returns the header value (case-insensitive name) or `null`. */
    get(name: string): string | null;
  };
  /** Request body as parsed by Mokapi. */
  json(): Promise<any>;
  /** Request body as text. */
  text(): Promise<string>;
}

/** Argument passed to a resolver. */
export interface ResolverInfo {
  /** Path parameters. Always empty, because only exact paths are supported. */
  readonly params: Record<string, unknown>;
  readonly request: ResolverRequest;
}

/** Response created by `HttpResponse.json()`. */
export interface JsonResponse<T = unknown> {
  readonly status: number;
  readonly data: T;
  readonly headers: Record<string, string>;
}

/** Function that returns the mock response for a request. */
export type HttpResponseResolver = (info: ResolverInfo) => JsonResponse | Promise<JsonResponse>;

/** Matches requests by method and exact relative path, like MSW's `HttpHandler`. */
export class HttpHandler {
  /**
   * @param method HTTP method (case-insensitive) or a RegExp that the method must match.
   * @param path Exact relative path, for example `/api/profile`. Patterns are not supported.
   * @param resolver Returns the response.
   */
  constructor(method: string | RegExp, path: string, resolver: HttpResponseResolver);
  readonly method: string | RegExp;
  readonly path: string;
  readonly resolver: HttpResponseResolver;
}

type HandlerFactory = (path: string, resolver: HttpResponseResolver) => HttpHandler;

/** Creates request handlers, like MSW's `http` namespace. */
export const http: {
  /** Matches any HTTP method. */
  readonly all: HandlerFactory;
  readonly head: HandlerFactory;
  readonly get: HandlerFactory;
  readonly post: HandlerFactory;
  readonly put: HandlerFactory;
  readonly delete: HandlerFactory;
  readonly patch: HandlerFactory;
  readonly options: HandlerFactory;
};

export interface JsonResponseInit {
  /** Status code between 200 and 599, except 204, 205 and 304. Default: 200. */
  status?: number;
  /** Plain object with additional headers. `Content-Type` is `application/json`. */
  headers?: Record<string, string>;
}

export class HttpResponse {
  /** Creates a JSON response. Mokapi validates `body` against the OpenAPI schema. */
  static json<T>(body: T, init?: JsonResponseInit): JsonResponse<T>;
}

/**
 * Returns a Promise that resolves after the given time, like MSW's `delay()`.
 * Invalid arguments throw when `delay()` is called.
 *
 * @param durationOrMode Whole milliseconds (fractions are rounded, negative numbers mean 0,
 *   at most 2147483647) or `'real'`. Without an argument, `'real'` is used.
 *   `'real'` waits a random 100-399 ms. `'infinite'` is not supported.
 */
export function delay(durationOrMode?: number | 'real'): Promise<void>;

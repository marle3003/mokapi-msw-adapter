/**
 * MSW handlers grouped by scenario name. In TypeScript projects the handlers
 * are typed by the real `msw` package, so any handler object is accepted.
 */
export type Scenarios = Record<string, readonly object[]>;

export interface RegisterOptions {
  /**
   * `info.title` of the OpenAPI contract the routes belong to. Without it, the
   * routes apply to every API that Mokapi mocks, which matters when several
   * APIs share a path.
   */
  api?: string;
  /**
   * The origin the browser calls, only `scheme://host[:port]` (a trailing `/` is
   * allowed, a default port is removed). With it, the handlers of this call match
   * like in the browser: an absolute URL answers only for the same origin, origin
   * parameters and wildcards appear in `params`, and a RegExp is tested against
   * `origin + path`. Mokapi's own host and port don't matter. The base path of the
   * OpenAPI `servers` URL is not part of it. Throws when called with anything else.
   */
  origin?: string;
  /** Query parameter that selects the scenario. Default: `__mockScenario`. */
  scenarioParameter?: string;
  /** Scenario used when the query parameter is missing. Default: `success`. */
  defaultScenario?: string;
}

/**
 * Registers the scenarios as Mokapi handlers. Handler paths (patterns, absolute
 * URLs and RegExp) are matched against the request path, including any base path
 * of the OpenAPI `servers` URL. In the selected scenario, the first handler that
 * matches method and path answers. Call it in the default export of your mock
 * module. Throws when called in a browser.
 */
export function register(scenarios: Scenarios, options?: RegisterOptions): void;

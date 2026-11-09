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
  /** Query parameter that selects the scenario. Default: `__mockScenario`. */
  scenarioParameter?: string;
  /** Scenario used when the query parameter is missing. Default: `success`. */
  defaultScenario?: string;
}

/**
 * Registers the scenarios as Mokapi handlers. Handler paths are matched against
 * the request path, including any base path of the OpenAPI `servers` URL. Call
 * it in the default export of your mock module. Throws when called in a browser.
 */
export function register(scenarios: Scenarios, options?: RegisterOptions): void;

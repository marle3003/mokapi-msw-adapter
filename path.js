// Compiles MSW handler paths (path patterns, absolute URLs, RegExp) into matchers.
// Pure module without Mokapi imports, so it runs in Node tests.
export const ERROR_PREFIX = 'mokapi-msw-adapter';
const DEFAULT_PORTS = { http: 80, https: 443 };
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const WILDCARD = '(.*?)';
const LEADING_WILDCARDS = /^\*+(?=\/)/;
const ORIGIN_LITERALS = /:\/\/|:\d+/g;
const MAX_PORT = 65535;
const ORIGIN_OPTION = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d+))?$/i;
const OPTIONAL_PARAMETER = /:\w+\?(?=\/|$)/g;
const UNSUPPORTED_SYNTAX = /[(){}\\]|:(?![A-Za-z_])/;
const TOKEN = /:([A-Za-z_]\w*)([?+*])?|\*|[^:*]+|:/g;

// The URL as the client sent it, without query. Mokapi's request.url.toString() has no port
// and request.url.path is decoded, so it is encoded again like the URL of a browser request.
// With an origin, the browser's origin replaces Mokapi's scheme, host and port.
export function requestUrl({ scheme, host, port, path }, origin) {
  const authority = port === DEFAULT_PORTS[scheme] ? host : `${host}:${port}`;
  return `${origin ?? `${scheme}://${authority}`}${encodeURI(path)}`;
}

// The origin the browser calls, normalized like the origin of a URL. Mokapi's JS engine has no
// URL global, so it is parsed here. A path would double the base path that is already part of
// Mokapi's request path.
export function normalizeOrigin(value) {
  if (value === undefined) return undefined;
  const [, scheme, host, port] = (typeof value === 'string' && value.replace(/\/$/, '').match(ORIGIN_OPTION)) || [];
  if (!scheme || port > MAX_PORT) {
    throw new Error(`${ERROR_PREFIX} origin must be a URL origin such as https://api.example.com: ${value}`);
  }
  const defaultPort = port !== undefined && Number(port) === DEFAULT_PORTS[scheme.toLowerCase()];
  return `${scheme}://${host}${port === undefined || defaultPort ? '' : `:${Number(port)}`}`.toLowerCase();
}

// Returns (url, matchOrigin) => params, or null if the handler path does not match the URL.
// Without matchOrigin, the origin of the handler path is ignored. With it, the URL has to
// match like in MSW, which only differs for patterns that don't start with a slash.
export function compilePath(path) {
  if (path instanceof RegExp) return compileRegExp(path);
  if (typeof path !== 'string') throw new Error(`${ERROR_PREFIX} supports exact relative paths only.`);

  rejectQueryAndHash(path);
  const [origin, rest] = splitOrigin(path);
  if (UNSUPPORTED_SYNTAX.test(rest) || UNSUPPORTED_SYNTAX.test(origin.replace(ORIGIN_LITERALS, ''))) {
    throw new Error(`${ERROR_PREFIX} does not support path-to-regexp syntax in handler paths: ${path}`);
  }
  // A wildcard alone spans the request path, as if it were written as /*.
  const pathPattern = /^\*+$/.test(path) ? `/${path}` : rest;
  if (!pathPattern.startsWith('/') && !pathPattern.startsWith('*')) {
    throw new Error(`${ERROR_PREFIX} supports exact relative paths only.`);
  }
  const matchPath = compilePattern(pathPattern);
  const matchUrl = path.startsWith('/') ? undefined : compilePattern(lowercaseOrigin(origin) + rest);
  return (url, matchOrigin = false) => matchOrigin && matchUrl ? matchUrl(url) : matchPath(url.replace(ORIGIN, ''));
}

// MSW ignores query and hash of a handler path. Throwing keeps a handler that looks
// query-specific from being silently treated as path-only.
function rejectQueryAndHash(path) {
  if (path.includes('#')) {
    throw new Error(`${ERROR_PREFIX} does not match hash fragments in handler paths: ${path}`);
  }
  if (path.replace(OPTIONAL_PARAMETER, '').includes('?')) {
    throw new Error(`${ERROR_PREFIX} does not match query parameters in handler paths: ${path}`);
  }
}

// The origin of a handler path is its scheme and host, or the wildcards in front of the first slash.
function splitOrigin(path) {
  const origin = path.match(ORIGIN)?.[0] ?? path.match(LEADING_WILDCARDS)?.[0] ?? '';
  return [origin, origin ? path.slice(origin.length) || '/' : path];
}

// Scheme and host are case-insensitive, parameter names are not.
function lowercaseOrigin(origin) {
  return origin.replace(/(:[A-Za-z_]\w*)|[^:]+/g, (text, parameter) => parameter ?? text.toLowerCase());
}

function compileRegExp(regExp) {
  // g and y make test()/match() depend on lastIndex of a shared object.
  const matcher = new RegExp(regExp.source, regExp.flags.replace(/[gy]/g, ''));
  return (url) => {
    const match = matcher.exec(url);
    return match && Object.fromEntries(match.slice(1).map((value, index) => [index, value]));
  };
}

function compilePattern(pattern) {
  const keys = [];
  let wildcards = 0;
  let source = '';
  for (const [token, name, modifier] of pattern.matchAll(TOKEN)) {
    if (token === '*') {
      keys.push(String(wildcards++));
      source += WILDCARD;
    } else if (name === undefined) {
      source += escapeRegExp(encodeLiteral(token));
    } else {
      keys.push(name);
      source = withParameter(source, modifier);
    }
  }
  // A wildcard at the end takes a trailing slash, like in MSW.
  const endsWithWildcard = source.endsWith(WILDCARD);
  if (endsWithWildcard) source = `${source.slice(0, -WILDCARD.length)}(.*)`;
  const trailingSlash = pattern.endsWith('/') || endsWithWildcard ? '' : '/?';
  const matcher = new RegExp(`^${source}${trailingSlash}$`);
  return (text) => {
    const match = matcher.exec(text);
    if (!match) return null;
    return Object.fromEntries(keys.map((key, i) => [key, match[i + 1]])
      .filter(([, value]) => value)
      .map(([key, value]) => [key, decode(value)]));
  };
}

// An optional parameter takes the slash in front of it, so /orders/:id? matches /orders.
function withParameter(source, modifier) {
  const group = modifier === '+' || modifier === '*' ? '(.+?)' : '([^/]+?)';
  if (modifier !== '?' && modifier !== '*') return source + group;
  return source.endsWith('/') ? `${source.slice(0, -1)}(?:/${group})?` : `${source}${group}?`;
}

// The request URL is encoded, so a handler path written with a space matches %20 as in MSW.
function encodeLiteral(text) {
  return encodeURI(text).replace(/%25([0-9a-f]{2})/gi, '%$1');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

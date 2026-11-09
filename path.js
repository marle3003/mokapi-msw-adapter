// Compiles MSW handler paths (path patterns, absolute URLs, RegExp) into matchers.
// Pure module without Mokapi imports, so it runs in Node tests.
export const ERROR_PREFIX = 'mokapi-msw-adapter';
const DEFAULT_PORTS = { http: 80, https: 443 };
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const OPTIONAL_PARAMETER = /:\w+\?(?=\/|$)/g;
const UNSUPPORTED_SYNTAX = /[(){}\\]|:(?![A-Za-z_])/;
const TOKEN = /:([A-Za-z_]\w*)([?+*])?|\*|[^:*]+/g;

// The URL as the client sent it, without query. Mokapi's request.url.toString() has no port
// and request.url.path is decoded, so it is encoded again like the URL of a browser request.
export function requestUrl({ scheme, host, port, path }) {
  const authority = port === DEFAULT_PORTS[scheme] ? host : `${host}:${port}`;
  return `${scheme}://${authority}${encodeURI(path)}`;
}

// Returns (url) => params, or null if the handler path does not match the URL.
export function compilePath(path) {
  if (path instanceof RegExp) return compileRegExp(path);
  if (typeof path !== 'string') throw new Error(`${ERROR_PREFIX} supports exact relative paths only.`);

  rejectQueryAndHash(path);
  const pattern = withoutOrigin(path);
  if (UNSUPPORTED_SYNTAX.test(pattern)) {
    throw new Error(`${ERROR_PREFIX} does not support path-to-regexp syntax in handler paths: ${path}`);
  }
  if (!pattern.startsWith('/') && !pattern.startsWith('*')) {
    throw new Error(`${ERROR_PREFIX} supports exact relative paths only.`);
  }
  return compilePattern(pattern);
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

// Mokapi doesn't know the origin the client used, so handlers match by path only.
function withoutOrigin(path) {
  if (path.startsWith('*')) return path.replace(/^\*+(?=\/|$)/, '') || '/*';
  return ORIGIN.test(path) ? path.replace(ORIGIN, '') || '/' : path;
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
      source += '(.*)';
    } else if (name === undefined) {
      source += escapeRegExp(encodeLiteral(token));
    } else {
      keys.push(name);
      source = withParameter(source, modifier);
    }
  }
  const trailingSlash = pattern.endsWith('/') ? '' : '/?';
  const matcher = new RegExp(`^${source}${trailingSlash}$`);
  return (url) => {
    const match = matcher.exec(url.replace(ORIGIN, ''));
    if (!match) return null;
    return Object.fromEntries(keys.map((key, i) => [key, match[i + 1]])
      .filter(([, value]) => value)
      .map(([key, value]) => [key, decode(value)]));
  };
}

// An optional parameter takes the slash in front of it, so /orders/:id? matches /orders.
function withParameter(source, modifier) {
  const group = modifier === '+' || modifier === '*' ? '(.+)' : '([^/]+)';
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

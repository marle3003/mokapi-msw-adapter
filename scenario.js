export function selectScenario(request, {
  scenarioParameter = '__mockScenario',
  defaultScenario = 'success',
} = {}) {
  for (const part of request.url.query.split('&')) {
    const separator = part.indexOf('=');
    const key = separator < 0 ? part : part.slice(0, separator);
    if (decodeURIComponent(key.replace(/\+/g, ' ')) === scenarioParameter) {
      const value = separator < 0 ? '' : part.slice(separator + 1);
      return decodeURIComponent(value.replace(/\+/g, ' '));
    }
  }
  return defaultScenario;
}

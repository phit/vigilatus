export function parseDigestFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const regex = /(\w+)=("[^"]*"|[^,\s]+)/g;
  for (const match of value.matchAll(regex)) {
    const rawKey = match[1];
    const rawValue = match[2];
    fields[rawKey.trim()] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return fields;
}

export function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

export function getHeader(headers: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = headers[name.toLowerCase()];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function parseStatusCode(statusLine: string): number {
  const normalized = statusLine.replace(/^HTTP ERROR 401/, '');
  const match = normalized.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  if (!match) {
    throw new Error(`Unable to parse recording-stream status line: ${statusLine}`);
  }
  return Number(match[1]);
}

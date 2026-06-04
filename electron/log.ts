export function createLogger(scope: string) {
  const tag = `[${scope}]`;
  return {
    info: (...args: unknown[]) => console.info(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
    debug: (...args: unknown[]) => console.debug(tag, ...args),
  };
}

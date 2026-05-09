// Shared logging helpers for the extension's "best-effort" data
// loaders. Two pieces:
//
//   - `errMsg(e)`: consistent error stringification (was duplicated
//     across modules with subtle variations).
//   - `tryLoad(errLabel, log, fn)`: wrap a Promise-returning loader
//     with try/catch so the caller doesn't write the same boilerplate
//     for every parallel `Promise.all` fetch. Success-case logging
//     stays inside `fn`; only failures route through the logger.

export type Logger = (message: string) => void;

/** Drop-in `Logger` that swallows all messages. Default for code paths
 *  where logging is optional (unit tests / library callers). */
export const NOOP_LOGGER: Logger = () => undefined;

/** Stringify any thrown value as a single line. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run `fn`; return its result on success, or `null` after logging
 * `<errLabel>: <message>` to `log` on any thrown error. Designed for
 * the parallel-load pattern where one fetcher's failure shouldn't
 * cancel the rest.
 */
export async function tryLoad<T>(
  errLabel: string,
  log: Logger,
  fn: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log(`${errLabel}: ${errMsg(e)}`);
    return null;
  }
}

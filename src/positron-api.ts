// Single point of access to the Positron runtime API.
//
// `@posit-dev/positron` provides type definitions only. The runtime API
// is acquired via `acquirePositronApi()`, a global function that Positron
// injects into the extension host. In plain VSCode the global is
// undefined; we treat that as a hard error because the NONMEM extension
// is Positron-only by design (see plan §1, §2.3).
//
// Runtime access goes through `getPositron()` everywhere else. Tests
// inject a mock API directly into Manager/Session constructors, so they
// don't need this module.
import { tryAcquirePositronApi, type PositronApi } from '@posit-dev/positron';

export type { PositronApi };
export type * from '@posit-dev/positron';

export class PositronApiUnavailableError extends Error {
  constructor() {
    super(
      'Positron API is not available. The NONMEM extension requires Positron and does not run in plain VSCode. Install Positron from https://positron.posit.co.',
    );
    this.name = 'PositronApiUnavailableError';
  }
}

let cached: PositronApi | undefined;

/**
 * Resolve the Positron runtime API. Caches the first successful resolution.
 * Throws PositronApiUnavailableError if running outside Positron.
 */
export function getPositron(): PositronApi {
  if (!cached) {
    const api = tryAcquirePositronApi();
    if (!api) throw new PositronApiUnavailableError();
    cached = api;
  }
  return cached;
}

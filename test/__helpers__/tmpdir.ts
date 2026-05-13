// Shared temp-dir helper for tests. Replaces the ad-hoc
// `mkdtemp(path.join(os.tmpdir(), '<prefix>-'))` + manual try/finally
// (or worse, no cleanup at all) that used to live in ~8 test files.
//
// Use INSIDE an `it()` body — `vi.onTestFinished` only registers when a
// running test owns the call. Cleanup is async, runs after the test
// completes (or throws), and is best-effort (`recursive: true, force:
// true`). For describe-block-scoped temp dirs, keep the existing
// `beforeEach`/`afterEach` pattern — auto-cleanup wouldn't fire there.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { onTestFinished } from 'vitest';

export async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  onTestFinished(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// readFmsg — NONMEM's `FMSG` (NMTRAN parser messages / errors). Thin
// wrapper around `readArchivedFile` plus a content-classifier that
// flags the literal "AN ERROR WAS FOUND" preamble (NMTRAN parse-error
// signature; e.g. error 93 "WITH NO INITIAL ESTIMATE, FINITE LOWER
// AND UPPER BOUNDS NEEDED" when a `$THETA (a, , )` has bad bounds).
// When a model fails to compile, no `.lst` is produced — FMSG is then
// the only source for the error context.

import { readArchivedFile, type ArchivedFileContent } from './read-archived-file';
import type { Runner } from '../runner';

export interface ReadFmsgOptions {
  /** Absolute path to the run's `modelfit_dir<N>`. */
  modelfitDir: string;
  /** Runner used for archive extraction. Plain-file path doesn't need one. */
  runner?: Runner;
}

export interface FmsgContent extends ArchivedFileContent {
  /** True when the content contains an NMTRAN parse-error block. */
  hasErrors: boolean;
}

const ERROR_RE = /AN ERROR WAS FOUND/i;

export async function readFmsg(opts: ReadFmsgOptions): Promise<FmsgContent | null> {
  return readArchivedFile<{ hasErrors: boolean }>({
    modelfitDir: opts.modelfitDir,
    memberName: 'FMSG',
    runner: opts.runner,
    classify: (content) => ({ hasErrors: ERROR_RE.test(content) }),
  });
}

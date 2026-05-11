// Locate and read the sibling `.xml` of an `.lst`. NM 7.2+ writes
// `<basename>.xml` automatically (suppressed only via `nmfe76 -xmloff`).
// Three possible locations depending on how the run was driven:
//
//   1. **Plain file next to the .lst** (raw nmfe; or PsN with 'xml' in
//      `-nm_output`). `findArtifactFile` handles both Pirana-flat and
//      PsN-modelfit_dir<N> layouts.
//   2. **Inside `NM_run1.7z`** as `psn.xml` (PsN with default `-clean`
//      and `xml` NOT in `-nm_output`). For this we extract via 7z
//      through the injected runner — same fallback `readPrderr` /
//      `readFmsg` use for `PRDERR` / `FMSG`.
//
// Returns null on absent .xml (older NM, `-xmloff`, archived but no
// runner). Caller degrades to .lst-text parsing for affected fields.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { errMsg, NOOP_LOGGER, type Logger } from '../log-utils';
import type { Runner } from '../runner';
import { findArtifactFile, findExtFile } from './find-ext-file';
import { readArchivedFile } from './read-archived-file';

export async function readXmlText(
  lstPath: string,
  log: Logger = NOOP_LOGGER,
  runner?: Runner,
): Promise<string | null> {
  // Tier 1: plain file at sibling location.
  const xmlPath = await findArtifactFile(lstPath, '.xml');
  if (xmlPath) {
    try {
      return await fs.readFile(xmlPath, 'utf8');
    } catch (e) {
      log(`load-xml-text: read failed for ${path.basename(xmlPath)}: ${errMsg(e)}`);
    }
  }

  // Tier 2: extract `psn.xml` from `NM_run1.7z` (PsN default `-clean`).
  // Locate `modelfit_dir<N>` via the .ext cascade since that's the
  // canonical PsN run dir. `readArchivedFile` handles the `NM_run1/`
  // path prefix internally (matches its plain-file convention), so
  // we pass the bare member name here.
  const extPath = await findExtFile(lstPath);
  if (!extPath) {
    log(
      `load-xml-text: no .ext found near ${path.basename(lstPath)} — can't locate modelfit_dir for archive fallback`,
    );
    return null;
  }
  if (!runner) {
    log(`load-xml-text: archive fallback skipped — no runner injected`);
    return null;
  }
  const modelfitDir = path.dirname(extPath);
  const archived = await readArchivedFile({
    modelfitDir,
    memberName: 'psn.xml',
    runner,
  });
  if (archived) return archived.content;

  log(
    `load-xml-text: no .xml found for ${path.basename(lstPath)} (NM < 7.2, -xmloff, or archive missing/extract-failed)`,
  );
  return null;
}

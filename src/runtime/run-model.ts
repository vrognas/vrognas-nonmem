// runModel — drives PsN's `execute` to run one NONMEM model.
//
// Pipeline:
//   1. Validate the .mod exists (so the caller gets a clean "model file
//      not found" rather than a confusing PsN error).
//   2. Run `execute <basename>.mod; echo EXIT=$?` in the .mod's directory.
//      PsN's `execute` is the toolbelt's nmfe replacement — it copies the
//      dataset into modelfit_dirN/NM_run1/, drives nmfe internally, and
//      copies the resulting `.lst` (renamed from `psn.lst`) back next to
//      the .mod. We don't pass the lst arg; PsN names it itself.
//   3. Detect failure modes that PsN doesn't propagate via exit code:
//      - NMtran errors → "execute done" prints, RC=0, but no .lst.
//      - Bad -nm_version → PsN croaks via Perl die(); error on stderr.
//      Both cases throw with the parsed PsN/NMtran message so the caller
//      can surface it directly.
//   4. Parse OFV from `<basename>.lst`'s `#OBJV:` banner.
//
// Out of scope (capture as separate chunks if/when needed):
//   - retries, parallel models, $DATA path rewrite — PsN already does
//     these, surface as flags in later chunks.
//
// See docs/psn-notes.md for the empirical behaviour this code targets.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runner } from '../runner';
import { scrubPrivate } from '../scrub';
import { quote } from '../shell';
import { listModelfitDirs } from './find-ext-file';

export interface RunModelOptions {
  /** Absolute path to the user's .mod control stream. */
  modelPath: string;
  /** Runner used to execute PsN. */
  runner: Runner;
  /** Path or PATH-resolvable name of PsN's `execute` binary (default: `execute`). */
  executeBinary: string;
  /**
   * psn.conf [nm_versions] label to pass through as `-nm_version=<label>`.
   * Omit (or pass undefined) to let PsN pick its own default. The active
   * NonmemSession's `nmVersionLabel` is the natural source.
   */
  nmVersionLabel?: string;
  /**
   * NM7 extensions to copy back via `-nm_output=<comma-list>`. PsN places
   * the listed files at `modelfit_dirN/<basename>.<ext>` (renamed from
   * `psn.<ext>`) instead of leaving them in `NM_run1/`. Default
   * `['ext', 'phi', 'cov', 'cor', 'coi']` — what the Variables pane and
   * `sumo` need to read post-run. Pass `[]` to disable.
   */
  nmOutputExtensions?: string[];
}

export interface RunModelResult {
  /** Exit code parsed from the trailing `EXIT=$?` echo, or null. */
  exitCode: number | null;
  /** Absolute path to the produced `<basename>.lst`. */
  lstPath: string;
  /** OFV parsed from <basename>.lst's `#OBJV:` line, or null when absent. */
  ofv: number | null;
  /**
   * Absolute path to PsN's `modelfit_dir<N>/` for this run, or null
   * when no such dir was found in the .mod's parent. With the default
   * `nmOutputExtensions`, the NM7 aux files live at
   * `<modelfitDir>/<basename>.<ext>` (e.g. `m.ext`, `m.phi`).
   */
  modelfitDir: string | null;
}

// `xml` added v0.0.158: NM 7.2+'s machine-readable report. Carries the
// exhaustive `<nm:estimation_options>` set the inspector surfaces, plus
// per-step termination + timing data the .lst echo lacks. Without it
// here, PsN never copies `psn.xml` out of `NM_run1/` and the inspector
// has to extract from `NM_run1.7z` on every render.
const DEFAULT_NM_OUTPUT_EXTENSIONS: readonly string[] = ['ext', 'phi', 'cov', 'cor', 'coi', 'xml'];

/**
 * Take the first non-comment $DATA token from the model text and return
 * it verbatim. Caller resolves it relative to the .mod file's directory.
 * Case-insensitive on $DATA (NONMEM accepts lowercase record names).
 */
export function parseDataFilename(modelText: string): string | undefined {
  for (const rawLine of modelText.split(/\r?\n/)) {
    const codeOnly = rawLine.split(';')[0]; // strip end-of-line comments
    const m = /^\s*\$DATA\s+(\S+)/i.exec(codeOnly);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Parse OFV from the m.lst's `#OBJV:` banner. NONMEM 7+ writes one such
 * line per estimation step; we take the LAST so multi-$EST runs report
 * the final objective. Returns null when absent (e.g. NMTRAN-only failure).
 */
export function parseOfv(lstText: string): number | null {
  const re = /^\s*#OBJV:\s*\*+\s*(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)\s*\*+/gm;
  const last = [...lstText.matchAll(re)].at(-1);
  return last ? Number(last[1]) : null;
}

export async function runModel(opts: RunModelOptions): Promise<RunModelResult> {
  const {
    modelPath,
    runner,
    executeBinary,
    nmVersionLabel,
    nmOutputExtensions = DEFAULT_NM_OUTPUT_EXTENSIONS,
  } = opts;

  try {
    await fs.access(modelPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`model file not found: ${modelPath}`);
    }
    throw e;
  }

  const cwd = path.dirname(modelPath);
  const modelBase = path.basename(modelPath);
  const lstPath = path.join(cwd, path.basename(modelBase, path.extname(modelBase)) + '.lst');

  // PsN renames psn.lst → <basename>.lst when it copies back, so we pass
  // only the .mod argument. The trailing `echo EXIT=$?` lets us recover
  // the shell exit code for runs where the runner doesn't surface it.
  // -nm_version=<label> selects which psn.conf [nm_versions] entry PsN
  // resolves the NONMEM binary from. -nm_output asks PsN to also copy
  // the listed NM7 aux files into modelfit_dirN/ (else they stay buried
  // in NM_run1/psn.<ext>). Both flags are omitted when not asked for.
  const versionFlag = nmVersionLabel ? ` -nm_version=${quote(nmVersionLabel)}` : '';
  const outputFlag =
    nmOutputExtensions.length > 0 ? ` -nm_output=${quote(nmOutputExtensions.join(','))}` : '';
  const cmd = `${quote(executeBinary)}${versionFlag}${outputFlag} ${quote(modelBase)}; echo EXIT=$?`;
  const result = await runner.run(cmd, cwd);
  const exitCode = parseExitCode(result.stdout);

  let lstText: string | null;
  try {
    lstText = await fs.readFile(lstPath, 'utf8');
  } catch {
    lstText = null;
  }

  // Two failure paths:
  //   (a) .lst missing — PsN aborted before NONMEM produced output
  //       (NMtran error, $RECORD validation, etc.)
  //   (b) Non-zero exit but .lst exists — execute completed unhappily
  //       (NONMEM crashed mid-run, MINIMIZATION TERMINATED escalated to
  //       a non-zero PsN exit, etc). The .lst may have partial content
  //       worth reading, but the run did not succeed.
  const lstMissing = lstText === null;
  const exitFailed = exitCode !== null && exitCode !== 0;
  if (lstMissing || exitFailed) {
    const parsed = scrubPrivate(diagnoseFailure(result.stdout, result.stderr));
    const message = lstMissing
      ? parsed
      : `execute exited with code ${exitCode}; .lst was produced — review for termination messages.\n\n${parsed}`;
    throw new Error(message);
  }

  const modelfitDir = await findLatestModelfitDir(cwd);
  return { exitCode, lstPath, ofv: parseOfv(lstText!), modelfitDir };
}

/**
 * Scan `cwd` for `modelfit_dir<N>` directories (PsN's auto-incremented
 * per-run output dir) and return the absolute path of the highest N.
 * Returns null when none exist — happens when the run aborted before
 * PsN created the dir, or when the user passed `-directory=<custom>`
 * (not yet supported here).
 */
export async function findLatestModelfitDir(cwd: string): Promise<string | null> {
  const dirs = await listModelfitDirs(cwd);
  return dirs.length > 0 ? dirs[0].path : null;
}

/**
 * Build a human-readable error message from PsN's stdout/stderr when no
 * `.lst` was produced. Patterns are anchored on the canonical PsN/NMtran
 * markers verified empirically in `docs/psn-notes.md`.
 *
 * Concatenation order matches PsN's actual output order: NMtran errors
 * land on stdout (`AN ERROR WAS FOUND ...` / `NMtran failed.`); PsN's own
 * Perl croaks (e.g. `-nm_version=<bad-label>`) land on stderr. Searching
 * stdout-first keeps the more specific NMtran detail from being shadowed
 * by an unrelated stderr fragment when both exist.
 */
function diagnoseFailure(stdout: string, stderr: string): string {
  const all = `${stdout}\n${stderr}`;

  // PsN config error — Perl croak from common_options.pm, on stderr.
  const psnConfig =
    /No NONMEM version with name "[^"]+" defined in psn\.conf[^\n]*(?:\n[^\n]*)?/.exec(all);
  if (psnConfig) {
    return psnConfig[0].trim();
  }

  // NMtran failure — RC=0 but no .lst, "NMtran failed." in stdout. Pull
  // the most specific NMtran error code line if available (e.g. "208
  // UNDEFINED VARIABLE.").
  if (/NMtran failed\./.test(all) || /AN ERROR WAS FOUND IN THE CONTROL STATEMENTS/.test(all)) {
    const detail = /\b\d{3}\s+[A-Z][A-Z0-9 ]{2,80}\.?/.exec(all);
    return detail ? `NMtran failed: ${detail[0].trim()}` : 'NMtran failed';
  }

  // Generic PsN early-die — captures `PsN does not support record $X
  // in the control stream`, `PsN cannot read input file ...`, etc.
  // We keep the Perl `at <file> line NNN` trailer because it's
  // diagnostically useful when the user clicks a failed entry to see
  // the full error. The tooltip will show the multi-line message;
  // the click handler can open it as a virtual document for clean
  // copy/paste.
  const psnGeneric = /^PsN [^\n]+(?:\n[^\n]*)?/m.exec(all);
  if (psnGeneric) {
    return psnGeneric[0].trim();
  }

  return 'execute completed but no .lst was produced';
}

function parseExitCode(stdout: string): number | null {
  const match = /^EXIT=(-?\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

// runModel — local NONMEM run, classic layout.
//
// Pipeline:
//   1. Read the .mod (validate it exists; we need its text for $DATA parsing
//      and for OFV-time hashing).
//   2. Run `nmfe76 <basename>.mod <basename>.lst` in the .mod's directory.
//      Output (.lst, .ext, .cov, .phi, …) lands next to the .mod, exactly
//      like a hand-rolled `nmfe76` invocation would. We don't impose our
//      own subdir, manifest, or naming convention — the user's existing
//      run folders look indistinguishable from ours.
//   3. Parse `EXIT=N` from the trailing `echo` so we can surface the
//      remote process exit code.
//   4. Parse OFV from `<basename>.lst`'s `#OBJV:` banner.
//
// Out of scope: $DATA-path rewrite, retry/cancel, hash provenance —
// the previous SSH/manifest layer is gone (M7 chunk D refactor). Bring
// any of those back as opt-in features if they earn their keep.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runner } from '../runner';

export interface RunModelOptions {
  /** Absolute path to the user's .mod control stream. */
  modelPath: string;
  /** Runner used to execute nmfe76. */
  runner: Runner;
  /** Path to nmfe76 (must be reachable on the runner's host). */
  nmfeBinary: string;
}

export interface RunModelResult {
  /** Exit code parsed from the trailing `EXIT=$?` echo, or null. */
  exitCode: number | null;
  /** Absolute path to the produced `<basename>.lst`. */
  lstPath: string;
  /** OFV parsed from <basename>.lst's `#OBJV:` line, or null when absent. */
  ofv: number | null;
}

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
  const { modelPath, runner, nmfeBinary } = opts;

  // Validate the .mod exists BEFORE shelling out to nmfe76 — gives the
  // caller a clean "model file not found" rather than a confusing nmfe error.
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
  const lstName = stripExtension(modelBase) + '.lst';
  const lstPath = path.join(cwd, lstName);

  const cmd = `${shellQuote(nmfeBinary)} ${shellQuote(modelBase)} ${shellQuote(lstName)}; echo EXIT=$?`;
  const result = await runner.run(cmd, cwd);
  const exitCode = parseExitCode(result.stdout);

  // m.lst may not exist on NMTRAN-only failures; surface OFV=null instead
  // of throwing so the user still gets the EXIT code in the toast.
  let ofv: number | null = null;
  try {
    ofv = parseOfv(await fs.readFile(lstPath, 'utf8'));
  } catch {
    /* missing lst — leave ofv null */
  }

  return { exitCode, lstPath, ofv };
}

/** Strip the last extension, like NONMEM-classic naming: `foo.mod` → `foo`. */
function stripExtension(name: string): string {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/** Shell-quote a path for safe interpolation. Single-quotes preserve everything verbatim. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseExitCode(stdout: string): number | null {
  const match = /^EXIT=(-?\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

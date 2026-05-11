// promoteEstimates — drives PsN's `update_inits` to produce a new .mod
// file with `$THETA` / `$OMEGA` / `$SIGMA` rewritten from the converged
// estimates of a finished run.
//
// Pipeline:
//   1. Caller provides the input .mod and the desired output basename.
//   2. We invoke `update_inits <basename>.mod -output_model=<new>.mod`
//      via the injected Runner, in the input model's directory. PsN
//      reads the sibling .lst, writes the new .mod alongside the input.
//   3. RC ≠ 0 throws with stdout+stderr; RC = 0 but no file produced
//      throws too (defensive — shouldn't happen empirically).
//
// Verified against PsN 5.3.1 on primary — see docs/psn-notes.md
// "update_inits" section.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runner } from '../runner';
import { scrubPrivate } from '../scrub';
import { quote } from '../shell';
import { setBasedOn } from './parse-runrecord';

export interface PromoteEstimatesOptions {
  /** Absolute path to the input .mod (must have a sibling `<basename>.lst`). */
  modelPath: string;
  /** Basename for the new .mod (e.g. `run002.mod`). Path components are stripped. */
  outputName: string;
  /** Runner used to invoke PsN. */
  runner: Runner;
  /** PsN binary; defaults to `update_inits` (PATH-resolved). */
  binary?: string;
}

export interface PromoteEstimatesResult {
  /** Absolute path to the produced new model file. */
  outputModelPath: string;
}

const DEFAULT_BINARY = 'update_inits';

/**
 * Bump the trailing zero-padded integer in the model basename
 * (`run001.mod` → `run002.mod`, `run099.ctl` → `run100.ctl`). When the
 * stem has no trailing digits, fall back to Pirana's `+N` convention
 * (`m.mod` → `m+1.mod`, `m+1.mod` → `m+2.mod`). Extension preserved.
 *
 * Returns an absolute path with the same parent dir as the input.
 *
 * Note: this accepts the Pirana `+N` form, but `extractRunNumber`
 * (which decides whether `;; Based on:` gets written) only matches
 * `run<NNN>`. The asymmetry is intentional: we'll happily NAME a
 * Pirana-style child, but only emit the runrecord marker for
 * runrecord-compatible parents.
 */
export function computeNextModelName(modelPath: string): string {
  const dir = path.dirname(modelPath);
  const ext = path.extname(modelPath);
  const stem = path.basename(modelPath, ext);

  // Pirana-style `<stem>+<N>` already → bump N.
  const piranaMatch = /^(.*?)\+(\d+)$/.exec(stem);
  if (piranaMatch) {
    const [, base, n] = piranaMatch;
    return path.join(dir, `${base}+${Number(n) + 1}${ext}`);
  }

  // Trailing zero-padded digits → bump preserving width.
  const numericMatch = /^(.*?)(\d+)$/.exec(stem);
  if (numericMatch) {
    const [, prefix, digits] = numericMatch;
    const next = String(Number(digits) + 1).padStart(digits.length, '0');
    return path.join(dir, `${prefix}${next}${ext}`);
  }

  // No numeric suffix → start the +N counter.
  return path.join(dir, `${stem}+1${ext}`);
}

/**
 * Build the `update_inits` invocation. Run from the .mod's parent dir
 * so PsN finds the sibling `<basename>.lst` automatically. The output
 * basename is stripped of any path components — PsN writes the new .mod
 * alongside the input regardless of what we pass in.
 */
export function buildUpdateInitsCommand(
  modelPath: string,
  outputName: string,
  binary: string = DEFAULT_BINARY,
): { cmd: string; cwd: string } {
  const cwd = path.dirname(modelPath);
  const modelBase = path.basename(modelPath);
  const outputBase = path.basename(outputName);
  return {
    cmd: `${quote(binary)} ${quote(modelBase)} -output_model=${quote(outputBase)}`,
    cwd,
  };
}

export async function promoteEstimates(
  opts: PromoteEstimatesOptions,
): Promise<PromoteEstimatesResult> {
  const { modelPath, outputName, runner, binary = DEFAULT_BINARY } = opts;
  const { cmd, cwd } = buildUpdateInitsCommand(modelPath, outputName, binary);

  const result = await runner.run(cmd, cwd);

  if (result.code !== 0) {
    // Scrub: PsN's update_inits stdout/stderr can include absolute
    // paths, user@host markers, and license info. Surface the failure
    // without leaking private layout into the toast / Output channel.
    const detail = scrubPrivate(
      [result.stdout, result.stderr].map((s) => s.trim()).filter(Boolean).join('\n'),
    );
    throw new Error(`update_inits exited with code ${result.code}${detail ? `:\n${detail}` : ''}`);
  }

  const outputModelPath = path.join(cwd, path.basename(outputName));
  try {
    await fs.access(outputModelPath);
  } catch {
    throw new Error(
      `update_inits exited 0 but no output file produced: ${path.basename(outputModelPath)}`,
    );
  }

  // Annotate the new .mod with PsN runrecord-style parent linkage
  // (`;; Based on: N` under $PROBLEM). Skipped silently when the
  // parent's basename isn't `run<NNN>(.mod|.ctl)` — runrecord only
  // accepts numeric run numbers; better to omit than emit a non-spec
  // marker that PsN's own `runrecord` tool would reject.
  const parentRunNumber = extractRunNumber(modelPath);
  if (parentRunNumber !== null) {
    const text = await fs.readFile(outputModelPath, 'utf8');
    const updated = setBasedOn(text, parentRunNumber);
    if (updated !== text) await fs.writeFile(outputModelPath, updated, 'utf8');
  }
  return { outputModelPath };
}

/**
 * Extract `<N>` from a `run<NNN>(.mod|.ctl)` basename; null otherwise.
 * Requires N ≥ 1 — PsN's `runrecord` tool rejects `;; Based on: 0`,
 * so a hand-named `run0.mod` parent must NOT emit a marker.
 *
 * `null` is the right return for non-runrecord-compatible parents
 * (Pirana `m.mod` / `m+1.mod`, hand-rolled names): the caller skips
 * the `;; Based on:` marker write rather than emit a value PsN's
 * `runrecord` tool would refuse to parse. Works in tandem with
 * `computeNextModelName` which has a broader name-bumping policy.
 */
export function extractRunNumber(modelPath: string): number | null {
  const stem = path.basename(modelPath, path.extname(modelPath));
  const m = stem.match(/^run0*([1-9]\d*)$/);
  return m ? Number(m[1]) : null;
}

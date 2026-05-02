// runModel — M3 chunks 3A + 3B: end-to-end NONMEM run orchestration.
//
// Pipeline (matches the per-run subdir discipline from nonmem-ssh-probe and
// the §4 M2 spec in the design plan):
//
//   1. Generate runId = `pn-<unix-ts>`.
//   2. mkdir -p <remoteRoot>/<runId>.
//   3. putFile <local m.mod> -> <remoteRoot>/<runId>/m.mod.
//   4. If $DATA <token> present, putFile <local dataset> -> <remoteRoot>/<runId>/<basename>.
//   5. Run `cd <remoteRoot>/<runId> && <nmfeBinary> m.mod m.lst > m.nmfe.log 2>&1; echo EXIT=$?`
//      via the transport. The trailing `echo EXIT=$?` is how we recover the
//      remote process exit code (the transport fires-and-forgets a single
//      shell line; we cannot get $? out of it any other way).
//   6. Parse `EXIT=N` from stdout.
//   7. getFile m.lst + m.ext back to <localRunsDir>/<runId>/.
//   8. Parse OFV from m.lst's `#OBJV:` banner line.
//
// Out of scope: manifest.json, audit.jsonl, dataset-path rewrite when $DATA
// points outside the .mod's directory, Variables-pane comm, retry/cancel,
// line-ending normalisation. Those land in chunks 3C–3D and milestone M5+.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Transport } from '../transport';

export interface RunModelOptions {
  /** Absolute path to the user's .mod control stream. */
  modelPath: string;
  /** Already-resolved transport (Local for Remote-SSH workspace, Ssh otherwise). */
  transport: Transport;
  /** Remote run root, e.g. `~/positron-nonmem`. */
  remoteRoot: string;
  /** Local mirror root, e.g. `<workspace>/.positron-nonmem/runs`. */
  localRunsDir: string;
  /** Path to nmfe76 on the remote host. */
  nmfeBinary: string;
}

export interface RunModelResult {
  runId: string;
  /** Exit code parsed from the remote `EXIT=$?` echo, or null if unparseable. */
  exitCode: number | null;
  /** Local path the remote `m.lst` was downloaded to. */
  lstPath: string;
  /**
   * Local path the remote `m.ext` was downloaded to (parameter trajectory),
   * or null if the file didn't exist on the remote — happens when NMTRAN
   * fails before estimation can start, in which case nmfe76 only writes
   * m.lst and FMSG.
   */
  extPath: string | null;
  /** Objective Function Value parsed from m.lst's `#OBJV:` line, or null. */
  ofv: number | null;
}

/**
 * Take the first non-comment $DATA token from the model text and return
 * it verbatim (no path normalisation). Caller resolves it relative to
 * the .mod file's directory. Case-insensitive on the `$DATA` keyword
 * because NONMEM accepts lowercase record names.
 *
 * Out of scope: quoted paths (NONMEM doesn't really support them anyway),
 * multi-line $DATA continuations, NUL-byte handling.
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
 * Parse OFV from m.lst's `#OBJV:` banner line. NONMEM 7+ writes one
 * `#OBJV:` line per estimation step in machine-readable form; we take
 * the LAST occurrence so multi-$EST runs report the final objective.
 *
 * Returns null when the line is absent (e.g. NMTRAN-only failure that
 * never reached the estimation phase).
 */
export function parseOfv(lstText: string): number | null {
  const re = /^\s*#OBJV:\s*\*+\s*(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)\s*\*+/gm;
  const last = [...lstText.matchAll(re)].at(-1);
  return last ? Number(last[1]) : null;
}

export async function runModel(opts: RunModelOptions): Promise<RunModelResult> {
  const { modelPath, transport, remoteRoot, localRunsDir, nmfeBinary } = opts;

  // Validate inputs BEFORE any remote side-effects.
  let modelText: string;
  try {
    modelText = await fs.readFile(modelPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`model file not found: ${modelPath}`);
    }
    throw e;
  }

  const runId = `pn-${Date.now()}`;
  const remoteRunDir = `${remoteRoot}/${runId}`;
  const localRunDir = path.join(localRunsDir, runId);

  await transport.run(`mkdir -p ${remoteRunDir}`);

  await transport.putFile(modelPath, `${remoteRunDir}/m.mod`);

  const dataToken = parseDataFilename(modelText);
  if (dataToken) {
    const datasetLocal = path.resolve(path.dirname(modelPath), dataToken);
    const remoteDatasetName = path.basename(dataToken);
    await transport.putFile(datasetLocal, `${remoteRunDir}/${remoteDatasetName}`);
  }

  const cmd = `cd ${remoteRunDir} && ${nmfeBinary} m.mod m.lst > m.nmfe.log 2>&1; echo EXIT=$?`;
  const result = await transport.run(cmd);
  const exitCode = parseExitCode(result.stdout);

  // m.lst is mandatory — it holds NMTRAN errors AND the OFV banner. If it
  // failed to download, surface that as a hard error (caller toast).
  const lstPath = path.join(localRunDir, 'm.lst');
  await transport.getFile(`${remoteRunDir}/m.lst`, lstPath);

  // m.ext is best-effort — NMTRAN-only failures never write it, in which
  // case scp exits non-zero. Tolerate that so the user still sees the
  // EXIT code + m.lst path in the toast (m.lst is where the error message
  // lives). FMSG arrives in 3C+.
  const extPath = await tryGetFile(
    transport,
    `${remoteRunDir}/m.ext`,
    path.join(localRunDir, 'm.ext'),
  );

  const ofv = await readAndParseOfv(lstPath);
  return { runId, exitCode, lstPath, extPath, ofv };
}

/** getFile, but return null instead of throwing if the remote file is absent. */
async function tryGetFile(
  transport: Transport,
  remotePath: string,
  localPath: string,
): Promise<string | null> {
  try {
    await transport.getFile(remotePath, localPath);
    return localPath;
  } catch {
    return null;
  }
}

/** Read m.lst and pull OFV from it; missing file or no #OBJV line -> null. */
async function readAndParseOfv(lstPath: string): Promise<number | null> {
  try {
    return parseOfv(await fs.readFile(lstPath, 'utf8'));
  } catch {
    return null;
  }
}

function parseExitCode(stdout: string): number | null {
  const match = /^EXIT=(-?\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

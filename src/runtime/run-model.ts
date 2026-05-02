// runModel — chunk 3A: smallest viable end-to-end NONMEM run orchestration.
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
//   7. getFile <remoteRoot>/<runId>/m.lst -> <localRunsDir>/<runId>/m.lst.
//
// Out of scope for 3A: m.ext pull, OFV parsing, manifest.json, audit.jsonl,
// dataset-path rewrite when $DATA points outside the .mod's directory,
// Variables-pane comm, retry/cancel, line-ending normalisation. Those land
// in chunks 3B–3D and milestone M3-status-bar / M5+.
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

  // Pull m.lst back even on non-zero exit — that's where NMTRAN error
  // messages live, and the user will want to see them. (FMSG / m.ext
  // arrive in 3B+.)
  const lstPath = path.join(localRunDir, 'm.lst');
  await transport.getFile(`${remoteRunDir}/m.lst`, lstPath);

  return { runId, exitCode, lstPath };
}

function parseExitCode(stdout: string): number | null {
  const match = /^EXIT=(-?\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

// runModel — remote-first NONMEM run orchestration.
//
// Pipeline (subdir-per-run discipline from nonmem-ssh-probe / design plan §4):
//
//   1. Generate runId = `pn-<unix-ts>`; record `started` timestamp.
//   2. mkdir -p <remoteRoot>/<runId>.
//   3. putFile <local m.mod>      -> <remoteRoot>/<runId>/m.mod.
//   4. If $DATA <token> present:
//      putFile <local dataset>    -> <remoteRoot>/<runId>/<basename>.
//   5. Run `cd <remoteRoot>/<runId> && <nmfeBinary> m.mod m.lst > m.nmfe.log 2>&1; echo EXIT=$?`.
//      The trailing `echo` is how we recover the exit code over the single-line
//      transport.
//   6. Parse `EXIT=N` from stdout.
//   7. transport.readFile(`<remote>/m.lst`) → parse OFV from `#OBJV:` banner.
//   8. Record `completed`; transport.writeFile(`<remote>/manifest.json`, …).
//
// Out of scope (per "no local sync" decision):
//   • Pulling outputs back to the workspace. The tree view + lazy
//     FileSystemProvider replace `<workspace>/.positron-nonmem/runs/`.
//   • Workspace-rooted audit.jsonl. Run discovery is now via remote `find`.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sha256File, writeManifest, type RunManifest } from './manifest';
import type { Transport } from '../transport';

export interface RunModelOptions {
  /** Absolute path to the user's .mod control stream. */
  modelPath: string;
  /** Already-resolved transport (Local for Remote-SSH workspace, Ssh otherwise). */
  transport: Transport;
  /** Remote run root, e.g. `~/positron-nonmem`. */
  remoteRoot: string;
  /** Path to nmfe76 on the remote host. */
  nmfeBinary: string;
  /** ~/.ssh/config alias of the host this run targets — recorded in manifest. */
  hostAlias: string;
  /** NONMEM version string for manifest provenance. */
  nonmemVersion: string;
}

export interface RunModelResult {
  runId: string;
  /** Exit code parsed from the remote `EXIT=$?` echo, or null if unparseable. */
  exitCode: number | null;
  /** Remote run directory (also where m.lst / m.ext / manifest.json live). */
  remoteRunDir: string;
  /** OFV parsed from `<remote>/m.lst`'s `#OBJV:` line, or null when absent. */
  ofv: number | null;
  /** Remote path of the manifest written for this run. */
  manifestPath: string;
}

/**
 * Take the first non-comment $DATA token from the model text and return
 * it verbatim (no path normalisation). Caller resolves it relative to
 * the .mod file's directory. Case-insensitive on the `$DATA` keyword
 * because NONMEM accepts lowercase record names.
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
 * `#OBJV:` line per estimation step; we take the LAST occurrence so
 * multi-$EST runs report the final objective. Returns null when absent.
 */
export function parseOfv(lstText: string): number | null {
  const re = /^\s*#OBJV:\s*\*+\s*(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)\s*\*+/gm;
  const last = [...lstText.matchAll(re)].at(-1);
  return last ? Number(last[1]) : null;
}

export async function runModel(opts: RunModelOptions): Promise<RunModelResult> {
  const { modelPath, transport, remoteRoot, nmfeBinary, hostAlias, nonmemVersion } = opts;

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
  const started = new Date().toISOString();
  const remoteRunDir = `${remoteRoot}/${runId}`;

  await transport.run(`mkdir -p ${remoteRunDir}`);

  await transport.putFile(modelPath, `${remoteRunDir}/m.mod`);

  const dataToken = parseDataFilename(modelText);
  let datasetLocal: string | null = null;
  if (dataToken) {
    datasetLocal = path.resolve(path.dirname(modelPath), dataToken);
    const remoteDatasetName = path.basename(dataToken);
    await transport.putFile(datasetLocal, `${remoteRunDir}/${remoteDatasetName}`);
  }

  const cmd = `cd ${remoteRunDir} && ${nmfeBinary} m.mod m.lst > m.nmfe.log 2>&1; echo EXIT=$?`;
  const result = await transport.run(cmd);
  const exitCode = parseExitCode(result.stdout);

  // Read m.lst remotely just to extract OFV; outputs stay on the host.
  // NMTRAN-only failures may not produce an m.lst at all — tolerate that
  // so the user still sees the EXIT in the toast.
  const ofv = await tryReadOfv(transport, `${remoteRunDir}/m.lst`);

  const manifest: RunManifest = {
    runId,
    started,
    completed: new Date().toISOString(),
    exitCode,
    ofv,
    modelHash: await sha256File(modelPath),
    datasetHash: datasetLocal ? await sha256File(datasetLocal) : null,
    nmfeBinary,
    nonmemVersion,
    hostAlias,
  };
  const manifestPath = await writeManifest(transport, remoteRunDir, manifest);

  return { runId, exitCode, remoteRunDir, ofv, manifestPath };
}

/** readFile + parseOfv, swallowing any error (missing file, parse miss) into null. */
async function tryReadOfv(transport: Transport, remoteLstPath: string): Promise<number | null> {
  try {
    return parseOfv(await transport.readFile(remoteLstPath));
  } catch {
    return null;
  }
}

function parseExitCode(stdout: string): number | null {
  const match = /^EXIT=(-?\d+)\s*$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

// Per-run provenance manifest. Lives next to outputs on the REMOTE host
// (`<remoteRunDir>/manifest.json`) — we don't sync it locally. The tree
// view + future lineage view discover runs by scanning the remote root
// and read manifests via Transport.readFile on demand. Privacy: hostAlias
// only — never the resolved hostname.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Transport } from '../transport';

export interface RunManifest {
  runId: string;
  /** ISO 8601 — when runModel started (after input validation). */
  started: string;
  /** ISO 8601 — when runModel finished (after all I/O completes). */
  completed: string;
  /** Exit code from `EXIT=$?` echo, or null if unparseable. */
  exitCode: number | null;
  /** OFV from m.lst's #OBJV banner, or null when no estimation step ran. */
  ofv: number | null;
  /** sha256 of the .mod file at upload time. */
  modelHash: string;
  /** sha256 of the dataset file, or null if the model has no $DATA token. */
  datasetHash: string | null;
  /** Remote nmfe76 path used for this run. */
  nmfeBinary: string;
  /** NONMEM version (cosmetic until we probe the host). */
  nonmemVersion: string;
  /** ~/.ssh/config alias — NEVER the resolved hostname. */
  hostAlias: string;
  /** Set by future duplicate-with-inheritance command (M10); undefined otherwise. */
  parentRunId?: string;
}

/**
 * sha256 of a LOCAL file (used to hash the .mod / dataset BEFORE we
 * upload them — at that point the bytes are local, hashing them on the
 * remote would be wasted round-trips). Outputs we hash post-run live
 * remotely; for those callers should `transport.run('sha256sum …')`.
 */
export async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Write `<remoteRunDir>/manifest.json` via the transport. Returns the remote path. */
export async function writeManifest(
  transport: Transport,
  remoteRunDir: string,
  m: RunManifest,
): Promise<string> {
  const remotePath = `${remoteRunDir}/manifest.json`;
  await transport.writeFile(remotePath, JSON.stringify(m, null, 2) + '\n');
  return remotePath;
}

// Per-run provenance: manifest.json sits in <localRunDir>; audit.jsonl
// is appended once per run at the workspace root. Captures everything
// downstream consumers (lineage view, run-comparison) need without
// re-reading the raw outputs. Privacy: hostAlias only — never the
// resolved hostname.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

export async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Write `<localRunDir>/manifest.json`; returns the path. */
export async function writeManifest(localRunDir: string, m: RunManifest): Promise<string> {
  await fs.mkdir(localRunDir, { recursive: true });
  const manifestPath = path.join(localRunDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(m, null, 2) + '\n');
  return manifestPath;
}

/** Append a one-line JSON record to the workspace audit log; creates the file/parents on first use. */
export async function appendAudit(auditLogPath: string, m: RunManifest): Promise<void> {
  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  await fs.appendFile(auditLogPath, JSON.stringify(m) + '\n');
}

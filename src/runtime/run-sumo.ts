// runSumo — invoke PsN's `sumo` against an `.lst` and return the
// parsed summary (statuses, OFV, condition number, runtime, sample
// sizes). Mirrors `runModel`'s shape: pure data in/out, Runner injected.
//
// We always invoke in the .lst's parent dir so absolute-path quirks
// don't matter (sumo accepts either, but mixing absolute paths with
// some PsN versions has produced surprises). Returns null on RC≠0
// OR unparseable output — caller decides whether to log the error.

import * as path from 'node:path';
import type { Runner } from '../runner';
import { quote } from '../shell';
import { parseSumo, type SumoSummary } from './parse-sumo';

export interface RunSumoOptions {
  /** Absolute path to the `<basename>.lst` to summarise. */
  lstPath: string;
  /** Runner used to invoke sumo. */
  runner: Runner;
  /** Path or PATH-resolvable name of PsN's `sumo` binary; default `sumo`. */
  binary?: string;
}

export async function runSumo(opts: RunSumoOptions): Promise<SumoSummary | null> {
  const { lstPath, runner, binary = 'sumo' } = opts;
  const cwd = path.dirname(lstPath);
  const lstBase = path.basename(lstPath);
  const result = await runner.run(`${quote(binary)} ${quote(lstBase)}`, cwd);
  if (result.code !== 0) return null;
  return parseSumo(result.stdout);
}

// Bridge to the vscode-nmtran extension's public API.
//
// vscode-nmtran exports `getParsedModel(uri)` from its `activate()` return
// value. We reach it via vscode.extensions.getExtension(...). The types
// below intentionally duplicate vscode-nmtran's `parsedModelApi.ts` so
// vrognas.nonmem doesn't reach into vscode-nmtran's internals; the
// eventual home for both is a shared types package (per the design plan).

import * as vscode from 'vscode';

const NMTRAN_EXTENSION_ID = 'vrognas.nmtran';

export interface NmtranThetaDecl {
  index: number;
  init: number;
  lower?: number;
  upper?: number;
  fix: boolean;
  /** 0-based line number of the declaration in the source. May be missing on older vscode-nmtran versions. */
  line?: number;
  /** Inline `;<comment>` text after the decl on its source line. Pirana-style label. Available from vscode-nmtran ≥ 0.4.20. */
  comment?: string;
}

export interface NmtranOmegaSigmaDecl {
  index: number;
  value: number;
  fix: boolean;
  /** 0-based line number of the declaration in the source. May be missing on older vscode-nmtran versions. */
  line?: number;
  /** See `NmtranThetaDecl.comment`. Available from vscode-nmtran ≥ 0.4.20. */
  comment?: string;
}

export interface NmtranEquation {
  name: string;
  rhs: string;
  block: string;
  line: number;
  /** Pre-computed value under the typical-individual convention; undefined when not evaluable. */
  value: number | undefined;
}

/**
 * `$PRIOR`-subroutine declaration shipped per parameter index. Available
 * from vscode-nmtran ≥ 0.4.23. `value` is per-record:
 *   - `$THETAP` / `$OMEGAP` / `$SIGMAP`: prior mean / mode.
 *   - `$THETAPV`: diagonal of the prior variance for THETA.
 *   - `$OMEGAPD` / `$SIGMAPD`: degrees of freedom (expanded per-param
 *     so consumers can look up by any OMEGA(i) directly).
 */
export interface NmtranPriorDecl {
  index: number;
  value: number;
  fix: boolean;
  line: number;
  comment?: string;
}

export interface NmtranParsedModel {
  dataFile: string | null;
  inputColumns: string[];
  thetas: NmtranThetaDecl[];
  omegas: NmtranOmegaSigmaDecl[];
  sigmas: NmtranOmegaSigmaDecl[];
  equations: NmtranEquation[];
  /** $THETAP prior means. Empty when record absent. Available ≥ 0.4.23. */
  thetaPriors?: NmtranPriorDecl[];
  /** $THETAPV prior variances (diagonal). Available ≥ 0.4.23. */
  thetaPriorVariances?: NmtranPriorDecl[];
  /** $OMEGAP prior modes. Available ≥ 0.4.23. */
  omegaPriors?: NmtranPriorDecl[];
  /** $OMEGAPD degrees of freedom (expanded per OMEGA index). Available ≥ 0.4.23. */
  omegaPriorDfs?: NmtranPriorDecl[];
  /** $SIGMAP prior modes. Available ≥ 0.4.23. */
  sigmaPriors?: NmtranPriorDecl[];
  /** $SIGMAPD degrees of freedom. Available ≥ 0.4.23. */
  sigmaPriorDfs?: NmtranPriorDecl[];
}

interface NmtranApi {
  getParsedModel(uri: vscode.Uri): Promise<NmtranParsedModel | null>;
  /**
   * Available from vscode-nmtran ≥ 0.4.21. Recommend ≥ 0.4.22 — earlier
   * versions had a cache-collision bug in this path that served the
   * first-parsed embedded stream for every subsequent call (silent
   * stale-counts on .lst switches).
   */
  parseModelFromText?(text: string): Promise<NmtranParsedModel | null>;
}

/**
 * Activate vscode-nmtran (if installed) and request a parsedModel snapshot
 * for the given URI. Returns null when the extension isn't installed, the
 * API surface is missing (older vscode-nmtran), or the server doesn't yet
 * know the document. Callers should treat null as "no model available" —
 * not as an error.
 */
export async function getNmtranParsedModel(uri: vscode.Uri): Promise<NmtranParsedModel | null> {
  const ext = vscode.extensions.getExtension(NMTRAN_EXTENSION_ID);
  if (!ext) return null;
  const api = (await ext.activate()) as Partial<NmtranApi> | undefined;
  if (!api?.getParsedModel) return null;
  return api.getParsedModel(uri);
}

/**
 * Parse a control-stream string directly via vscode-nmtran's
 * `parseModelFromText` API (≥ 0.4.21). Used by lst-mode to derive
 * decls from the embedded control stream in the .lst itself, so the
 * Fit Inspector reflects the model AS RUN, not the current sibling
 * .mod. Returns null when the API isn't available (older
 * vscode-nmtran) — caller should fall back to sibling-.mod parsing.
 */
export async function parseNmtranModelFromText(text: string): Promise<NmtranParsedModel | null> {
  const ext = vscode.extensions.getExtension(NMTRAN_EXTENSION_ID);
  if (!ext) return null;
  const api = (await ext.activate()) as Partial<NmtranApi> | undefined;
  if (!api?.parseModelFromText) return null;
  return api.parseModelFromText(text);
}

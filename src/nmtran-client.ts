// Bridge to the vscode-nmtran extension's public API.
//
// vscode-nmtran exports `getParsedModel(uri)` from its `activate()` return
// value. We reach it via vscode.extensions.getExtension(...). The types
// below intentionally duplicate vscode-nmtran's `parsedModelApi.ts` so
// positron-nonmem doesn't reach into vscode-nmtran's internals; the
// eventual home for both is a shared types package (per the design plan).

import * as vscode from 'vscode';

const NMTRAN_EXTENSION_ID = 'vrognas.nmtran';

export interface NmtranThetaDecl {
  index: number;
  init: number;
  lower?: number;
  upper?: number;
  fix: boolean;
}

export interface NmtranOmegaSigmaDecl {
  index: number;
  value: number;
  fix: boolean;
}

export interface NmtranEquation {
  name: string;
  rhs: string;
  block: string;
  line: number;
  /** Pre-computed value under the typical-individual convention; undefined when not evaluable. */
  value: number | undefined;
}

export interface NmtranParsedModel {
  dataFile: string | null;
  inputColumns: string[];
  thetas: NmtranThetaDecl[];
  omegas: NmtranOmegaSigmaDecl[];
  sigmas: NmtranOmegaSigmaDecl[];
  equations: NmtranEquation[];
}

interface NmtranApi {
  getParsedModel(uri: vscode.Uri): Promise<NmtranParsedModel | null>;
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

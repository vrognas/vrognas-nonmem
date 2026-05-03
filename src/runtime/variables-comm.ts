// Variables-pane wire format + mapping from NmtranParsedModel.
//
// The wire format mirrors what positron-javascript/src/variables.ts emits
// (Positron's frontend treats this shape as canonical). For NONMEM the
// "variables" are file-scoped declarations + derived equations rather
// than runtime-environment bindings — see chunk 3D design discussion in
// the conversation history. All variables are leaves in this cut; bound
// triples / FIX flags are folded into display_value text.

import type {
  NmtranParsedModel,
  NmtranEquation,
  NmtranOmegaSigmaDecl,
  NmtranThetaDecl,
} from '../nmtran-client';

/**
 * Single Variables-pane row. Field names + required-ness come from
 * positron/comms/variables-backend-openrpc.json. `kind` drives icon +
 * interaction, `display_*` drive the visible cells.
 */
export interface Variable {
  access_key: string;
  display_name: string;
  display_value: string;
  display_type: string;
  type_info: string;
  // Full kind enum per positron/comms/variables-backend-openrpc.json. We
  // only emit 'number' / 'string' / 'class' for now; the rest are kept
  // here so future chunks can use them without re-typing.
  kind:
    | 'boolean'
    | 'bytes'
    | 'class'
    | 'collection'
    | 'connection'
    | 'empty'
    | 'function'
    | 'lazy'
    | 'map'
    | 'number'
    | 'other'
    | 'string'
    | 'table';
  has_children: boolean;
  length: number;
  size: number;
  is_truncated: boolean;
  has_viewer: boolean;
  /** Milliseconds since epoch, or 0 if not tracked. */
  updated_time: number;
}

/** Convert a parsed-model snapshot into Positron Variables-pane rows. */
export function mapParsedModelToVariables(model: NmtranParsedModel): Variable[] {
  const out: Variable[] = [];

  // Declared parameters use kind: 'class' so Positron's frontend (which
  // hard-codes group names: Data / Values / Functions / Classes) puts them
  // under a separate "CLASSES" header, visually splitting raw parameters
  // from derived equations. The label is a mild semantic compromise — we
  // can't change the group name without forking Positron — but the
  // grouping is the actual goal. A custom TreeDataProvider view (future
  // chunk) would give us proper "PARAMETERS" / "VARIABLES" labels.
  for (const t of model.thetas) {
    out.push(parameterRow(`THETA(${t.index})`, thetaDisplay(t), 'theta', t));
  }
  for (const o of model.omegas) {
    out.push(parameterRow(`OMEGA(${o.index},${o.index})`, omegaSigmaDisplay(o), 'omega', o));
  }
  for (const s of model.sigmas) {
    out.push(parameterRow(`SIGMA(${s.index},${s.index})`, omegaSigmaDisplay(s), 'sigma', s));
  }
  for (const eq of model.equations) {
    out.push(equationRow(eq));
  }

  return out;
}

/**
 * Resolve a Variables-comm `access_key` back to the source-line of the
 * underlying declaration. For parameters access_key matches display_name
 * (`THETA(1)` etc.); for equations display_name is suffixed with the
 * owning $RECORD but access_key stays as the bare equation name.
 * Returns null when the access_key doesn't correspond to a known row,
 * or when the declaration has no line tracked (older vscode-nmtran).
 */
export function resolveAccessKeyLine(
  model: NmtranParsedModel,
  accessKey: string,
): number | null {
  const eq = model.equations.find((e) => e.name === accessKey);
  if (eq) return eq.line;

  const theta = accessKey.match(/^THETA\((\d+)\)$/);
  if (theta) return findDeclLine(model.thetas, parseInt(theta[1]!, 10));

  const diag = accessKey.match(/^(OMEGA|SIGMA)\((\d+),(\d+)\)$/);
  if (diag && diag[2] === diag[3]) {
    const idx = parseInt(diag[2]!, 10);
    const decls = diag[1] === 'OMEGA' ? model.omegas : model.sigmas;
    return findDeclLine(decls, idx);
  }
  return null;
}

/** Look up a parameter decl by index and return its tracked line, or null when missing. */
function findDeclLine(decls: { index: number; line?: number }[], index: number): number | null {
  return decls.find((d) => d.index === index)?.line ?? null;
}

function thetaDisplay(t: NmtranThetaDecl): string {
  const initStr = formatNumber(t.init);
  if (t.fix) return `${initStr} (FIX)`;
  if (t.lower !== undefined && t.upper !== undefined) {
    return `${initStr} (${formatNumber(t.lower)}..${formatNumber(t.upper)})`;
  }
  if (t.lower !== undefined) return `${initStr} (>=${formatNumber(t.lower)})`;
  if (t.upper !== undefined) return `${initStr} (<=${formatNumber(t.upper)})`;
  return initStr;
}

function omegaSigmaDisplay(d: NmtranOmegaSigmaDecl): string {
  return d.fix ? `${formatNumber(d.value)} (FIX)` : formatNumber(d.value);
}

/**
 * Build a parameter (THETA / OMEGA / SIGMA) row. has_viewer is wired to
 * whether vscode-nmtran tracked a decl line (>=0.4.18); older releases
 * lack it and we degrade gracefully to non-navigable.
 */
function parameterRow(
  name: string,
  displayValue: string,
  nmtranType: string,
  decl: NmtranThetaDecl | NmtranOmegaSigmaDecl,
): Variable {
  return leaf({
    name,
    displayValue,
    kind: 'class',
    nmtranType,
    hasViewer: typeof decl.line === 'number',
  });
}

function equationRow(eq: NmtranEquation): Variable {
  const evaluable = eq.value !== undefined;
  return leaf({
    name: eq.name,
    // Positron replaces the display_type cell with the View action button
    // when has_viewer is true, so we suffix the owning control record
    // ($PRED / $PK / $ERROR / …) onto the display_name instead. The
    // access_key (used by view-RPC lookup) stays as eq.name.
    displayName: `${eq.name}  ${eq.block}`,
    displayValue: evaluable ? formatNumber(eq.value!) : eq.rhs,
    kind: evaluable ? 'number' : 'string',
    nmtranType: eq.block,
    // Equations always carry a line; runtime-session routes the
    // resulting `view` RPC to the editor at eq.line.
    hasViewer: true,
  });
}

/**
 * Format a number for the Variables-pane display: max 3 decimal places,
 * trailing zeros dropped (so 0.5 not 0.500, integers stay integers),
 * scientific notation for extremes (>= 1e7 or non-zero < 1e-3) so we
 * don't lose all signal on very small / very large values.
 */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e7 || abs < 1e-3) return n.toExponential(3);
  return parseFloat(n.toFixed(3)).toString();
}

function leaf(args: {
  name: string;
  /** Visible label; defaults to `name`. Lookup still uses `name` as the access_key. */
  displayName?: string;
  displayValue: string;
  kind: Variable['kind'];
  nmtranType: string;
  hasViewer?: boolean;
}): Variable {
  return {
    access_key: args.name,
    display_name: args.displayName ?? args.name,
    display_value: args.displayValue,
    display_type: args.nmtranType,
    type_info: '',
    kind: args.kind,
    has_children: false,
    length: 0,
    size: 0,
    is_truncated: false,
    has_viewer: args.hasViewer ?? false,
    updated_time: 0,
  };
}

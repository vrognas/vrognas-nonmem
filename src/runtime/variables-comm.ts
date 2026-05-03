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
    out.push(parameterRow({
      name: `THETA(${t.index})`,
      displayValue: thetaDisplay(t.init, t.lower, t.upper, t.fix),
      nmtranType: 'theta',
      decl: t,
    }));
  }
  for (const o of model.omegas) {
    out.push(parameterRow({
      name: `OMEGA(${o.index},${o.index})`,
      displayValue: o.fix ? `${formatNumber(o.value)} (FIX)` : formatNumber(o.value),
      nmtranType: 'omega',
      decl: o,
    }));
  }
  for (const s of model.sigmas) {
    out.push(parameterRow({
      name: `SIGMA(${s.index},${s.index})`,
      displayValue: s.fix ? `${formatNumber(s.value)} (FIX)` : formatNumber(s.value),
      nmtranType: 'sigma',
      decl: s,
    }));
  }
  for (const eq of model.equations) {
    out.push(equationRow(eq));
  }

  return out;
}

/**
 * Resolve a Variables-comm `access_key` (matches `display_name` in our
 * mapping) back to the source-line of the underlying declaration.
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
  if (theta) {
    const idx = parseInt(theta[1]!, 10);
    return model.thetas.find((t) => t.index === idx)?.line ?? null;
  }
  const omega = accessKey.match(/^OMEGA\((\d+),(\d+)\)$/);
  if (omega && omega[1] === omega[2]) {
    const idx = parseInt(omega[1]!, 10);
    return model.omegas.find((o) => o.index === idx)?.line ?? null;
  }
  const sigma = accessKey.match(/^SIGMA\((\d+),(\d+)\)$/);
  if (sigma && sigma[1] === sigma[2]) {
    const idx = parseInt(sigma[1]!, 10);
    return model.sigmas.find((s) => s.index === idx)?.line ?? null;
  }
  return null;
}

function thetaDisplay(
  init: number,
  lower: number | undefined,
  upper: number | undefined,
  fix: boolean,
): string {
  const initStr = formatNumber(init);
  if (fix) return `${initStr} (FIX)`;
  if (lower !== undefined && upper !== undefined) {
    return `${initStr} (${formatNumber(lower)}..${formatNumber(upper)})`;
  }
  if (lower !== undefined) return `${initStr} (>=${formatNumber(lower)})`;
  if (upper !== undefined) return `${initStr} (<=${formatNumber(upper)})`;
  return initStr;
}

function parameterRow(args: {
  name: string;
  displayValue: string;
  nmtranType: string;
  decl: NmtranThetaDecl | NmtranOmegaSigmaDecl;
}): Variable {
  // Only mark navigable when vscode-nmtran has actually tracked a line —
  // pre-0.4.18 versions don't, and we don't want a dead double-click.
  const navigable = typeof args.decl.line === 'number';
  return {
    ...leaf({
      name: args.name,
      displayValue: args.displayValue,
      kind: 'class',
      nmtranType: args.nmtranType,
    }),
    has_viewer: navigable,
  };
}

function equationRow(eq: NmtranEquation): Variable {
  const evaluable = eq.value !== undefined;
  // has_viewer:true makes Positron's frontend send a `view` RPC on
  // double-click; runtime-session routes it to the editor at eq.line.
  return {
    ...leaf({
      name: eq.name,
      displayValue: evaluable ? formatNumber(eq.value!) : eq.rhs,
      kind: evaluable ? 'number' : 'string',
      // Show the owning control record ($PRED / $PK / $ERROR / …) rather
      // than the rhs text. The full expression is already encoded in the
      // displayValue when the value can't be evaluated.
      nmtranType: eq.block,
    }),
    has_viewer: true,
  };
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
  displayValue: string;
  kind: Variable['kind'];
  nmtranType: string;
}): Variable {
  return {
    access_key: args.name,
    display_name: args.name,
    display_value: args.displayValue,
    display_type: args.nmtranType,
    type_info: '',
    kind: args.kind,
    has_children: false,
    length: 0,
    size: 0,
    is_truncated: false,
    has_viewer: false,
    updated_time: 0,
  };
}

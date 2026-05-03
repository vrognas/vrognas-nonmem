// Variables-pane wire format + mapping from NmtranParsedModel.
//
// The wire format mirrors what positron-javascript/src/variables.ts emits
// (Positron's frontend treats this shape as canonical). For NONMEM the
// "variables" are file-scoped declarations + derived equations rather
// than runtime-environment bindings — see chunk 3D design discussion in
// the conversation history. All variables are leaves in this cut; bound
// triples / FIX flags are folded into display_value text.

import type { NmtranParsedModel, NmtranEquation } from '../nmtran-client';

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
    out.push(
      leaf({
        name: `THETA(${t.index})`,
        displayValue: thetaDisplay(t.init, t.lower, t.upper, t.fix),
        kind: 'class',
        nmtranType: 'theta',
      }),
    );
  }
  for (const o of model.omegas) {
    out.push(
      leaf({
        name: `OMEGA(${o.index},${o.index})`,
        displayValue: o.fix ? `${o.value} (FIX)` : `${o.value}`,
        kind: 'class',
        nmtranType: 'omega',
      }),
    );
  }
  for (const s of model.sigmas) {
    out.push(
      leaf({
        name: `SIGMA(${s.index},${s.index})`,
        displayValue: s.fix ? `${s.value} (FIX)` : `${s.value}`,
        kind: 'class',
        nmtranType: 'sigma',
      }),
    );
  }
  for (const eq of model.equations) {
    out.push(equationRow(eq));
  }

  return out;
}

function thetaDisplay(
  init: number,
  lower: number | undefined,
  upper: number | undefined,
  fix: boolean,
): string {
  if (fix) return `${init} (FIX)`;
  if (lower !== undefined && upper !== undefined) return `${init} (${lower}..${upper})`;
  if (lower !== undefined) return `${init} (>=${lower})`;
  if (upper !== undefined) return `${init} (<=${upper})`;
  return `${init}`;
}

function equationRow(eq: NmtranEquation): Variable {
  const evaluable = eq.value !== undefined;
  return leaf({
    name: eq.name,
    displayValue: evaluable ? `${eq.value}` : eq.rhs,
    kind: evaluable ? 'number' : 'string',
    nmtranType: `equation = ${eq.rhs}`,
  });
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

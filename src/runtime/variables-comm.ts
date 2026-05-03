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
 * Single Variables-pane row. Field names are dictated by Positron's
 * frontend; `kind` drives icon + interaction, `display_*` drive the
 * visible cells.
 */
export interface Variable {
  access_key: string;
  display_name: string;
  display_value: string;
  display_type: string;
  type_info: string;
  kind: 'number' | 'string' | 'boolean' | 'collection' | 'empty' | 'other';
  has_children: boolean;
  length: number;
  size: number;
  is_truncated: boolean;
  has_viewer: boolean;
}

/** Convert a parsed-model snapshot into Positron Variables-pane rows. */
export function mapParsedModelToVariables(model: NmtranParsedModel): Variable[] {
  const out: Variable[] = [];

  for (const t of model.thetas) {
    out.push(
      leaf({
        name: `THETA(${t.index})`,
        displayValue: thetaDisplay(t.init, t.lower, t.upper, t.fix),
        kind: 'number',
        nmtranType: 'theta',
      }),
    );
  }
  for (const o of model.omegas) {
    out.push(
      leaf({
        name: `OMEGA(${o.index},${o.index})`,
        displayValue: o.fix ? `${o.value} (FIX)` : `${o.value}`,
        kind: 'number',
        nmtranType: 'omega',
      }),
    );
  }
  for (const s of model.sigmas) {
    out.push(
      leaf({
        name: `SIGMA(${s.index},${s.index})`,
        displayValue: s.fix ? `${s.value} (FIX)` : `${s.value}`,
        kind: 'number',
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
  };
}

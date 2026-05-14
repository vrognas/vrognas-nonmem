// Diagnostics-block builder for the Fit Inspector payload. Split out
// of `fit-inspector-payload.ts` so the per-step XML-options tier
// classification + $COV resolution + correlation-redflag pipeline
// sits in one focused module.
//
// `buildDiagnostics` consumes `BuildDiagnosticsArgs` (one object — the
// positional-arity hit 9 once $PRIOR / $COV resolutions were added)
// and emits `InspectorDiagnostics | null`. Null when nothing useful
// would render (no lst termination, no shrinkages, no eigvals, no
// red flags, no XML steps, …) — the renderer hides the whole block
// in that case.

import type { CorTable } from '../runtime/parse-cor';
import type { ExtEstimates } from '../runtime/parse-ext-fit';
import type { EstimationOptionsStep } from '../runtime/parse-xml-options';
import {
  classifyEstStep,
  deriveMethodKind,
  type MethodKind,
} from '../runtime/xml-est-defaults';
import type { CovarianceOptions } from '../runtime/parse-xml-problem-options';
import {
  classifyCovStep,
  resolveCovAttrToRuntime,
  type CovTier,
} from '../runtime/xml-cov-defaults';
import type { EstimationStepResult } from '../runtime/parse-xml-results';
import type { RawEstRecord } from '../runtime/parse-lst-est-records';
import type { LstTolerances } from '../runtime/parse-lst-tolerances';
import type { LstSummary } from '../runtime/parse-lst';
import type { SumoSummary } from '../runtime/parse-sumo';
import { findCorrelationRedFlags } from './correlation-redflags';
import type { InspectorDiagnostics } from './fit-inspector-payload';

/**
 * `buildDiagnostics` arg shape — collected into one object once the
 * positional arity hit 9 (each new XML / .lst / aux-file source adds
 * a parameter). Single call site, mechanical change, prevents the
 * function from accumulating any more positional bloat.
 */
export interface BuildDiagnosticsArgs {
  lst: LstSummary;
  sumo: SumoSummary | null;
  prderr: { content: string; source: 'plain' | 'archive' } | null;
  fmsg: { content: string; source: 'plain' | 'archive'; hasErrors: boolean } | null;
  fit: ExtEstimates | null;
  cor: CorTable | null;
  corrWarnThreshold: number;
  corrRedFlagThreshold: number;
  xmlEstimationOptions: EstimationOptionsStep[];
  xmlEstimationResults: EstimationStepResult[];
  xmlCovarianceOptions: CovarianceOptions | null;
  lstEstRecords: RawEstRecord[];
  lstCovRecord: RawEstRecord | null;
  lstTolerances: LstTolerances;
  hasOde: boolean;
  hasLevel: boolean;
  /**
   * NM's default `file` value for this run, derived as `<basename>.ext`
   * from the lst path (e.g., `run001.lst` → `run001.ext`). Null when
   * mod-mode (no lst path). Used by `classifyEstStep` to detect when
   * a non-default file like `psn.ext` (PsN's wrapper convention) was
   * imposed by tooling rather than the modeller.
   */
  expectedDefaultFile: string | null;
}

export function buildDiagnostics(args: BuildDiagnosticsArgs): InspectorDiagnostics | null {
  const {
    lst,
    sumo,
    prderr,
    fmsg,
    fit,
    cor,
    corrWarnThreshold,
    corrRedFlagThreshold,
    xmlEstimationOptions,
    xmlEstimationResults,
    xmlCovarianceOptions,
    lstEstRecords,
    lstCovRecord,
    lstTolerances,
    expectedDefaultFile,
    hasOde,
    hasLevel,
  } = args;
  const conditionNumber = sumo?.conditionNumber ?? lst.conditionNumber ?? null;
  const eigs = lst.eigenvalues;
  // Display signed min/max so the user sees if any eigenvalue is
  // negative (signals a non-PD COR matrix). The condition-number
  // value comes from sumo; we don't recompute it here. Avoid spread
  // (`Math.min(...arr)`) — JS engines cap function-argument counts
  // (~65535 on V8), and multi-compartment models with large OMEGA
  // BLOCKs can produce more eigenvalues than that.
  const eigenvalues: InspectorDiagnostics['eigenvalues'] =
    eigs.length > 0
      ? {
          min: eigs.reduce((m, v) => (v < m ? v : m), eigs[0]),
          max: eigs.reduce((m, v) => (v > m ? v : m), eigs[0]),
        }
      : null;
  const terminationCodes = fit?.terminationCodes ?? [];
  const correlationRedFlags = findCorrelationRedFlags(cor, corrWarnThreshold, corrRedFlagThreshold);
  // Hide block when there's nothing to show.
  const empty =
    lst.termination === null &&
    lst.etabar.length === 0 &&
    lst.etaShrinkSd.length === 0 &&
    lst.epsShrinkSd.length === 0 &&
    eigenvalues === null &&
    prderr === null &&
    fmsg === null &&
    lst.acceptanceRate === null &&
    terminationCodes.length === 0 &&
    lst.finalGradient.length === 0 &&
    lst.hessianResets === 0 &&
    lst.diagonalShift === null &&
    lst.cput === null &&
    lst.paraNodes === null &&
    correlationRedFlags.length === 0 &&
    xmlEstimationOptions.length === 0 &&
    xmlEstimationResults.length === 0 &&
    xmlCovarianceOptions === null;
  if (empty) return null;
  // Per-step tier-map: `key → tier` (explicit/explicitDefault/implicit).
  // Single source of truth for the inspector's $EST coloring; implicit
  // tier covers both AUTO-set and propagation cases (visually unified —
  // both are "NM picked this, not the user").
  const xmlEstimationTiers = xmlEstimationOptions.map((step, i) => {
    const tokens = lstEstRecords[i]?.tokens ?? [];
    return classifyEstStep(step, tokens, expectedDefaultFile);
  });
  const xmlEstimationMethodKinds: MethodKind[] = xmlEstimationOptions.map(deriveMethodKind);
  // Unified $COV tier-map (explicit/explicitDefault/implicit) — same
  // scheme as $EST. Drives the inspector's $COV coloring via .lst $COV
  // tokens (user-typed vs. not).
  const lastEst = xmlEstimationOptions.length > 0
    ? xmlEstimationOptions[xmlEstimationOptions.length - 1]
    : null;
  const covTokens = lstCovRecord?.tokens ?? [];
  const xmlCovarianceTiers: Record<string, CovTier> = xmlCovarianceOptions
    ? classifyCovStep(xmlCovarianceOptions, covTokens)
    : {};
  // Per-key wire→runtime resolution for $COV sentinels. The posdef
  // sentinel ('-1') resolves to 0 (classical) / 3 (EM) — collapse
  // the 4-way methodKind to binary for that lookup.
  const lastEstMethodKind = xmlEstimationMethodKinds.length > 0
    ? xmlEstimationMethodKinds[xmlEstimationMethodKinds.length - 1]
    : null;
  const methodKind: 'em' | 'classical' | null = lastEstMethodKind === null
    ? null
    : lastEstMethodKind === 'em' ? 'em' : 'classical';
  const xmlCovarianceResolved: Record<string, string> = {};
  if (xmlCovarianceOptions) {
    for (const k of Object.keys(xmlCovarianceOptions)) {
      const resolved = resolveCovAttrToRuntime(
        k,
        xmlCovarianceOptions[k],
        lastEst,
        lstTolerances,
        methodKind,
      );
      if (resolved !== null && resolved !== xmlCovarianceOptions[k]) {
        xmlCovarianceResolved[k] = resolved;
      }
    }
  }
  return {
    termination: lst.termination,
    terminationPhrase: lst.terminationPhrase,
    terminationReason: lst.terminationReason,
    etabar: lst.etabar,
    etabarSe: lst.etabarSe,
    etaN: lst.etaN,
    etaPVal: lst.etaPVal,
    etaShrinkSd: lst.etaShrinkSd,
    etaShrinkVr: lst.etaShrinkVr,
    epsShrinkSd: lst.epsShrinkSd,
    epsShrinkVr: lst.epsShrinkVr,
    eigenvalues,
    conditionNumber,
    terminationCodes,
    finalGradient: lst.finalGradient,
    hessianResets: lst.hessianResets,
    diagonalShift: lst.diagonalShift,
    cput: lst.cput,
    paraNodes: lst.paraNodes,
    covMatrixSingular: lst.covMatrixSingular,
    parameterNearBoundary: lst.parameterNearBoundary,
    boundaryTestOmitted: lst.boundaryTestOmitted,
    prderr,
    fmsg,
    acceptanceRate: lst.acceptanceRate,
    correlationRedFlags,
    xmlEstimationOptions,
    xmlEstimationTiers,
    xmlEstimationMethodKinds,
    xmlEstimationResults,
    xmlCovarianceOptions,
    xmlCovarianceTiers,
    xmlCovarianceResolved,
    lstEstRecords,
    lstCovRecord,
    lstTolerances,
    hasOde,
    hasLevel,
  };
}

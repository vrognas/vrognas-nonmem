// Test fixture builder for `LstSummary`. Every test that mocks an
// .lst-mode payload was carrying an inline literal of all 30+ fields;
// adding a new field meant touching 4 places. This helper has the full
// "empty" baseline; callers override only the fields under test.

import type { LstSummary } from '../../src/runtime/parse-lst';

const EMPTY_LST: LstSummary = {
  method: null,
  methodShort: null,
  methods: [],
  methodsShort: [],
  initialOmega: new Map(),
  initialSigma: new Map(),
  objv: null,
  cput: null,
  paraNodes: null,
  finalGradient: [],
  hessianResets: 0,
  diagonalShift: null,
  sigDigits: null,
  nsigRequired: null,
  termination: null,
  terminationPhrase: null,
  terminationReason: null,
  etabar: [],
  etabarSe: [],
  etaN: [],
  etaPVal: [],
  etaShrinkSd: [],
  etaShrinkVr: [],
  ebvShrinkSd: [],
  ebvShrinkVr: [],
  epsShrinkSd: [],
  epsShrinkVr: [],
  eigenvalues: [],
  conditionNumber: null,
  acceptanceRate: null,
  covMatrixSingular: null,
  rseMatrix: null,
  seBlockEmitted: false,
  hasDesign: false,
  parameterNearBoundary: false,
  boundaryTestOmitted: { theta: false, omega: false, sigma: false },
  numSigDigPerParam: [],
};

export function mockLst(overrides: Partial<LstSummary> = {}): LstSummary {
  return { ...EMPTY_LST, ...overrides };
}

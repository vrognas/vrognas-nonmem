// Node-mode bridge: in the WebView, sibling `<script>` tags share one
// global scope, so `INVISIBLE_ATTR_DEFAULTS` (defined in
// xml-invisible-attrs.js) is visible to this file's function bodies
// without ceremony. Under vitest each .js is a separate CJS module —
// require the sibling here so its `Object.assign(globalThis, ...)`
// runs and populates globals before any function in this file is
// called. `typeof require` check keeps the WebView side a no-op.
if (typeof require !== 'undefined' && typeof module !== 'undefined') {
  require('./xml-invisible-attrs.js');
}

// Fit Inspector WebView client — render orchestrator + message handler.
//
// Loaded by `fit-inspector-provider.ts` via `webview.asWebviewUri`.
// Receives `{ type: 'update', payload }` from the extension and
// renders into `#root`. Sends `{ type: 'ready' }` once loaded so the
// extension can replay its cached payload, and `{ type: 'gotoLine',
// line }` when the user clicks a parameter row.
//
// Pure DOM API — createElement / textContent / append. No innerHTML
// anywhere; untrusted strings (param names, file paths) can't escape
// into HTML structure.
//
// Companion files (loaded BEFORE this in the inspector HTML):
//   - `formatters.js`: fmtNum / fmtRse / fmtPVal / fmtShrinkage /
//     fmtNsd / badge / terminationCodeLabel — value-to-string/DOM
//     formatters. Read the `thresholds` global set on each render.
//   - `transforms.js`: matrixIsDiagonal / buildDiagBaseValues /
//     transformValue / collectEtaShrinkages / collectEpsShrinkages —
//     value transforms (sqrt-Ω / exp-θ / correlation form) and
//     shrinkage-source selection.
// All three files are plain top-level scripts — functions live on the
// inspector window's global scope, so this file uses them as if they
// were defined inline.

const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg && msg.type === 'update') {
    try {
      render(msg.payload);
    } catch (e) {
      // Surface render errors to the extension Output channel — without
      // this, a JS exception in the WebView script silently aborts and
      // the panel goes empty with no clue why.
      vscode.postMessage({
        type: 'renderError',
        // Don't ship `e.stack` — Chromium frames include vscode-resource://
        // URIs and absolute paths. Receiver sanitises too (defense-in-depth).
        message: e && e.message ? e.message : String(e),
      });
      // Best-effort fallback: clear and show a one-line error so the
      // user knows something went wrong even if they don't check Output.
      while (root.firstChild) root.removeChild(root.firstChild);
      const fallback = document.createElement('div');
      fallback.className = 'empty';
      fallback.textContent = 'Fit Inspector render error: ' + String(e);
      root.append(fallback);
    }
  }
});

window.addEventListener('error', (ev) => {
  vscode.postMessage({ type: 'renderError', message: String(ev.message || ev.error || ev) });
});
window.addEventListener('unhandledrejection', (ev) => {
  vscode.postMessage({ type: 'renderError', message: String(ev.reason) });
});

// Module-level thresholds — set on every payload update so the
// renderers (which are pure helpers) can read them without threading
// the payload through every call site. Default values match
// `DEFAULT_THRESHOLDS` in fit-inspector-payload.ts.
// WebView only reads thresholds it actually consumes; correlation
// thresholds (corrRedFlagThreshold / corrWarnThreshold) are NOT here
// because pair classification (`f.kind`) is done payload-side in
// fit-inspector-payload.ts. If we ever ship a tooltip / message that
// quotes the raw threshold, source it from the payload's `thresholds`
// at point-of-use, NOT this defaults block — which would otherwise
// drift from extension-host config defaults.
let thresholds = {
  shrinkageWarnPct: 30,
  shrinkageBorderlineWarnPct: 20,
  rseWarnPct: 100,
  rseThetaWarnPct: 30,
  rseOmegaWarnPct: 50,
  pValWarnThreshold: 0.1,
  pValBadThreshold: 0.05,
  condNumberBadThreshold: 1000,
  condNumberWarnThreshold: 100,
  nsigRequired: null,
};

// Last payload retained so the toggles can re-render without a round
// trip to the extension. Display preferences (sqrtOm / expTh) persist
// via vscode.setState across panel re-mounts (e.g. the user reloads
// the WebView while the same .lst is open).
let lastPayload = null;
const persisted = vscode.getState() || {};
const prefs = {
  sqrtOm: typeof persisted.sqrtOm === 'boolean' ? persisted.sqrtOm : false,
  expTh: typeof persisted.expTh === 'boolean' ? persisted.expTh : false,
};

function savePrefs() {
  vscode.setState({ sqrtOm: prefs.sqrtOm, expTh: prefs.expTh });
}

function render(payload) {
  lastPayload = payload;
  while (root.firstChild) root.removeChild(root.firstChild);
  if (!payload) {
    root.append(emptyMessage('Open a .mod or .lst file to inspect.'));
    return;
  }
  if (payload.thresholds) thresholds = payload.thresholds;
  if (payload.summary) root.append(renderSummary(payload.summary));
  if (payload.runNotes) root.append(renderRunNotes(payload.runNotes));
  const hasFit = anyFinal(payload.thetas) || anyFinal(payload.omegas) || anyFinal(payload.sigmas);
  // Prominent OFV display above the parameter tables when we have a fit.
  // Final OFV is the headline number a modeller looks at first; making it
  // a primary visual instead of a tail-end summary-line entry saves a
  // squint. Only render when we actually have an OFV (mod-mode / no fit
  // → skip). Suffix the label with "(at init)" for MAXEVAL=0 runs so
  // the user doesn't read it as a fitted value.
  if (hasFit && payload.summary && typeof payload.summary.ofv === 'number') {
    const lst = payload.summary.lst;
    // isAnyEvalStep: ANY chained $EST step being MAXEVAL=0 makes the
    // OFV an init-evaluation rather than a fitted value (v0.0.194).
    const sigDigits = lst && typeof lst.sigDigits === 'number' ? lst.sigDigits : null;
    const nsigRequired = lst && typeof lst.nsigRequired === 'number' ? lst.nsigRequired : null;
    root.append(renderOfvHeadline(payload.summary.ofv, isAnyEvalStep(lst), sigDigits, nsigRequired));
  }
  let rendered = false;
  // Toggles live inline next to their relevant table heading now —
  // exp(θ) on Theta, √Ω/ρ on Omega (also drives Sigma display).
  // Co-locating the control with the column it affects.
  // Label column is only useful when some row has an inline `;<comment>`
  // — most models won't, so reserving 130px for em-dashes everywhere
  // wastes pane width. Compute once across all sections so column widths
  // stay uniform between THETA / OMEGA / SIGMA.
  const showLabel =
    payload.thetas.some((r) => r.label) ||
    payload.omegas.some((r) => r.label) ||
    payload.sigmas.some((r) => r.label);
  // Show P (and PV/PD) columns when ANY kind has at least one prior
  // value. Toggle ALL kinds together so the column position stays
  // vertically aligned across the THETA / OMEGA / SIGMA tables — even
  // sections without their own priors render the columns as em-dash
  // for alignment. Matches the same all-or-nothing rule as `showLabel`.
  const hasPrior = (r) => r.priorValue !== null || r.priorVariance !== null || r.priorDf !== null;
  const showPrior =
    payload.thetas.some(hasPrior) ||
    payload.omegas.some(hasPrior) ||
    payload.sigmas.some(hasPrior);
  if (payload.thetas.length) { root.append(renderSection('Theta', payload.thetas, hasFit, 'theta', showLabel, showPrior)); rendered = true; }
  if (payload.omegas.length) { root.append(renderSection('Omega', payload.omegas, hasFit, 'omega', showLabel, showPrior)); rendered = true; }
  if (payload.sigmas.length) { root.append(renderSection('Sigma', payload.sigmas, hasFit, 'sigma', showLabel, showPrior)); rendered = true; }
  // Top-level section order, post-params:
  //   diagnostics (failure modes + identifiability)
  //   trajectory (estimation dynamics)
  //   EST options (configuration that drove the dynamics)
  //   ETA table (per-individual post-hoc diagnostics)
  // Trajectory + EST + ETA were previously buried inside diagnostics; the
  // split puts each section under its own topical h3 / collapsible.
  if (payload.diagnostics) root.append(renderDiagnostics(payload.diagnostics));
  if (payload.trajectories && payload.trajectories.length) {
    // xmlEstimationResults (term status + per-step timing) carried on
    // diagnostics; index-aligned with trajectories (both 1:1 with $EST).
    // xmlEstimationOptions also passed so termination-code labels can
    // be method-aware (EM codes 0/8 = completed differs from classical
    // FOCE which uses arbitrary FORTRAN error numbers).
    const xmlResults = (payload.diagnostics && payload.diagnostics.xmlEstimationResults) || [];
    const xmlOpts = (payload.diagnostics && payload.diagnostics.xmlEstimationOptions) || [];
    const methodKinds = (payload.diagnostics && payload.diagnostics.xmlEstimationMethodKinds) || [];
    root.append(renderTrajectories(payload.trajectories, xmlResults, xmlOpts, methodKinds));
  }
  if (
    payload.diagnostics &&
    payload.diagnostics.xmlEstimationOptions &&
    payload.diagnostics.xmlEstimationOptions.length
  ) {
    // Exhaustive per-$EST option list from sibling .xml. Closed by default
    // (verbose). Three-tier classification: green = user-driven, blue =
    // non-default vs method's empirical baseline, normal = matches default.
    // .lst echo records (lstEstRecords) carry user-typed tokens for
    // NOABORT/NOHABORT distinction + invisible-to-XML options.
    const d = payload.diagnostics;
    const tiers = d.xmlEstimationTiers || [];
    const lstRecords = d.lstEstRecords || [];
    const methodKinds = d.xmlEstimationMethodKinds || [];
    root.append(renderEstimationOptions(d.xmlEstimationOptions, tiers, methodKinds, lstRecords, d.lstTolerances, !!d.hasOde, !!d.hasLevel));
  }
  if (payload.diagnostics && payload.diagnostics.xmlCovarianceOptions) {
    // $COV options from `<nm:problem_options>`'s `cov_*` attrs. Single
    // block (one $COV per problem). Four-tier: green = user-driven,
    // yellow = propagated (`-1` cross-referenced against $EST being
    // non-default), blue = non-default, normal = default. NM 7.6.0
    // doesn't emit a dedicated covariance_options element — empirically
    // confirmed.
    const d = payload.diagnostics;
    root.append(renderCovarianceOptions(
      d.xmlCovarianceOptions,
      d.xmlCovarianceTiers || {},
      d.xmlCovarianceResolved || {},
      d.lstTolerances,
      d.lstCovRecord,
      !!d.hasOde,
    ));
  }
  // (V1 tier classifier `classifyCovKeys` was retired in v0.0.190 —
  // `xmlCovarianceTiers` now carries the unified explicit/explicitDefault/
  // implicit tier map produced by `classifyCovStep`.)
  if (payload.diagnostics && payload.diagnostics.etabar.length) {
    // Per-ETA ETABAR / SE / N / P VAL table. Shrinkage already lives in
    // OMEGA's column; ETABAR ≠ 0 is the new info here (small p-value =
    // structural model mis-specification or omitted-covariate suspect).
    const d = payload.diagnostics;
    root.append(renderEtabarTable(d.etabar, d.etabarSe, d.etaN, d.etaPVal));
  }
  if (!rendered && !payload.summary && !payload.runNotes) {
    root.append(emptyMessage('Model has no parameter declarations.'));
  }
}

/**
 * Build the inline toggle (if any) for a given section. Returns an
 * HTMLElement that gets appended into the section's <h3> heading, or
 * null when no toggle applies. The √Ω/ρ toggle on Omega also drives
 * the Sigma display via shared `prefs.sqrtOm` state — Sigma is
 * conventionally read with the same SD-scale convention; one control
 * for the pair avoids redundancy.
 */
function sectionHeadingToggle(kind) {
  if (kind === 'theta') {
    return toggleEl(
      'expTh',
      'exp(θ)',
      'Exponentiate THETA estimates (useful when THETA is on the log scale).',
    );
  }
  if (kind === 'omega') {
    return toggleEl(
      'sqrtOm',
      '√Ω / ρ',
      'sumo / xpose convention. Diagonals → SD = √variance; off-diagonals → correlation = cov(i,j) / √(var_i · var_j). Drives both Omega and Sigma display.',
    );
  }
  return null;
}

function toggleEl(key, labelText, tooltip) {
  const label = document.createElement('label');
  label.className = 'toggle';
  label.title = tooltip;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!prefs[key];
  cb.addEventListener('change', () => {
    prefs[key] = cb.checked;
    savePrefs();
    if (lastPayload) render(lastPayload);
  });
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(cb, span);
  return label;
}

function renderRunNotes(notes) {
  const div = document.createElement('div');
  div.className = 'section notes';
  const h = document.createElement('h3');
  h.textContent = 'Run Notes';
  div.append(h);
  const dl = document.createElement('dl');
  const add = (term, value) => {
    if (!value && value !== 0) return;
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = String(value);
    dl.append(dt, dd);
  };
  if (notes.basedOn !== null && notes.basedOn !== undefined) add('Based on', 'run ' + notes.basedOn);
  add('Label', notes.label);
  add('Description', notes.description);
  for (const t of notes.extra || []) add(t.name, t.body);
  div.append(dl);
  return div;
}

// `renderTrajectories`, `renderTrajectoryStep`, `renderSparklineCell`,
// `tuneGridColumns`, `renderSparkline` — moved to `trajectory-plot.js`
// (loaded before client.js). Same module model as the other sibling
// helpers: top-level globals, dual-mode `module.exports` for tests.


function renderDiagnostics(d) {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  const h = document.createElement('h3');
  h.textContent = 'Diagnostics';
  wrap.append(h);
  if (d.termination) {
    const line = document.createElement('div');
    line.className = 'diag-line';
    const tag = document.createElement('span');
    // Three states: SUCCESSFUL (green), TERMINATED (red), NOT_TESTED
    // (yellow — neutral; ITS / IMP completed but didn't claim a true
    // minimum). Verbatim phrase shows the user which one this is.
    tag.className =
      d.termination === 'SUCCESSFUL' ? 'ok' : d.termination === 'NOT_TESTED' ? 'fix' : 'term';
    tag.textContent = d.terminationPhrase || 'MINIMIZATION ' + d.termination;
    line.append(tag);
    wrap.append(line);
    if (d.terminationReason) {
      const reason = document.createElement('div');
      reason.className = 'diag-reason';
      reason.textContent = d.terminationReason;
      wrap.append(reason);
    }
    const tcLine = renderTerminationCodes(d.terminationCodes);
    if (tcLine) wrap.append(tcLine);
  }
  if (d.parameterNearBoundary) {
    // NONMEM's default-boundary-test fired. Authoritative .lst signal;
    // sumo also flags this in its status row but the banner is more
    // discoverable. Doesn't say which parameter inline — user should
    // look for the orange `.boundary` highlight on individual rows.
    const line = document.createElement('div');
    line.className = 'diag-line';
    const tag = document.createElement('span');
    tag.className = 'fix';
    tag.textContent = 'Parameter estimate is near its boundary';
    line.append(tag);
    wrap.append(line);
  }
  const omittedTypes = [];
  if (d.boundaryTestOmitted) {
    if (d.boundaryTestOmitted.theta) omittedTypes.push('THETA');
    if (d.boundaryTestOmitted.omega) omittedTypes.push('OMEGA');
    if (d.boundaryTestOmitted.sigma) omittedTypes.push('SIGMA');
  }
  if (omittedTypes.length) {
    // User disabled the boundary test via NOTHETABOUNDTEST etc — sumo's
    // "No parameter near boundary" status is meaningless for these.
    const line = document.createElement('div');
    line.className = 'diag-line';
    line.textContent =
      'Default boundary test omitted for: ' + omittedTypes.join(', ');
    wrap.append(line);
  }
  if (d.covMatrixSingular) {
    // Explicit banner: NONMEM's COV step couldn't invert the requested
    // matrix. Specific letter (R / S) so the user knows which one;
    // dump file name follows convention (.rmt vs .smt).
    const line = document.createElement('div');
    line.className = 'diag-line';
    const tag = document.createElement('span');
    tag.className = 'term';
    const dumpExt = d.covMatrixSingular === 'S' ? '.smt' : '.rmt';
    tag.textContent =
      d.covMatrixSingular + ' matrix algorithmically singular — no SEs (' +
      d.covMatrixSingular + ' written to ' + dumpExt + ')';
    line.append(tag);
    wrap.append(line);
  }
  // Eigenvalues + condition number on a single line — both signal the
  // same thing (COR-matrix conditioning) so they belong together. Cond
  // is threshold-coloured (warn > 100, bad > 1000); eigenvalues stay
  // plain so a negative min still reads cleanly. Either piece can be
  // missing; render the line if at least one is present.
  if (d.eigenvalues || typeof d.conditionNumber === 'number') {
    const line = document.createElement('div');
    line.className = 'diag-line';
    if (d.eigenvalues) {
      line.append(document.createTextNode(
        'Eigenvalues: min ' + fmtNum(d.eigenvalues.min) +
        ' · max ' + fmtNum(d.eigenvalues.max),
      ));
    }
    if (typeof d.conditionNumber === 'number') {
      const c = d.conditionNumber;
      const bad = thresholds.condNumberBadThreshold;
      const warn = thresholds.condNumberWarnThreshold;
      const kind = c > bad ? 'bad' : c > warn ? 'warn' : null;
      const tip = kind === 'bad'
        ? 'Cond > ' + bad + ' — COR matrix strongly ill-conditioned; suspect overparameterization.'
        : kind === 'warn'
          ? 'Cond > ' + warn + ' — ill-conditioned COR matrix; check for highly-correlated parameters.'
          : null;
      if (d.eigenvalues) line.append(document.createTextNode(' · '));
      line.append(metaPart('Condition number: ' + fmtNum(c), kind, tip));
    }
    wrap.append(line);
  }
  if (d.correlationRedFlags && d.correlationRedFlags.length) {
    // Pairwise parameter correlations from .cor with |r| ≥ threshold.
    // Surfaces fact only — colour reading is the user's job (combine
    // with cond > 1000 + high RSE% on the same params for the full
    // overparameterization picture). One row per pair, sorted by |r|
    // desc upstream. Diagonal + symmetric-twin already excluded.
    wrap.append(renderCorrelationRedFlags(d.correlationRedFlags));
  }
  // Hessian quality + final-gradient + parallel runtime — assembled from
  // .lst-only signals that sumo doesn't surface. Built once, joined by
  // ' · ', dropped entirely when nothing to show.
  const qualityParts = [];
  if (d.finalGradient && d.finalGradient.length) {
    const maxAbs = d.finalGradient.reduce(
      (m, v) => (typeof v === 'number' && Math.abs(v) > m ? Math.abs(v) : m),
      0,
    );
    qualityParts.push('max |grad| ' + fmtNum(maxAbs));
  }
  if (d.hessianResets > 0) qualityParts.push('Hessian reset ' + d.hessianResets + '×');
  if (typeof d.diagonalShift === 'number')
    qualityParts.push('diagonal shift ' + fmtNum(d.diagonalShift));
  if (typeof d.cput === 'number') qualityParts.push('CPU ' + fmtNum(d.cput) + 's');
  if (typeof d.paraNodes === 'number' && d.paraNodes > 1)
    qualityParts.push(d.paraNodes + ' nodes');
  if (qualityParts.length) {
    const line = document.createElement('div');
    line.className = 'diag-line';
    line.textContent = qualityParts.join(' · ');
    wrap.append(line);
  }
  if (d.fmsg) {
    // FMSG may contain NMTRAN parse errors (red banner) or just info
    // (folded yellow block). Errors get a prominent always-visible
    // banner above the foldable content; info-only just folds quietly.
    if (d.fmsg.hasErrors) {
      const line = document.createElement('div');
      line.className = 'diag-line';
      const tag = document.createElement('span');
      tag.className = 'term';
      tag.textContent = 'NMTRAN parse error — model failed to compile (FMSG)';
      line.append(tag);
      wrap.append(line);
    }
    wrap.append(renderFmsg(d.fmsg));
  }
  if (d.prderr) {
    wrap.append(renderPrderr(d.prderr));
  }
  return wrap;
}

function renderFmsg(fmsg) {
  const details = document.createElement('details');
  details.className = 'prderr';
  // Auto-expand when there's an actual error — invisible-folded banners
  // would defeat the point of surfacing the parse error.
  if (fmsg.hasErrors) details.open = true;
  const summary = document.createElement('summary');
  const lines = fmsg.content.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  const sourceTag = fmsg.source === 'archive' ? ' from NM_run1.7z' : '';
  const label = fmsg.hasErrors ? 'FMSG — NMTRAN errors' : 'FMSG — NMTRAN messages';
  summary.textContent = label + ' (' + lines + ' line' + (lines === 1 ? '' : 's') + sourceTag + ')';
  details.append(summary);
  const pre = document.createElement('pre');
  pre.textContent = fmsg.content;
  details.append(pre);
  return details;
}

function renderPrderr(prderr) {
  const details = document.createElement('details');
  details.className = 'prderr';
  const summary = document.createElement('summary');
  const lines = prderr.content.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  const sourceTag = prderr.source === 'archive' ? ' from NM_run1.7z' : '';
  summary.textContent = 'PRDERR — NONMEM warnings (' + lines + ' line' + (lines === 1 ? '' : 's') + sourceTag + ')';
  details.append(summary);
  const pre = document.createElement('pre');
  pre.textContent = prderr.content;
  details.append(pre);
  return details;
}

/**
 * Render an ETA / EPS shrinkage table. ETA includes the ETABAR
 * column + P VAL. (NONMEM's ETABAR ≠ 0 significance test); EPS does
 * not (no shrinkage-of-EPS test in NONMEM). When `etabar` is omitted
 * the table collapses to `Name | Shrinkage (SD)`.
 *
 * Small p-value (< 0.05) flags an ETA whose mean differs from zero
 * — typically a structural model mis-specification or omitted
 * covariate. Highlighted red so the user spots it immediately.
 */
/**
 * Termination codes from `.ext` row `-1000000007`. Per Bauer's NM7
 * docs the row is "termination status (first item) followed by
 * termination codes" — typically a leading FORTRAN error code (e.g.
 * 134 = ROUNDING ERRORS, mirrored in the `terminationReason` text)
 * followed by supplementary status codes, with a long zero-padded
 * tail matching the .ext column count. We:
 *   - filter out the zeros (always-noise placeholders)
 *   - render only when at least one non-zero code remains
 *   - skip per-code labels — Bauer doesn't document a stable mapping,
 *     and our earlier 0-7 EM-method mapping mis-labelled FORTRAN
 *     codes like 134 / 50 / 54 as "cov failure"
 * The first non-zero code typically matches the `(ERROR=N)` parenthetical
 * in `terminationReason` already shown above; trailing non-zero codes
 * are supplementary info not surfaced elsewhere.
 */
/**
 * Pairwise correlation red-flag table. One row per `{a, b, r}` flag.
 * No editorialising — heading carries the threshold (`|r| ≥ X`) so the
 * user knows what filter is applied; rest is data. The user combines
 * this with `cond` (meta-line, threshold-coloured) and per-row RSE
 * (parameter tables) to read overparameterization themselves.
 */
/**
 * Per-`$EST`-step option dump from sibling `.xml`. Outer collapsible
 * groups all steps; inner per-step collapsibles hold a 2-column
 * table (option, value). Keys come straight from the `nm:` attribute
 * names (already prefix-stripped upstream); values are strings as
 * NONMEM emitted them — no type coercion, so the user sees the
 * verbatim wire format.
 */
function renderEstimationOptions(steps, tiersPerStep, methodKindsPerStep, lstEstRecords, lstTolerances, hasOde, hasLevel) {
  const outer = document.createElement('details');
  outer.className = 'xml-options';
  const sumOuter = document.createElement('summary');
  sumOuter.textContent = '$EST options (XML, exhaustive — '
    + steps.length + (steps.length === 1 ? ' step)' : ' steps)');
  outer.append(sumOuter);
  for (let i = 0; i < steps.length; i++) {
    const tiers = (tiersPerStep && tiersPerStep[i]) || {};
    // methodKind comes from the payload (single source of truth in
    // xml-est-defaults.ts:deriveMethodKind). Defaults to 'fo' for
    // older payloads / when undefined.
    const methodKind = (methodKindsPerStep && methodKindsPerStep[i]) || 'fo';
    const lstRecord = (lstEstRecords && lstEstRecords[i]) || null;
    outer.append(renderEstimationOptionsStep(steps[i], i + 1, tiers, methodKind, lstRecord, lstTolerances, hasOde, hasLevel));
  }
  return outer;
}

// `INVISIBLE_TOKEN_PATTERNS`, `isInvisibleToken`, `INVISIBLE_ATTR_DEFS`,
// `INVISIBLE_ATTR_DEFAULTS`, `INVISIBLE_ATTR_PATTERNS`,
// `attrAppliesToContext`, `synthesizeFromTokens`, `extractValue`,
// `synthesizeInvisibleAttrs`, `resolveEstAttrFromLst`,
// `resolveCovAttrFromLst` — all moved to `xml-invisible-attrs.js`
// (loaded before client.js). Same module model as formatters.js /
// transforms.js: top-level globals, dual-mode `module.exports` for tests.

function renderEstimationOptionsStep(step, stepNum, tierMap, methodKind, lstRecord, lstTolerances, hasOde, hasLevel) {
  const inner = document.createElement('details');
  inner.className = 'xml-options-step';
  const sumInner = document.createElement('summary');
  const method = step.estimation_method
    ? step.estimation_method.toUpperCase()
    : 'Step ' + stepNum;
  // Use the merged-attr count below (after synthesizeInvisibleAttrs)
  // so the header reflects the actual rendered row count.
  inner.append(sumInner);

  // The user's verbatim $EST tokens (from .lst echo) — used to distinguish
  // NOABORT vs NOHABORT (XML conflates both into abort='no') and to surface
  // tokens NM never emits to XML (PRINT, POSTHOC, etc.).
  const userTokens = lstRecord && lstRecord.tokens ? lstRecord.tokens : [];
  const userWroteNoabort = userTokens.some((t) => /^NOABORT$/i.test(t));
  const userWroteNohabort = userTokens.some((t) => /^NOHABORT$/i.test(t));
  const tolerances = lstTolerances || null;

  // Synthesize doc-defaulted invisible attrs into the merged option
  // set. Method-aware: NUMERICAL/CENTERING skipped for inapplicable
  // methods unless user explicitly typed them. Effective view =
  // XML attrs ∪ synthesised. methodKind comes from payload.
  // Compute `merged` (XML attrs minus filtered atol) BEFORE synthesis
  // so `existingKeys` correctly suppresses synthetic entries for any
  // XML-emitted attr — matches the $COV path's contract.
  const userWroteAtol = userTokens.some((t) => /^ATOL=/i.test(t));
  const merged = { ...step };
  // Filter ATOL from XML when ODE is not used AND user didn't type it.
  // NM always emits atol='0' even for non-ODE models, but the value is
  // irrelevant. Hide rather than mislead.
  if (!hasOde && !userWroteAtol && merged.atol === '0') {
    delete merged.atol;
  }
  const synthetic = synthesizeInvisibleAttrs(
    userTokens,
    methodKind,
    !!hasLevel,
    new Set(Object.keys(merged)),
  );
  for (const k of Object.keys(synthetic)) {
    merged[k] = synthetic[k].value;
  }
  const count = Object.keys(merged).length;
  sumInner.textContent = 'Step ' + stepNum + ': ' + method
    + ' (' + count + ' attributes)';

  const table = document.createElement('table');
  table.className = 'xml-options-table';
  const keys = Object.keys(merged).sort();
  for (const k of keys) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'xml-options-key';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    const { cls, tip, displayValue } = buildEstAttrCell({
      k,
      merged,
      synthetic,
      tierMap,
      methodKind,
      userWroteNoabort,
      userWroteNohabort,
      tolerances,
    });
    tdV.className = cls;
    tdV.textContent = fmtXmlOptionValue(displayValue);
    if (tip) tdV.title = tip;
    tr.append(tdK, tdV);
    table.append(tr);
  }
  inner.append(table);

  // Surface invisible-to-XML tokens (PRINT, POSTHOC, CENTERING,
  // ETABARCHECK, NOSORT) the user typed. The XML can't carry them, so
  // without the .lst echo the inspector would simply not show them.
  const invisibleTokens = userTokens.filter(isInvisibleToken);
  if (invisibleTokens.length > 0) {
    const note = document.createElement('div');
    note.className = 'xml-options-invisible';
    note.title =
      'These options are user-typed in $ESTIMATION but NEVER appear in ' +
      'NONMEM\'s XML output (empirically verified, NM 7.6.0). ' +
      'Surfaced from the .lst control-stream echo.';
    const label = document.createElement('span');
    label.className = 'xml-options-invisible-label';
    label.textContent = 'Also typed (invisible to XML):';
    note.append(label);
    for (const t of invisibleTokens) {
      const tag = document.createElement('span');
      tag.className = 'xml-options-invisible-tag';
      tag.textContent = t;
      note.append(' ', tag);
    }
    inner.append(note);
  }
  return inner;
}

/**
 * Tier-tip wording per scope ($EST vs $COV). Shared by `buildEstAttrCell`
 * and `buildCovAttrCell` via `classifyAttrTier`. Tier values are
 * computed payload-side (unified 3-tier scheme: explicit /
 * explicitDefault / implicit).
 *
 * Per-`$COV`-record option dump comes from sibling `.xml`'s
 * `<nm:problem_options>` element's `cov_*` attrs. NM 7.6.0 does NOT
 * emit a dedicated `<nm:covariance_options>` element — empirically
 * confirmed by probing on host. Single-block (one $COV per problem),
 * not per-step like $EST.
 */
const TIER_TIPS = {
  est: {
    explicit: 'Explicitly set on this $EST line (.lst echo).',
    explicitDefault:
      'Explicitly set on this $EST line, but the value matches the method default — has no effect vs. omitting it.',
    implicit:
      'Implicitly set — value differs from default, but the user did NOT type it on this $EST line. Set by AUTO=N\'s per-method overrides or propagated from a prior $EST step.',
    synthUserPrefix:
      'User-typed (NM never emits this to XML; synthesized from .lst echo). Default per Bauer: ',
    synthDoc: 'Documented default per Bauer (NM never emits this to XML). Synthesized for visibility.',
  },
  cov: {
    explicit: 'Explicitly set on the $COV line (.lst echo).',
    explicitDefault:
      'Explicitly set on the $COV line, but value matches the default — no effect vs. omitting it.',
    implicit:
      'Implicitly set — value differs from default, but the user did NOT type it on the $COV line. Likely inherited from $EST or set by method-default (e.g. cov_posdef=3 for EM).',
    synthUserPrefix:
      'User-typed on $COV (NM didn\'t emit this to XML for this run; synthesized from .lst echo). Default per Bauer: ',
    synthDoc:
      'Documented default per Bauer (NM didn\'t emit this to XML). Synthesized for visibility.',
  },
};

/**
 * Classify a single attr cell — returns `{cls, tip}` based on whether
 * the attr was synthesised (additive overlay from .lst tokens) vs
 * present in XML (with a payload-side `tierMap[k]` of
 * `explicit` / `explicitDefault` / `implicit`).
 *
 * Doesn't apply special-case decorations — callers decorate on top
 * (NOABORT/NOHABORT, wire-vs-runtime, PsN-wrapper, MATRIX=R quirks).
 */
/**
 * Append `addition` to a tooltip string, handling the case where
 * `existing` is undefined (no tier matched + no synth entry — see
 * `classifyAttrTier`). Otherwise `tip += addition` would yield
 * "undefined …" as the prefix. Used by the $EST / $COV attr-cell
 * decorations that layer extra context on top of the base tier tip.
 */
function appendTip(existing, addition) {
  return (existing || '') + addition;
}

function classifyAttrTier(k, synthEntry, tierMap, docDefaultMap, scope) {
  const tips = TIER_TIPS[scope];
  let cls = 'xml-options-val';
  let tip;
  if (synthEntry !== undefined) {
    if (synthEntry.isUserSet) {
      const matchesDocDefault = synthEntry.value === docDefaultMap[k];
      cls += matchesDocDefault
        ? ' xml-options-val--explicit-default'
        : ' xml-options-val--explicit';
      tip = tips.synthUserPrefix + docDefaultMap[k] + (matchesDocDefault ? ' — matches default.' : '.');
    } else {
      tip = tips.synthDoc;
    }
    return { cls, tip };
  }
  const tier = tierMap && tierMap[k];
  if (tier === 'explicit') {
    cls += ' xml-options-val--explicit';
    tip = tips.explicit;
  } else if (tier === 'explicitDefault') {
    cls += ' xml-options-val--explicit-default';
    tip = tips.explicitDefault;
  } else if (tier === 'implicit') {
    cls += ' xml-options-val--implicit';
    tip = tips.implicit;
  }
  return { cls, tip };
}

/**
 * Build the `{cls, tip, displayValue}` for one $EST attr cell. Wraps
 * `classifyAttrTier` with $EST-specific decorations: method-applicability
 * warning for synthesised invisible attrs, NOABORT/NOHABORT
 * disambiguation, wire→runtime translation for sentinel values, and
 * the PsN-wrapper `FILE=psn.ext` annotation.
 */
function buildEstAttrCell(ctx) {
  const { k, merged, synthetic, tierMap, methodKind, userWroteNoabort, userWroteNohabort, tolerances } = ctx;
  const synthEntry = synthetic[k];
  let { cls, tip } = classifyAttrTier(k, synthEntry, tierMap, INVISIBLE_ATTR_DEFAULTS, 'est');

  // Synthesised user-set attrs: append method-applicability warning if
  // the attr doesn't apply to the current method.
  if (synthEntry !== undefined && synthEntry.isUserSet && synthEntry.inapplicable) {
    const applicableTo = INVISIBLE_ATTR_DEFS[k].applicable;
    if (k === 'posthoc') {
      tip += ' WARNING: POSTHOC/NOPOSTHOC only meaningfully apply to METHOD=ZERO (FO) or to MAXEVAL=0 evaluation runs. Empirically verified: other methods compute posthoc etas implicitly regardless of the option, NM 7.6.0.';
    } else {
      const allowedStr = Array.isArray(applicableTo)
        ? applicableTo.map((x) => x.toUpperCase()).join('/')
        : String(applicableTo).toUpperCase();
      tip += ' WARNING: this option only applies to ' + allowedStr + ' methods; the current step uses ' + methodKind.toUpperCase() + '. NM silently ignores it.';
    }
  }

  // Special-case `abort='no'`: XML conflates NOABORT/NOHABORT — the
  // .lst echo lets us disambiguate when the user typed either.
  if (k === 'abort' && merged[k] === 'no') {
    if (userWroteNohabort) {
      tip = 'NOHABORT: positive definite correction at all levels of the estimation. More aggressive than NOABORT — can hide ill-posed problems. (XML wire: abort=\'no\' — same as NOABORT)';
    } else if (userWroteNoabort) {
      tip = 'NOABORT: theta-recovery + force most non-PD Hessian matrices to be PD. (XML wire: abort=\'no\' — same as NOHABORT)';
    } else {
      tip = appendTip(tip, ' (XML wire abort=\'no\' is shared by NOABORT and NOHABORT; .lst echo absent — can\'t disambiguate.)');
    }
  }

  // Wire→runtime translation. ATOL='0' is a sentinel — display the
  // resolved runtime ANRD from the .lst trace as the cell value;
  // tooltip preserves the wire format for transparency.
  let displayValue = merged[k];
  const resolved = resolveEstAttrFromLst(k, merged[k], tolerances);
  if (resolved && resolved !== merged[k]) {
    displayValue = resolved;
    tip = appendTip(tip, ' (XML wire: \'' + merged[k] + '\' — sentinel for the built-in default; effective runtime value ' + resolved + ' from .lst trace.)');
  }

  // PsN-wrapper detection on `file` attr: PsN's execute rewrites
  // FILE= to psn.ext in the wrapped control stream. Annotate ONLY
  // when the user did NOT explicitly type it (tier === 'implicit')
  // — a user who genuinely typed FILE=psn.ext (unusual but valid)
  // shouldn't see the wrapper note.
  if (k === 'file' && /^psn\.ext$/i.test(merged[k]) && tierMap[k] === 'implicit') {
    tip = appendTip(tip, ' (PsN\'s execute wrapper rewrites the FILE= option to psn.ext in the wrapped control stream — not the modeller\'s choice.)');
  }

  return { cls, tip, displayValue };
}

/**
 * Build the `{cls, tip, displayValue}` for one $COV attr cell. Wraps
 * `classifyAttrTier` with $COV-specific decorations: the MATRIX=R +
 * SPECIAL quirk warning and the wire→runtime translation. No NOABORT
 * / PsN-wrapper analogue — $COV doesn't have those special cases.
 */
function buildCovAttrCell(ctx) {
  const { k, merged, synthetic, tiersMap, resolvedMap, lstTolerances, matrixIsR } = ctx;
  const synthEntry = synthetic[k];
  let { cls, tip } = classifyAttrTier(k, synthEntry, tiersMap, INVISIBLE_COV_DEFAULTS, 'cov');

  // MATRIX=R + SPECIAL quirk: NM silently suppresses SPECIAL when
  // MATRIX=R is in effect. The user typed it; NM ignored it. The
  // `appendTip` helper handles the undefined-tip case (no tier hit
  // + no synth match) so raw `+=` can't yield "undefined …" prefix.
  if (synthEntry !== undefined && synthEntry.isUserSet && k === 'special' && matrixIsR) {
    tip = appendTip(tip, ' WARNING: NM silently ignores SPECIAL when MATRIX=R is used (empirically verified, NM 7.6.0; Bauer\'s docs warn against this combination). Setting has no effect.');
  }

  // Wire→runtime translation (sentinel values → resolved).
  let displayValue = merged[k];
  const resolved = resolvedMap[k] || resolveCovAttrFromLst(k, merged[k], lstTolerances);
  if (resolved && resolved !== merged[k]) {
    displayValue = resolved;
    tip = appendTip(tip, ' (XML wire: \'' + merged[k] + '\' — sentinel; effective runtime value ' + resolved + ' — inherited from $EST / $SUBROUTINES / method default.)');
  }

  return { cls, tip, displayValue };
}

// `INVISIBLE_COV_DEFAULTS`, `INVISIBLE_COV_PATTERNS`,
// `synthesizeInvisibleCovAttrs` — moved to `xml-invisible-attrs.js`.

function renderCovarianceOptions(opts, tiersMap, resolvedMap, lstTolerances, lstCovRecord, hasOde) {
  const outer = document.createElement('details');
  outer.className = 'xml-options';
  const sumOuter = document.createElement('summary');

  // Filter cov_atol/cov_tol when ODE not used AND user didn't type them
  // on $COV. NM emits cov_atol='-1' regardless; for non-ODE models the
  // value is irrelevant.
  const covTokens = lstCovRecord && lstCovRecord.tokens ? lstCovRecord.tokens : [];
  const userWroteAtolCov = covTokens.some((t) => /^ATOL=/i.test(t));
  const userWroteTolCov = covTokens.some((t) => /^TOL=/i.test(t));
  const merged = { ...opts };
  if (!hasOde && !userWroteAtolCov && merged.atol === '-1') delete merged.atol;
  if (!hasOde && !userWroteTolCov && merged.tol === '-1') delete merged.tol;
  // Synthesize invisible $COV options. Additive-by-construction —
  // synthesizeInvisibleCovAttrs only returns entries for keys not
  // already in `merged`, so the synthetic-tier branch in the loop
  // below is unambiguous (`synthEntry !== undefined` iff XML lacked
  // the key, e.g. cov_special when MATRIX=R suppresses it).
  const synthetic = synthesizeInvisibleCovAttrs(covTokens, new Set(Object.keys(merged)));
  for (const k of Object.keys(synthetic)) {
    merged[k] = synthetic[k].value;
  }
  const matrixIsR = merged.matrix === 'r';
  const count = Object.keys(merged).length;
  sumOuter.textContent = '$COV options (XML, exhaustive — ' + count + ' attributes)';
  outer.append(sumOuter);

  const table = document.createElement('table');
  table.className = 'xml-options-table';
  const keys = Object.keys(merged).sort();
  for (const k of keys) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'xml-options-key';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    const { cls, tip, displayValue } = buildCovAttrCell({
      k,
      merged,
      synthetic,
      tiersMap,
      resolvedMap,
      lstTolerances,
      matrixIsR,
    });
    tdV.className = cls;
    tdV.textContent = fmtXmlOptionValue(displayValue);
    if (tip) tdV.title = tip;
    tr.append(tdK, tdV);
    table.append(tr);
  }
  outer.append(table);
  return outer;
}

function renderCorrelationRedFlags(flags) {
  const wrap = document.createElement('div');
  wrap.className = 'diag-correlations';
  const heading = document.createElement('div');
  heading.className = 'diag-correlations-heading';
  // Threshold echoed from the first flag's |r| floor would be wrong
  // (flag values are above threshold); we just say "highly-correlated"
  // and let the workspace setting be the authoritative source.
  heading.textContent =
    'Highly-correlated parameter pairs (' + flags.length + ')';
  wrap.append(heading);
  const table = document.createElement('table');
  table.className = 'diag-corr-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of ['parameter A', 'parameter B', 'r']) {
    const th = document.createElement('th');
    th.textContent = h;
    if (h === 'r') {
      // Right-align so the numeric column heads sit above their values;
      // hover tooltip identifies the quantity for users new to .cor.
      th.className = 'diag-corr-r-header';
      th.title =
        'Pearson correlation coefficient (r) between the two parameter ' +
        'estimates from NONMEM’s .cor (correlation matrix of estimate). ' +
        'Sign preserved — strong negative is as diagnostic as strong positive.';
    }
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const f of flags) {
    const tr = document.createElement('tr');
    const ta = document.createElement('td');
    ta.textContent = f.a;
    const tb = document.createElement('td');
    tb.textContent = f.b;
    const tr_ = document.createElement('td');
    // Tier-coloured cell (warn=yellow, bad=red) matching the inspector's
    // wider warn/bad vocabulary. The kind comes from the payload-side
    // classifier so the client doesn't reapply thresholds.
    tr_.className = 'diag-corr-r diag-corr-r-' + (f.kind || 'bad');
    // Sign preserved — both strong positive and negative are diagnostic.
    tr_.textContent = (f.r > 0 ? '+' : '') + f.r.toFixed(3);
    tr.append(ta, tb, tr_);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function renderTerminationCodes(codes) {
  if (!codes || codes.length === 0) return null;
  const nonZero = codes.filter((c) => c !== 0);
  if (nonZero.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'diag-line';
  const prefix = document.createElement('span');
  prefix.className = 'dim';
  prefix.textContent = nonZero.length === 1 ? 'Termination code: ' : 'Termination codes: ';
  prefix.title =
    'Non-zero values from .ext row -1000000007. The first code is typically a ' +
    'FORTRAN-runtime (ERROR=N) value (e.g. 134 = rounding errors); subsequent ' +
    'codes are line indices into NONMEM\'s TEXTMSGS.f90 message table that ' +
    'compose the verbatim termination phrase shown above.';
  wrap.append(prefix);
  nonZero.forEach((c, i) => {
    if (i > 0) wrap.append(document.createTextNode(', '));
    const span = document.createElement('span');
    span.className = 'term';
    // Empirical mapping from `/opt/nm760/source/TEXTMSGS.f90` — when known,
    // append a short label so the user doesn't need to cross-reference the
    // verbatim phrase. Unknowns render bare.
    const label = textmsgsCodeLabel(c);
    span.textContent = label ? c + ' (' + label + ')' : String(c);
    wrap.append(span);
  });
  return wrap;
}

function renderEtabarTable(etabar, etabarSe, etaN, pVal) {
  const n = Math.max(
    etabar.length,
    etabarSe ? etabarSe.length : 0,
    etaN ? etaN.length : 0,
    pVal ? pVal.length : 0,
  );
  const wrap = document.createElement('div');
  wrap.className = 'section';
  // Top-level h3 to match THETA/OMEGA/SIGMA section styling now that
  // ETA is rendered as a peer section, not nested under Diagnostics.
  const h = document.createElement('h3');
  h.textContent = 'ETA';
  wrap.append(h);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      'ETA(' + (i + 1) + ')',
      etabar[i] ?? null,
      etabarSe && etabarSe[i] !== undefined ? etabarSe[i] : null,
      etaN && etaN[i] !== undefined ? etaN[i] : null,
      fmtPVal(pVal && pVal[i]),
    ]);
  }
  wrap.append(sectionEl('', ['Name', 'ETABAR', 'SE', 'N', 'P VAL.'], rows, []));
  return wrap;
}

function anyFinal(rows) {
  return rows.some((r) => r.final !== null && r.final !== undefined);
}

/**
 * Does ANY chained $EST step have a `-eval` method-short suffix
 * (`MAXEVAL=0`)? Drives the OFV headline's "(at init)" suffix AND the
 * summary header's EVAL ONLY pill — same rule, same answer; previously
 * inlined twice and went out-of-sync once already (v0.0.194 fix).
 * Reads both `lst.methodsShort` (array, chained $EST) and the scalar
 * `lst.methodShort` (last-step only) so older payloads still light up.
 */
function isAnyEvalStep(lst) {
  if (!lst) return false;
  const arr = Array.isArray(lst.methodsShort) ? lst.methodsShort : [];
  if (arr.some((m) => typeof m === 'string' && m.endsWith('-eval'))) return true;
  return typeof lst.methodShort === 'string' && lst.methodShort.endsWith('-eval');
}

function emptyMessage(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function renderSummary(s) {
  const div = document.createElement('div');
  div.className = 'summary';
  const top = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = s.title;
  top.append(title);
  // Method badges: one per `$EST` record in chain order. `methodsShort`
  // is the new (M13-A polish) array; for older fixtures / runs without
  // it, fall back to the back-compat scalar `methodShort`.
  const methodsShort = (s.lst && s.lst.methodsShort && s.lst.methodsShort.length)
    ? s.lst.methodsShort
    : (s.lst && s.lst.methodShort ? [s.lst.methodShort] : []);
  const methodsLong = (s.lst && s.lst.methods && s.lst.methods.length)
    ? s.lst.methods
    : (s.lst && s.lst.method ? [s.lst.method] : []);
  for (let i = 0; i < methodsShort.length; i++) {
    const tag = document.createElement('span');
    tag.className = 'method';
    tag.textContent = methodsShort[i];
    if (methodsLong[i]) tag.title = methodsLong[i];
    top.append(tag);
  }
  // Evaluation-only signal: NONMEM's `MAXEVAL=0` runs the model without
  // iterating ($EST step omitted) — FE values equal initial estimates,
  // no SE / RSE / shrinkage / termination diagnostics. The method badge
  // already gets a `-eval` suffix (e.g. `FO-eval`); this complementary
  // pill makes the special status unmissable for users skimming the
  // inspector. Shares the `isAnyEvalStep` helper with the OFV-headline
  // path (v0.0.194 fix) so the two surfaces can't drift.
  if (isAnyEvalStep(s.lst)) {
    const evalTag = document.createElement('span');
    evalTag.className = 'method method-eval';
    evalTag.textContent = 'EVAL ONLY';
    evalTag.title =
      'MAXEVAL=0 — NONMEM evaluated the model at the initial estimates without iterating. ' +
      'FE = initial values, no SE / RSE / shrinkage / termination diagnostics. ' +
      'Useful for sanity-checking model setup; not a fitted result.';
    top.append(evalTag);
  }
  // COV-method badge — sits next to the estimation-method badge so all
  // RSE columns inherit a single visible source attribution rather than
  // repeating the suffix in every section's column header.
  const covBadge = covMethodBadge(s.lst);
  if (covBadge) top.append(covBadge);
  // OFV moved out of the summary line — now a prominent block above
  // the THETA table (rendered in render()). Avoid duplicating it here.
  const meta = metaLine(s.sumo, s.lst, s.cnvVerdict);
  if (meta) top.append(meta);
  div.append(top);
  if (s.sumo && s.sumo.statuses && s.sumo.statuses.length) {
    div.append(renderStatuses(s.sumo.statuses));
  }
  return div;
}

/**
 * Build the comma-separated meta line for the inspector summary header.
 * Returns a `<span class="meta">` containing mixed plain text + threshold-
 * coloured sub-spans (or null when there's nothing to show).
 *
 * Run-level scalars only: runtime, EM-convergence verdict (.cnv-derived),
 * acceptance rate, obs count, subj count. cond moved to diagnostics
 * (eigenvalue line); sig-digits moved to the OFV headline.
 */
function metaLine(sumo, lst, cnvVerdict) {
  // Collect parts then join — same style as `qualityParts` elsewhere
  // in this file. Avoids the closure-over-mutable-flag pattern.
  const parts = [];
  if (sumo && sumo.totalRuntime) {
    let s = 'runtime ' + sumo.totalRuntime;
    if (typeof sumo.estimationSeconds === 'number') s += ' (est ' + fmtNum(sumo.estimationSeconds) + 's)';
    parts.push(document.createTextNode(s));
  }
  // sig-digits moved to OFV headline (info-about-the-result, co-located
  // with the result). cond moved to diagnostics (alongside eigenvalues +
  // correlation red flags). Meta line keeps only run-level scalars.
  // EM/MCMC convergence verdict from `.cnv` (NM 7.2+ with `$EST CTYPE>0`).
  // Pill is gated on the verdict object existing, so FOCE / no-CTYPE
  // runs (no `.cnv` written) skip this line entirely.
  if (cnvVerdict) {
    const v = cnvVerdict;
    const kind = v.converged ? 'good' : 'bad';
    const ofvCmp = v.ofvP >= v.ofvAlpha ? '≥' : '<';
    let label = v.converged ? 'EM converged' : 'EM NOT converged';
    label += ' (OFV p=' + fmtNum(v.ofvP) + ' ' + ofvCmp + ' α=' + fmtNum(v.ofvAlpha);
    if (v.paramTotal > 0) {
      label += ', ' + v.paramConverged + '/' + v.paramTotal + ' params converged';
    }
    label += ')';
    const tip = v.nonConvergedParams.length > 0
      ? 'Params still drifting at termination: ' + v.nonConvergedParams.join(', ')
        + '. Linear-regression slope-vs-zero p < α (Bonferroni-corrected per parameter; OFV α uncorrected).'
      : v.converged
        ? 'All tested parameters and the OFV have stable slopes (p ≥ α) over the last CITER iterations.'
        : 'OFV slope unstable (p < α). Per-parameter slopes ok.';
    parts.push(metaPart(label, kind, tip));
  }
  // SAEM / BAYES: stationary acceptance rate. No threshold-coloring —
  // healthy range varies by sampler. Surface as plain text.
  if (lst && typeof lst.acceptanceRate === 'number') {
    parts.push(document.createTextNode('accept ' + fmtNum(lst.acceptanceRate)));
  }
  if (sumo && typeof sumo.observations === 'number') {
    parts.push(document.createTextNode(sumo.observations + ' obs'));
  }
  if (sumo && typeof sumo.individuals === 'number') {
    parts.push(document.createTextNode(sumo.individuals + ' subj'));
  }
  if (parts.length === 0) return null;
  const wrap = document.createElement('span');
  wrap.className = 'meta';
  parts.forEach((p, i) => {
    wrap.append(i === 0 ? '· ' : ' · ');
    wrap.append(p);
  });
  return wrap;
}

/**
 * Build one meta-line part — plain text (no kind) or coloured span
 * (warn/bad). `tip` adds a native title attribute for hover detail.
 */
function metaPart(text, kind, tip) {
  if (!kind) return document.createTextNode(text);
  const span = document.createElement('span');
  span.className = 'meta-' + kind;
  span.textContent = text;
  if (tip) span.title = tip;
  return span;
}

/**
 * Big-text OFV line rendered above the THETA table when a fit is loaded.
 * Replaces the small inline `OFV = X` slot in the summary header so the
 * headline number a modeller checks first is visually unmissable.
 */
function renderOfvHeadline(ofv, isEval, sigDigits, nsigRequired) {
  const div = document.createElement('div');
  div.className = 'ofv-headline';
  const label = document.createElement('span');
  label.className = 'ofv-label';
  // For MAXEVAL=0 runs, append `(at init)` so the user reads the
  // value as evaluation-at-init rather than fitted-OFV. Tooltipped
  // with the same explanation as the EVAL-ONLY badge.
  label.textContent = isEval ? 'OFV (at init)' : 'OFV';
  if (isEval) {
    label.title =
      'Evaluation-only run (MAXEVAL=0) — OFV is computed at the initial parameter estimates, not minimized.';
  }
  const value = document.createElement('span');
  value.className = 'ofv-value';
  value.textContent = fmtNum(ofv);
  div.append(label, value);
  // sig-digits as a small adjacent stat — info about the precision
  // of the OFV/parameter values, co-located with the value itself.
  // Threshold-coloured red when the user's $EST NSIG= target wasn't met.
  if (typeof sigDigits === 'number') {
    const sep = document.createElement('span');
    sep.className = 'ofv-sep';
    sep.textContent = '·';
    div.append(sep);
    const kind = typeof nsigRequired === 'number' && sigDigits < nsigRequired ? 'bad' : null;
    const tip = kind === 'bad'
      ? 'Below the $EST NSIG=' + nsigRequired + ' target — final estimates didn\'t reach the user\'s precision bar.'
      : null;
    const sd = document.createElement('span');
    sd.className = 'ofv-sigdigits' + (kind ? ' meta-' + kind : '');
    sd.textContent = 'sig-digits ' + fmtNum(sigDigits);
    if (tip) sd.title = tip;
    div.append(sd);
  }
  return div;
}

/**
 * Build a single badge summarising the COV-step's SE source — the label
 * that drives every RSE column. Replaces per-column suffixes (which
 * duplicated the same info three times). Tooltipped with the longer
 * explanation so the user can hover for context.
 *   - parenthetical from .lst (e.g. `(RSR)`, `(S)`, `(From Sample Variance)`)
 *   - bare SE header → infer `RSR` (FOCE-classical default sandwich)
 *   - `$DESIGN` → `from $DESIGN` (with parenthetical if both)
 *   - covMatrixSingular → `R singular` / `S singular` (banner explains in detail)
 *   - nothing emitted → null (no badge — model didn't run $COV)
 */
function covMethodBadge(lst) {
  if (!lst) return null;
  let label = null;
  let tooltip = null;
  if (lst.covMatrixSingular) {
    label = lst.covMatrixSingular + ' singular';
    tooltip =
      lst.covMatrixSingular +
      ' matrix algorithmically singular — COV step did not produce SEs (matrix written to .' +
      (lst.covMatrixSingular === 'S' ? 'smt' : 'rmt') +
      '). Diagnostics block has the full message.';
  } else if (lst.hasDesign) {
    label = 'from $DESIGN';
    if (lst.rseMatrix) label += ' (' + lst.rseMatrix + ')';
    tooltip =
      'NM75+ optimal-design Fisher Information. $DESIGN auto-runs $COV MATRIX=R UNCONDITIONAL — SEs are FIM-derived, not classical-COV-derived.';
  } else if (lst.rseMatrix) {
    label = lst.rseMatrix;
    tooltip = covMethodTooltipForTag(lst.rseMatrix);
  } else if (lst.seBlockEmitted) {
    label = 'RSR';
    tooltip =
      'Default sandwich (R⁻¹SR⁻¹). NONMEM emits the SE block without a parenthetical when the default is used; only deviations get a tag.';
  }
  if (!label) return null;
  const span = document.createElement('span');
  span.className = 'method';
  span.textContent = label;
  if (tooltip) span.title = tooltip;
  return span;
}

function covMethodTooltipForTag(tag) {
  if (tag === 'RSR') return 'Sandwich estimator R⁻¹SR⁻¹ — the $COV default for classical methods (FOCE, FOCEI) and what IMP / SAEM→IMP-EONLY chains converge to.';
  if (tag === 'R') return 'R-only: 2×R⁻¹ (Hessian inverse). From explicit $COV MATRIX=R or $DESIGN.';
  if (tag === 'S') return 'S-only: 4×S⁻¹ (cross-product gradient inverse). Emitted when ITS or $COV MATRIX=S is used — first-order approximation, not the proper sandwich.';
  if (tag === 'From Sample Variance') return 'BAYES / NUTS posterior sample variance — credible-interval-style SEs.';
  return 'Matrix-method tag emitted by NONMEM at the SE block header.';
}

function renderStatuses(statuses) {
  const wrap = document.createElement('div');
  wrap.className = 'statuses';
  for (const s of statuses) {
    const cls = s.level === 'OK' ? 'status-ok' : s.level === 'WARNING' ? 'status-warning' : 'status-error';
    const span = document.createElement('span');
    span.className = 'status ' + cls;
    span.textContent = s.label;
    // Native browser tooltip via `title`. When sumo provided detail
    // (e.g. parameter pairs + correlation values under "Large
    // correlations…") show that; otherwise fall back to the level.
    span.title = s.detail && s.detail.length > 0 ? s.detail.join('\n') : s.level;
    wrap.append(span);
  }
  return wrap;
}

function renderSection(title, rows, hasFit, kind, showLabel = true, showPrior = false) {
  // Layout (per-mode):
  //   mod-mode (no fit):  `# | Label | LB | IE | UB`
  //   lst-mode  (fit):    `# | Label | LB | IE | UB | FE | (RSE%) | [Shrinkage%]?`
  //
  //  - `#`: index for diagonals (THETA(1) → "1", OMEGA(1,1) → "1");
  //         subscript for off-diagonals (OMEGA(2,1) → "2,1").
  //  - `LB / IE / UB`: lower bound / initial estimate / upper bound from
  //         the .mod (or `.lst`'s embedded ctrl stream in lst-mode).
  //         Bounds are missing for OMEGA / SIGMA today (vscode-nmtran's
  //         API doesn't expose them) — those columns render `—`.
  //  - `FE`: final estimate (lst-mode). Toggles transform:
  //         `exp(θ)` exponentiates THETA, `√Ω/ρ` rescales OMEGA/SIGMA —
  //         diagonals → SD (√variance); off-diagonals → correlation
  //         (cov / √(var_i · var_j)). Computed per-section using a
  //         diagonal lookup so off-diagonals get the right denominators.
  //  - `(RSE%)` only in lst-mode; PsN sumo's default sd_rse=1 convention
  //         (the ratio is dimensionless so the scale toggles don't
  //         change it).
  //  - `[Shrinkage%]` only on Omega rows in lst-mode.
  //
  // FIXED rows are blue-tinted via the global `tr.fixed-row` rule; no
  // separate column needed.
  const isOmega = kind === 'omega';
  const isSigma = kind === 'sigma';
  // Both OMEGA and SIGMA carry a `[Shrinkage%]` column — sourced from
  // ETASHRINKSD(%) for OMEGA(i,i), EPSSHRINKSD(%) for SIGMA(i,i).
  // Off-diagonals don't have a shrinkage value so the cell renders `—`.
  // THETA has no shrinkage but we ALWAYS emit the 8th column anyway
  // (em-dash placeholder) so column counts stay uniform across THETA /
  // OMEGA / SIGMA — guarantees the LB / IE / UB / FE / (RSE%) cells land
  // at the same x-position regardless of CSS table-layout quirks.
  const hasShrinkData = hasFit && (isOmega || isSigma);
  // RSE header: bare `RSE`. The COV-method (sandwich / R-only / S-only /
  // from $DESIGN / sample variance) used to live as an inline suffix
  // here — it's now a single badge in the summary header (covMethodBadge)
  // since all RSE columns share the same source. Tooltip carries the
  // scale + source detail for users who hover.
  const rseHeader = 'RSE';
  const rseTitle = rseTooltip(kind);
  // Build cols + matching colClasses in lockstep so CSS class-based
  // widths don't depend on nth-child positions (those would break when
  // Label is conditionally dropped). NSD = NUMSIGDIG: per-parameter
  // significant-digit count from the .lst (lower than the global
  // sig-digits flags poorly-estimated params).
  const cols = ['#'];
  const colClasses = ['col-num'];
  if (showLabel) { cols.push('Label'); colClasses.push('col-label'); }
  cols.push('LB', 'IE', 'UB'); colClasses.push('col-lb', 'col-ie', 'col-ub');
  // P / PV / PD columns sit between UB and FE so they're adjacent to
  // IE (prior mean ~ initial estimate) and FE (estimated mean), the
  // natural visual comparison. Per-kind header: THETA shows "PV"
  // (variance of normal prior); OMEGA / SIGMA show "PD" (degrees of
  // freedom of inverse-Wishart prior). Column class is the same so
  // they line up vertically across sections.
  if (showPrior) {
    cols.push('P', kind === 'theta' ? 'PV' : 'PD');
    colClasses.push('col-prior', 'col-prior-var');
  }
  if (hasFit) {
    cols.push('FE', rseHeader, 'NSD', 'Shrinkage');
    colClasses.push('col-fe', 'col-rse', 'col-nsd', 'col-shrink');
  }
  const shrinkSdByIndex = isOmega
    ? collectEtaShrinkages()
    : isSigma
      ? collectEpsShrinkages()
      : [];
  const diagBaseValues = buildDiagBaseValues(rows, hasFit);
  // Separate init-based diagonal lookup for the IE-column transform.
  // In lst-mode the FE column uses final-based diagonals (above); IE
  // must use init-based ones so the transform applies consistently to
  // BOTH columns regardless of which scale the user is comparing.
  // In mod-mode the two maps are identical (hasFit=false → buildDiagBaseValues
  // returns inits anyway), so reuse the existing one.
  const ieDiagBaseValues = hasFit ? buildDiagBaseValues(rows, false) : diagBaseValues;
  // Implicit-bound display: when vscode-nmtran returns null (.mod omits
  // a bound), show NONMEM's actual implicit value muted with a tooltip
  // instead of em-dash. Empirically and per nmhelp.tingjieguo.com:
  //   - THETA:        ±1e+06 sentinels  (run010.lst echoes ±0.1000E+07)
  //   - OMEGA/SIGMA diagonal:
  //       lower = 0   (variance ≥ 0; PD constraint, doc-confirmed)
  //       upper = 1e+06 (no-bound sentinel, by analogy with THETA)
  //   - OMEGA/SIGMA off-diagonal: em-dash stays — bound is the
  //       matrix-PD constraint (|cov| ≤ √(varᵢ·varⱼ)), not a scalar.
  const isTheta = kind === 'theta';
  const isOmegaOrSigma = kind === 'omega' || kind === 'sigma';
  const boundCell = (val, side, name) => {
    if (val !== null) return val;
    if (isTheta) return impliedBoundCell(side, 'theta');
    if (isOmegaOrSigma && matrixIsDiagonal(name)) {
      return impliedBoundCell(side, 'omega-diag');
    }
    return null; // em-dash for off-diagonals
  };
  const cellsForRow = (r) => {
    const idx = indexCell(r.name);
    const head = showLabel ? [idx, r.label] : [idx];
    const lb = boundCell(r.lower, 'lower', r.name);
    const ub = boundCell(r.upper, 'upper', r.name);
    // `r.impliedInit` is set by the payload's `pickInit` when init had
    // to be sourced from `.ext` iteration-0 (vscode-nmtran returned
    // null/NaN — typically empty-init `$THETA (-1, , 1)` form, where
    // NONMEM computed the midpoint, but also bare-form `$THETA 1` when
    // vscode-nmtran < 0.4.21 returned NaN). We render those values
    // muted with a tooltip so the user knows they aren't from .mod text.
    // Apply the active toggle (√Ω/ρ on OMEGA/SIGMA, exp(θ) on THETA) to
    // IE as well as FE. Reasonable from a workflow perspective: when the
    // user is reading the table on the SD scale, BOTH the initial and
    // final estimates should be on that scale; mixing variance-form IE
    // with SD-form FE would force the reader to mental-math `√IE` to
    // compare. Also fixes mod-mode where the toggle previously had no
    // visible effect (no FE column).
    const ieTransformed = transformValue(r.init, kind, r.name, ieDiagBaseValues);
    const ie = r.impliedInit && typeof ieTransformed === 'number' && isFinite(ieTransformed)
      ? impliedInitCell(ieTransformed)
      : ieTransformed;
    // Prior columns when in scope.
    //  - **P** transforms with the active toggle: `exp(θ)` for THETA,
    //    `√Ω/ρ` for OMEGA/SIGMA — the prior MEAN/MODE shares the same
    //    scale as θ / OMEGA(i,i), so users on the SD scale see prior
    //    SDs and final SDs together (consistent with IE/FE).
    //  - **PV / PD** stay raw under any toggle:
    //      * PV is a normal-prior variance, not a θ-scale value — no
    //        natural `exp()`; we annotate the cell tooltip with the
    //        derived SD (√PV) for readability.
    //      * PD is degrees of freedom — dimensionless scalar; we
    //        annotate the cell tooltip with the informativeness
    //        anchors (m+1 = uninformative; ~N_subj = informative).
    const pTransformed = transformValue(r.priorValue, kind, r.name, ieDiagBaseValues);
    const priorCells = showPrior ? [pTransformed, priorVarOrDfCell(r)] : [];
    if (!hasFit) return [...head, lb, ie, ub, ...priorCells];
    const valueCell = renderValueCell(r, kind, hasFit, diagBaseValues);
    // RSE source: ALWAYS prefer NONMEM's authoritative SD/corr-form
    // (`-1000000005`) when present, regardless of the `√Ω/ρ` display
    // toggle. RSE is unit-free — it's intrinsically on the SD/corr
    // scale for OMEGA / SIGMA, and the cvse/2 fallback is mathematically
    // wrong for off-diagonals (treats correlations like diagonals).
    // The toggle is purely a display choice for the FE column.
    // cvse/2 only used when `-1000000005` is absent (old NONMEM / no $COV).
    const rseValue =
      isOmegaOrSigma && typeof r.rseStdcorr === 'number' ? r.rseStdcorr : r.rse;
    const rseCell = fmtRse(rseValue, kind);
    const nsdCell = fmtNsd(r.numSigDig);
    const base = [...head, lb, ie, ub, ...priorCells, valueCell, rseCell, nsdCell];
    if (!hasShrinkData) {
      base.push(null);
      return base;
    }
    // Diagonal-only + valid 1-based index defended. `r.index` should
    // always be set for diagonal rows (payload contract), but a
    // contract-violating null/0 would silently look up `[-1]` →
    // undefined → fmtShrinkage drops it as non-finite. No crash, but
    // silent data loss is worse than visible em-dash. Guard explicitly.
    const shrink =
      matrixIsDiagonal(r.name) && typeof r.index === 'number' && r.index >= 1
        ? shrinkSdByIndex[r.index - 1]
        : undefined;
    base.push(fmtShrinkage(shrink));
    return base;
  };
  const rowCells = rows.map(cellsForRow);
  const rowAttrs = rows.map((r) => ({ declLine: r.declLine, fixed: r.fixed }));
  // Per-section column tooltips: most cells fall back to the static
  // COL_TITLES map in sectionEl; the RSE header overrides because the
  // explanation (SD-scale for OMEGA/SIGMA, identity for THETA, with
  // matrix-derivation source) is kind-specific.
  const colTitles = cols.map((c) => (c === rseHeader ? rseTitle : null));
  return sectionEl(title, cols, rowCells, rowAttrs, 'param-table', sectionHeadingToggle(kind), colClasses, colTitles);
}

/**
 * Per-kind tooltip text for the RSE column header. THETA's RSE is just
 * SE/|θ| with no scale transform (θ isn't a variance, so SD-vs-VAR
 * doesn't apply). OMEGA / SIGMA RSE is on the SD / correlation scale
 * (sumo `sd_rse=1` convention) regardless of the value-column toggle —
 * NONMEM emits this directly via `.ext` row `-1000000005`, falling back
 * to the cvse/2 delta-method approximation when that row is absent.
 */
function rseTooltip(kind) {
  if (kind === 'theta') {
    return 'RSE = SE / |θ| from .ext row -1000000001. No scale transform — θ is not a variance, so SD-vs-VAR distinction does not apply.';
  }
  return 'RSE on the SD / correlation scale (sumo sd_rse=1 convention; pharmacometric standard). Source: .ext row -1000000005 (NONMEM-direct, full delta-method propagation) when $COV produced it, otherwise the cvse/2 Taylor approximation from -1000000001. Independent of the √Ω/ρ display toggle — toggle only affects the FE column.';
}

/**
 * Build `i -> diagonal variance` lookup for the current OMEGA / SIGMA
 * section. Used by the `√Ω` toggle to compute correlations for off-
 * diagonals (`cov(i,j) / sqrt(var_i * var_j)`). Uses `final` in lst-
 * mode and `init` in mod-mode so the toggle behaves the same in both.
 * Returns an empty Map when no rows match — `transformValue` falls
 * back to the raw value in that case.
 */
/**
 * Compute the displayed value for a parameter row, applying the
 * `√Ω` / `exp(θ)` toggles. The base value is the final estimate in
 * lst-mode and the initial estimate in mod-mode. Returns the
 * unwrapped number (fmtNum handles formatting via rowEl) or null
 * when the source value is missing.
 *
 * `boundary` highlight applies to the unwrapped final estimate;
 * the toggles are post-display transforms and don't affect bound
 * detection.
 */
function renderValueCell(r, kind, hasFit, diagBaseValues) {
  const base = hasFit ? r.final : r.init;
  // Prefer NONMEM's own SD/correlation form (.ext -1000000004) when the
  // toggle is on for OMEGA/SIGMA. Eliminates client-side sqrt/correlation
  // math; what we render is exactly what NONMEM wrote. Falls back to
  // `transformValue` (sqrt(v) for diag, cov/√(vᵢvⱼ) for off-diag) for
  // mod-mode, THETA exp(θ), or older NONMEM versions without the row.
  const useStdcorrFinal =
    hasFit &&
    prefs.sqrtOm &&
    (kind === 'omega' || kind === 'sigma') &&
    typeof r.finalStdcorr === 'number';
  const v = useStdcorrFinal
    ? r.finalStdcorr
    : transformValue(base, kind, r.name, diagBaseValues);
  if (v === null) return null;
  // FIX rows: the global `tr.fixed-row` blue tint already calls them
  // out, so we don't add an extra span; just emit the number.
  // Boundary rows: orange tint via .boundary class on a wrapping span
  // so the colour applies to the value cell only (not the whole row).
  if (hasFit && r.boundary) {
    const span = document.createElement('span');
    span.className = 'boundary';
    span.textContent = fmtNum(v);
    span.title =
      r.boundary === 'lower'
        ? 'At lower bound — estimator did not converge freely'
        : 'At upper bound — estimator did not converge freely';
    return span;
  }
  return v;
}

// `transformValue` lives in `transforms.js` (loaded BEFORE this script).
// Was previously duplicated here — the duplicate shadowed the testable
// version, so any bug fix in transforms.js was silently overridden at
// runtime. Removed to keep the single source of truth.

/**
 * Render the "#" column cell for a parameter row.
 *  - THETA(1)   → "1"
 *  - OMEGA(1,1) → "1"   (diagonal collapses to single index)
 *  - OMEGA(2,1) → "2,1" (off-diagonal keeps the subscript)
 * Tooltip carries the full access key so users can still see the .ext
 * column name.
 */
function indexCell(name) {
  const span = document.createElement('span');
  const m = name.match(/\((.+)\)$/);
  let display = name;
  if (m) {
    const parts = m[1].split(',');
    display = parts.length === 2 && parts[0] === parts[1] ? parts[0] : m[1];
  }
  span.textContent = display;
  span.title = name;
  return span;
}

/**
 * Build a muted, tooltipped cell for an implicit bound. Three contexts:
 *   - 'theta'      : both sides → ±1e+06 (NONMEM no-bound sentinel,
 *                    confirmed by run010.lst INITIAL ESTIMATE block)
 *   - 'omega-diag' lower → 0 (variance ≥ 0; PD constraint per
 *                    nmhelp.tingjieguo.com $OMEGA / $SIGMA docs)
 *   - 'omega-diag' upper → 1e+06 (no-bound sentinel, by analogy)
 */
function impliedBoundCell(side, kind) {
  const span = document.createElement('span');
  span.className = 'dim';
  let text;
  let tooltip;
  if (kind === 'omega-diag' && side === 'lower') {
    text = '0';
    tooltip =
      'Implicit lower bound — NONMEM enforces variance ≥ 0 (positive-definiteness on $OMEGA / $SIGMA matrices).';
  } else if (kind === 'omega-diag' && side === 'upper') {
    text = '1e+06';
    tooltip =
      'Implicit upper bound — NONMEM uses +1e+06 as its no-bound sentinel for OMEGA / SIGMA diagonals.';
  } else {
    text = side === 'lower' ? '-1e+06' : '1e+06';
    tooltip =
      'Implicit ' +
      side +
      ' bound — no bound given in $THETA, NONMEM uses ' +
      (side === 'lower' ? '-1e+06' : '+1e+06') +
      ' as its no-bound sentinel.';
  }
  span.textContent = text;
  span.title = tooltip;
  return span;
}

/**
 * Build a muted, tooltipped cell showing NONMEM's auto-computed init
 * for an empty-init `$THETA (lower, , upper)` form. Doc-confirmed by
 * `nmguides.vrognas.com/part-i/c-simple-regression #sec-c-3-4`:
 * "if an initial estimate of some θ is not given, then the midpoint
 *  between the lower and upper bounds is used." Empirically verified
 * by run012 — `(-1, , 1)` runs with init=0 in the search trace.
 */
function impliedInitCell(value) {
  const span = document.createElement('span');
  span.className = 'dim';
  span.textContent = fmtNum(value);
  span.title =
    'Empty init slot in $THETA — NONMEM computes the midpoint of bounds at PRED initialization.';
  return span;
}

/**
 * Chan Kwong 2020's "tight prior" heuristic: PV ≤ (P · TIGHTNESS_FACTOR)²
 * corresponds to a prior RSE ≤ TIGHTNESS_FACTOR (e.g. 0.3 → 30% RSE).
 * Surfaced in the PV tooltip; lifted to a named const so any future
 * thresholding surface (a settings knob, a visual `.tight` tier badge)
 * can reference the same value.
 */
const PRIOR_TIGHTNESS_FACTOR = 0.3;

/**
 * Build the PV-or-PD cell for a $PRIOR'd row. Picks PV (THETA) or PD
 * (OMEGA/SIGMA) by which field is non-null, renders raw value, and
 * attaches an informativeness-anchor tooltip:
 *   - PV → "SD = √PV = X" plus Chan Kwong 2020 informativeness rule
 *   - PD → "non-informative when m+1 ≤ df ≤ block_dim; very informative
 *           when df ≈ N_subjects of prior study"
 * Returns null when neither field is populated.
 */
function priorVarOrDfCell(r) {
  if (typeof r.priorVariance === 'number' && isFinite(r.priorVariance) && r.priorVariance >= 0) {
    const sd = Math.sqrt(r.priorVariance);
    // Prior RSE = √PV / |P|. Same unitless tightness measure as the
    // RSE column on the FE side; lets the user compare prior
    // informativeness against the data-driven RSE at a glance.
    // Omitted when P is 0 / null (division-by-zero noise).
    const priorRsePct =
      typeof r.priorValue === 'number' && isFinite(r.priorValue) && r.priorValue !== 0
        ? (sd / Math.abs(r.priorValue)) * 100
        : null;
    const rseLine =
      priorRsePct !== null
        ? ' Prior RSE = √PV/|P| = ' + priorRsePct.toFixed(2) + '%.'
        : '';
    const tip =
      'PV (prior variance, normal prior on θ) = ' + fmtNum(r.priorVariance) +
      '. Prior SD = √PV = ' + fmtNum(sd) + '.' + rseLine +
      ' Smaller PV pulls the estimate toward P more strongly. ' +
      'PV ≥ 1e6 ≈ non-informative; PV ≤ (P·' + PRIOR_TIGHTNESS_FACTOR +
      ')² ≈ tight (Chan Kwong 2020).';
    // Inline dim badge with the derived prior RSE — saves the user
    // having to hover the tooltip for the most common follow-up
    // question ("how tight is this prior?"). Single line; uses the
    // existing `.dim` token so row height is unchanged.
    const badge = priorRsePct !== null ? '(' + priorRsePct.toFixed(0) + '%)' : null;
    return annotatedNumber(r.priorVariance, tip, badge);
  }
  if (typeof r.priorDf === 'number' && isFinite(r.priorDf)) {
    const tip =
      'PD (prior degrees of freedom, inverse-Wishart prior on OMEGA/SIGMA) = ' +
      fmtNum(r.priorDf) +
      '. Anchors: m+1 (block dim + 1) ≈ non-informative; ' +
      '~N_subjects (prior study) ≈ very informative. ' +
      'Informative formula: df = 2·(Ω²/SE(Ω²))² + 1 (Gisleskog 2002).';
    return annotatedNumber(r.priorDf, tip);
  }
  return null;
}

/**
 * Render a numeric cell with a custom tooltip and an optional dim
 * trailing badge. The badge is an inline-block with a fixed min-
 * width + left text-align (see `.badge-fixed` in style.css), so all
 * badges occupy the same horizontal space regardless of content
 * (e.g. `(7%)` vs `(42%)`). Combined with the cell's right-alignment,
 * the value's right edge lands at the same X-position across rows
 * (decimal-column alignment). Returns null for non-finite input so
 * the caller renders the standard `—`.
 */
function annotatedNumber(value, tooltip, dimBadge) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  const wrap = document.createElement('span');
  wrap.title = tooltip;
  wrap.append(document.createTextNode(fmtNum(value)));
  if (dimBadge) {
    const badge = document.createElement('span');
    badge.className = 'dim badge-fixed';
    badge.textContent = dimBadge;
    wrap.append(badge);
  }
  return wrap;
}

// Hover-tooltips for the short column headers — pharmacometric
// abbreviations aren't universally familiar.
const COL_TITLES = {
  '#': 'Parameter index (or matrix subscript for OMEGA/SIGMA off-diagonals). Hover the cell for the full access key.',
  Label: 'Inline `;<comment>` from the .mod source line — Pirana convention. `$THETA 4.79 ;CL` → "CL".',
  LB: 'Lower bound from `$THETA (lb, ie, ub)`. Em-dash for OMEGA/SIGMA — vscode-nmtran does not yet expose those bounds.',
  IE: 'Initial estimate from the .mod (or the .lst\'s embedded control stream in lst-mode).',
  UB: 'Upper bound from `$THETA (lb, ie, ub)`. Em-dash for OMEGA/SIGMA.',
  FE: 'Final estimate (lst-mode only). Affected by the √Ω/ρ and exp(θ) toggles in the section heading.',
  Name: 'Parameter access key (matches `.ext` columns)',
  ETABAR: 'Arithmetic mean of the ETA-estimates',
  'P VAL.':
    "NONMEM's two-sided significance test for ETABAR ≠ 0. Small p (< 0.05) flags an ETA whose mean differs from zero — typically a structural model mis-specification or an omitted covariate.",
};

function sectionEl(title, cols, rowsData, rowAttrs, tableClass, headingExtra, colClasses, colTitles) {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  if (title) {
    const h = document.createElement('h3');
    // textContent first so the title text leads; the optional toggle
    // (or any other inline control) follows on the same line via the
    // `display: flex` rule on `.section h3`.
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    h.append(titleSpan);
    if (headingExtra instanceof Node) h.append(headingExtra);
    wrap.append(h);
  }
  const table = document.createElement('table');
  if (tableClass) table.className = tableClass;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  cols.forEach((c, i) => {
    const th = document.createElement('th');
    th.textContent = c;
    // Per-section tooltip override (e.g. kind-specific RSE explanation)
    // takes precedence over the static COL_TITLES map.
    const dynTitle = colTitles && colTitles[i];
    if (dynTitle) th.title = dynTitle;
    else if (COL_TITLES[c]) th.title = COL_TITLES[c];
    if (colClasses && colClasses[i]) th.className = colClasses[i];
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  // rowAttrs is parallel to rowsData; pass [] for sections that don't
  // need per-row metadata (ETA/EPS shrinkage tables) — rowEl applies
  // its defaults from `attrs || {}`.
  rowsData.forEach((cells, i) => tbody.append(rowEl(cells, rowAttrs[i] || {}, colClasses)));
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

/**
 * Split a formatted number into integer / fraction <span> nodes for
 * decimal-point alignment. The integer span is right-aligned against
 * the fraction span's left edge; the fraction span is left-aligned
 * and has a CSS `min-width` (applied per-column in style.css — IE /
 * FE / Prior get the padding) so the leading `.` sits at the same X
 * across rows. For integer-only values (`0`, `-3`, `1e+06`, `100`)
 * the fraction span is empty — still emitted so it occupies the
 * reserved decimal-column space and the integer's right edge anchors
 * at the same X as decimals do. Scientific values like `1.807e+35`
 * have the entire mantissa-and-exponent suffix in the fraction span;
 * if it exceeds the column's `min-width`, the fraction widens and
 * the integer is pushed left — decimal-align is sacrificed for that
 * row but the value stays readable.
 */
function decimalAlignSpans(text) {
  const intSpan = document.createElement('span');
  intSpan.className = 'num-int';
  const fracSpan = document.createElement('span');
  fracSpan.className = 'num-frac';
  const dot = text.indexOf('.');
  if (dot === -1) {
    intSpan.textContent = text;
  } else {
    intSpan.textContent = text.slice(0, dot);
    fracSpan.textContent = text.slice(dot);
  }
  return [intSpan, fracSpan];
}

function rowEl(cells, attrs, colClasses) {
  const tr = document.createElement('tr');
  const classes = [];
  const clickable = typeof attrs.declLine === 'number';
  if (clickable) {
    classes.push('clickable');
    tr.addEventListener('click', () =>
      vscode.postMessage({ type: 'gotoLine', line: attrs.declLine }),
    );
  }
  if (attrs.fixed) classes.push('fixed-row');
  if (classes.length) tr.className = classes.join(' ');
  cells.forEach((c, i) => {
    const td = document.createElement('td');
    if (colClasses && colClasses[i]) td.className = colClasses[i];
    if (c === null || c === undefined) {
      const dash = document.createElement('span');
      dash.className = 'dim';
      dash.textContent = '—';
      td.append(dash);
    } else if (c instanceof Node) {
      // `Node`, not `HTMLElement` — symmetry with sectionEl + future-
      // proof against helpers returning a bare `Text` node (would
      // otherwise fall through to `String(c)` and render as
      // "[object Text]").
      td.append(c);
    } else if (typeof c === 'number') {
      td.append(...decimalAlignSpans(fmtNum(c)));
      // Title: full-precision JS-native representation. fmtNum may
      // compress very-large/small magnitudes (|exp| ≥ 100) to
      // toExponential(0) so they fit the column; hover reveals the
      // unrounded value. Skipped for non-finite — `NaN.toString()`
      // is just "NaN" which is also what gets displayed.
      if (Number.isFinite(c)) td.title = String(c);
    } else {
      const text = String(c);
      td.textContent = text;
      // Label column truncates with CSS ellipsis (style.css). Mirror the
      // full text into `title` so hover shows it. Skip when the cell is
      // empty / a single em-dash — no value in surfacing those.
      if (colClasses && colClasses[i] === 'col-label' && text.length > 0) {
        td.title = text;
      }
    }
    // Hover-to-see-full-value for clipped numeric cells. style.css applies
    // `overflow: hidden` to numeric columns so wide values like `242.706`
    // / `1.807e+35` don't overlap into neighbours at narrow pane widths.
    // The clip removes leading characters (text is right-aligned) — the
    // most informative half — so we mirror the textContent into the
    // title so hover always reveals the full value. Skip the em-dash
    // placeholder (no info), label cells (title set explicitly above),
    // and cells whose inner span already carries a title (annotatedNumber
    // tooltips win — they describe what the number means, not just its
    // value).
    if (!td.title && td.textContent && td.textContent !== '—') {
      td.title = td.textContent;
    }
    tr.append(td);
  });
  return tr;
}

vscode.postMessage({ type: 'ready' });

// Dual-mode export: WebView ignores (`module` is undefined in
// browsers); Node / vitest sees the exports for unit testing the pure
// helpers (no DOM dependency). Same pattern as transforms.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyAttrTier, buildEstAttrCell, buildCovAttrCell };
}

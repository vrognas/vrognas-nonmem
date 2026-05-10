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
        message: e && e.stack ? e.stack : String(e),
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
let thresholds = {
  shrinkageWarnPct: 30,
  shrinkageBorderlineWarnPct: 20,
  rseWarnPct: 100,
  rseThetaWarnPct: 30,
  rseOmegaWarnPct: 50,
  pValWarnThreshold: 0.1,
  pValBadThreshold: 0.05,
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
    const isEval = lst && lst.methodShort ? lst.methodShort.endsWith('-eval') : false;
    const sigDigits = lst && typeof lst.sigDigits === 'number' ? lst.sigDigits : null;
    const nsigRequired = lst && typeof lst.nsigRequired === 'number' ? lst.nsigRequired : null;
    root.append(renderOfvHeadline(payload.summary.ofv, isEval, sigDigits, nsigRequired));
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
  if (payload.thetas.length) { root.append(renderSection('Theta', payload.thetas, hasFit, 'theta', showLabel)); rendered = true; }
  if (payload.omegas.length) { root.append(renderSection('Omega', payload.omegas, hasFit, 'omega', showLabel)); rendered = true; }
  if (payload.sigmas.length) { root.append(renderSection('Sigma', payload.sigmas, hasFit, 'sigma', showLabel)); rendered = true; }
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
    root.append(renderTrajectories(payload.trajectories, xmlResults, xmlOpts));
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
    root.append(renderEstimationOptions(d.xmlEstimationOptions, tiers, lstRecords, d.lstTolerances, !!d.hasOde, !!d.hasLevel));
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

/**
 * Convergence trajectory section — one collapsible block per chained
 * $EST step. Each block shows: an OFV line plot full-width on top,
 * then a grid of small per-parameter sparklines below. The user
 * scans for monotonic-decrease (OFV) + parameter stabilisation.
 *
 * Default open when only one $EST step exists; default closed for
 * chained $EST so the inspector stays scannable. We render the
 * full SVG up-front (no on-demand expansion) — payloads are small
 * (a few hundred points × ~20 params).
 */
function renderTrajectories(trajectories, xmlResults, xmlOpts) {
  const wrap = document.createElement('details');
  wrap.className = 'convergence';
  wrap.open = trajectories.length === 1;
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = 'Convergence trajectory (' + trajectories.length
    + (trajectories.length === 1 ? ' $EST step)' : ' $EST steps)');
  wrap.append(summaryEl);
  for (let i = 0; i < trajectories.length; i++) {
    const stepOpts = (xmlOpts && xmlOpts[i]) || null;
    wrap.append(renderTrajectoryStep(trajectories[i], xmlResults[i] || null, stepOpts));
  }
  return wrap;
}

function renderTrajectoryStep(t, xmlResult, stepOpts) {
  const block = document.createElement('div');
  block.className = 'convergence-step';
  const heading = document.createElement('div');
  heading.className = 'convergence-step-heading';
  heading.textContent = t.method + ' (' + t.iterations.length + ' iters)';
  block.append(heading);

  // XML-derived per-step result line: termination_status + timing.
  // Only renders when the XML provided this step's results (xmlResult
  // != null). Format: `termination · burn-in N.Ns · elapsed N.Ns`,
  // mirroring the existing meta-line `·`-separated style. Termination
  // 0 (success) renders green; non-zero red.
  if (xmlResult) {
    const meta = document.createElement('div');
    meta.className = 'convergence-step-meta';
    const parts = [];
    if (xmlResult.terminationStatus !== null) {
      // Method-aware termination labels: EM uses NM73+ documented
      // codes (0/8 = completed, 1/9 = ran out of iters, ...);
      // classical methods use arbitrary FORTRAN error numbers.
      // `classifyEstimationMethodKind` from formatters.js routes by
      // the XML estimation_method attr.
      const methodKind = stepOpts
        ? classifyEstimationMethodKind(stepOpts.estimation_method)
        : null;
      const code = xmlResult.terminationStatus;
      // EM: codes 0 and 8 are both "completed" (success). Classical:
      // anything but 0 + non-negative is a failure of some kind.
      const ok = methodKind === 'em' ? (code === 0 || code === 8) : code === 0;
      const label = terminationCodeLabel(code, methodKind);
      const span = document.createElement('span');
      span.className = ok ? 'meta-good' : 'meta-bad';
      span.textContent = 'termination: ' + label;
      parts.push(span);
    }
    if (xmlResult.burninTime !== null) {
      parts.push(document.createTextNode('burn-in ' + fmtNum(xmlResult.burninTime) + 's'));
    }
    if (xmlResult.elapsedTime !== null) {
      parts.push(document.createTextNode('elapsed ' + fmtNum(xmlResult.elapsedTime) + 's'));
    }
    if (parts.length > 0) {
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) meta.append(' · ');
        meta.append(parts[i]);
      }
      block.append(meta);
    }
  }

  // Find the OFV column by name (`/OBJ$/i` — matches OBJ / SAEMOBJ /
  // IMPOBJ / BAYESOBJ). Falls back to the last column.
  let ofvIdx = -1;
  for (let i = t.paramNames.length - 1; i >= 0; i--) {
    if (/OBJ$/i.test(t.paramNames[i])) { ofvIdx = i; break; }
  }
  if (ofvIdx === -1 && t.paramNames.length > 0) ofvIdx = t.paramNames.length - 1;

  // IMP EONLY=1 freezes parameters and only refines OFV via importance
  // sampling. Detection: NONMEM emits "Objective Function Evaluation by
  // Importance Sampling" verbatim for EONLY=1 (vs plain "Importance
  // Sampling" for the iterative form).
  const isEonly = /objective function evaluation/i.test(t.method);

  // Default start iter: when a block has BOTH burn-in (negative iters)
  // and accumulation (>=0), default to the first accumulation iter.
  // Convergence is assessed in the accumulation/stationary phase —
  // showing burn-in by default flattens the rest of the trace
  // because OFV typically drops several orders of magnitude in the
  // first 1-2 iters. The user can drag the slider left to pull
  // burn-in back into view. When the run is all-burn-in (interrupted
  // via next.sig before iter 0) or all-accumulation (FOCE / IMP
  // EONLY), default to start=0 so the full trace is visible.
  let defaultStartIdx = 0;
  const hasBurnIn = t.iterations.some((i) => i < 0);
  const hasAccumulation = t.iterations.some((i) => i >= 0);
  if (hasBurnIn && hasAccumulation) {
    for (let i = 0; i < t.iterations.length; i++) {
      if (t.iterations[i] >= 0) { defaultStartIdx = i; break; }
    }
  }

  // Start-iter slider — early SAEM/IMP burn-in iterations have huge
  // OFV swings (10^5 -> 10^-something at iter 2) that flatten the
  // trace beyond visibility for the rest of the run. Slider drags
  // crop the leading iterations so trends near convergence become
  // legible. Per-block (each $EST has its own iter range — SAEM
  // burn-in starts negative; IMP EONLY at 0).
  const controls = document.createElement('div');
  controls.className = 'convergence-controls';
  const sliderLabel = document.createElement('label');
  sliderLabel.textContent = 'start at iter ';
  sliderLabel.className = 'convergence-slider-label';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(Math.max(0, t.iterations.length - 1));
  slider.value = String(defaultStartIdx);
  slider.step = '1';
  slider.className = 'convergence-slider';
  // Bound after-render so the val span is updated alongside the plots.
  const sliderVal = document.createElement('span');
  sliderVal.className = 'convergence-slider-val';
  sliderVal.textContent = String(t.iterations[defaultStartIdx] ?? 0);
  controls.append(sliderLabel, slider, sliderVal);
  // Tooltip on the label clarifies the default-to-accumulation choice
  // for SAEM/BAYES users who notice the slider isn't at zero.
  if (hasBurnIn && hasAccumulation) {
    sliderLabel.title =
      'Defaulted to the first accumulation iter — convergence is assessed in the stationary phase. ' +
      'Drag left to pull burn-in iterations back into view.';
  }
  block.append(controls);

  // Plots container — replaced wholesale on each slider movement so
  // the (small) DOM churn keeps the layout snap-to-grid.
  const plotsContainer = document.createElement('div');
  plotsContainer.className = 'convergence-plots';
  block.append(plotsContainer);

  function renderPlots(startIdx) {
    plotsContainer.replaceChildren();
    const iters = t.iterations.slice(startIdx);

    if (ofvIdx >= 0) {
      const ofvName = t.paramNames[ofvIdx];
      const ofvVals = (t.values[ofvName] || []).slice(startIdx);
      plotsContainer.append(renderSparklineCell(ofvName, iters, ofvVals, true));
    }

    if (isEonly) {
      const note = document.createElement('div');
      note.className = 'convergence-eonly-note';
      note.textContent = 'Parameters frozen — EONLY=1 refines the OFV only.';
      plotsContainer.append(note);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'convergence-grid';
    for (let i = 0; i < t.paramNames.length; i++) {
      if (i === ofvIdx) continue;
      const name = t.paramNames[i];
      const vals = (t.values[name] || []).slice(startIdx);
      grid.append(renderSparklineCell(name, iters, vals, false));
    }
    plotsContainer.append(grid);
    // Synchronous measure-and-lock: `offsetWidth` reads inside
    // `tuneGridColumns` already force a layout flush, so we don't
    // need rAF. Calling here in the same frame as the append also
    // avoids the visible flicker where un-tuned cells paint at the
    // CSS default 110px before snapping to measured width.
    tuneGridColumns(grid);
  }

  // rAF-coalesce slider drag: `input` fires per pixel, but
  // `renderPlots` does a full grid rebuild + measure pass — running
  // it on every event during a fast drag is wasteful. Coalesce so
  // at most one render runs per animation frame.
  let pendingFrame = false;
  slider.addEventListener('input', () => {
    const idx = Number(slider.value);
    sliderVal.textContent = String(t.iterations[idx] ?? 0);
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(() => {
      pendingFrame = false;
      renderPlots(Number(slider.value));
    });
  });

  renderPlots(defaultStartIdx);
  return block;
}

function renderSparklineCell(label, iterations, values, isOfv) {
  const cell = document.createElement('div');
  cell.className = isOfv ? 'convergence-cell convergence-cell-ofv' : 'convergence-cell';
  const lab = document.createElement('div');
  lab.className = 'convergence-label';
  lab.textContent = label;
  cell.append(lab);
  cell.append(renderSparkline(iterations, values, isOfv));
  // Numeric range hint below the sparkline (final value + delta from
  // first; sign tells convergence direction). Both endpoints must be
  // finite — NaN values would render as `NaN (Δ NaN)`.
  if (values.length >= 2) {
    const first = values[0];
    const last = values[values.length - 1];
    if (Number.isFinite(first) && Number.isFinite(last)) {
      const delta = last - first;
      const range = document.createElement('div');
      range.className = 'convergence-range';
      range.textContent = fmtNum(last) + (delta === 0 ? '' : (' (Δ ' + (delta > 0 ? '+' : '') + fmtNum(delta) + ')'));
      cell.append(range);
    }
  }
  return cell;
}

/**
 * Resize every cell in a `.convergence-grid` to a uniform width =
 * the widest cell's natural content width (lower-bounded at 110px
 * so the SVG sparkline floor is preserved). Two-pass:
 *   1. Cells set to `width: max-content` so their intrinsic width
 *      reflects the actual text/SVG content rather than the locked
 *      110px from CSS.
 *   2. Read each cell's `offsetWidth`, take the max, lock all
 *      cells AND the grid's `grid-template-columns` to that.
 * Re-runs on every slider movement (since trace-suffix lengths
 * shift with the iteration window — early iters have huge OFVs that
 * print wider).
 */
function tuneGridColumns(grid) {
  const cells = grid.children;
  if (cells.length === 0) return;

  // Phase 1: MEASUREMENT — let cells grow to their natural unwrapped
  // content size. Three things have to give simultaneously:
  //   (a) Grid column tracks must allow growth (CSS sets them to a
  //       fixed 110px; `cell.style.width = max-content` alone can't
  //       escape a fixed track — `offsetWidth` would still report 110).
  //   (b) Cell width set to max-content so the layout wants to grow.
  //   (c) Range text white-space toggled to nowrap so wrap-induced
  //       narrow widths don't fool the measurement.
  grid.style.gridTemplateColumns = 'repeat(auto-fill, max-content)';
  for (const cell of cells) {
    cell.style.width = 'max-content';
    const range = cell.querySelector('.convergence-range');
    if (range) range.style.whiteSpace = 'nowrap';
  }

  // Read offsetWidth — implicit layout flush. Floor at 110 so the
  // sparkline never gets unusably narrow even if every label/range
  // is tiny.
  let maxWidth = 110;
  for (const cell of cells) {
    if (cell.offsetWidth > maxWidth) maxWidth = cell.offsetWidth;
  }
  const colWidth = Math.ceil(maxWidth);

  // Phase 2: LOCK — every cell + the grid columns set to the same
  // width. Range text stays no-wrap (cells are wide enough by
  // construction; saves a relayout if values are at the edge).
  for (const cell of cells) cell.style.width = `${colWidth}px`;
  grid.style.gridTemplateColumns = `repeat(auto-fill, ${colWidth}px)`;
}

/**
 * Build one sparkline as an SVG. Polyline scaled to viewBox; vertical
 * marker at iteration=0 when burn-in (negative iters) is present so
 * the user can see the burn-in / accumulation transition. NaN values
 * break the line.
 */
function renderSparkline(iterations, values, isOfv) {
  const w = isOfv ? 480 : 110;
  const h = isOfv ? 80 : 32;
  const padX = 2;
  const padY = 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('class', isOfv ? 'convergence-svg convergence-svg-ofv' : 'convergence-svg');
  svg.setAttribute('preserveAspectRatio', 'none');

  if (iterations.length === 0 || values.length === 0) return svg;

  // Y range from finite values only; if everything is identical or
  // NaN, skip the polyline (no useful trace).
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  if (!Number.isFinite(yMin) || yMin === yMax) {
    // Constant trace — render a flat midline.
    const flat = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    flat.setAttribute('x1', String(padX));
    flat.setAttribute('y1', String(h / 2));
    flat.setAttribute('x2', String(w - padX));
    flat.setAttribute('y2', String(h / 2));
    flat.setAttribute('class', 'convergence-svg-flat');
    svg.append(flat);
    return svg;
  }

  const xMin = iterations[0];
  const xMax = iterations[iterations.length - 1];
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const pxX = (i) => padX + ((iterations[i] - xMin) / xRange) * (w - 2 * padX);
  const pxY = (v) => padY + ((yMax - v) / yRange) * (h - 2 * padY);

  // Build the polyline as one path with M/L commands so NaN values
  // create a gap (M) rather than a line through zero.
  const segs = [];
  let pen = null; // 'M' = needs MoveTo next, 'L' = LineTo
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      pen = null;
      continue;
    }
    const x = pxX(i).toFixed(2);
    const y = pxY(v).toFixed(2);
    segs.push((pen === null ? 'M' : 'L') + x + ',' + y);
    pen = 'L';
  }

  // Vertical marker at iter=0 (burn-in -> accumulation transition for
  // SAEM/IMP). Render when burn-in is present and the trace reaches
  // (or crosses) the transition — `xMax >= 0` covers the SAEM-stopped-
  // exactly-at-iter-0 case where `next.sig` ended burn-in cleanly.
  if (xMin < 0 && xMax >= 0) {
    const x0 = padX + ((0 - xMin) / xRange) * (w - 2 * padX);
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    marker.setAttribute('x1', x0.toFixed(2));
    marker.setAttribute('y1', String(padY));
    marker.setAttribute('x2', x0.toFixed(2));
    marker.setAttribute('y2', String(h - padY));
    marker.setAttribute('class', 'convergence-svg-zero');
    svg.append(marker);
  }

  // Single finite point — SVG `M x,y` alone renders nothing; emit a
  // tiny circle so the user sees the data point exists.
  if (segs.length === 1) {
    const m = segs[0].match(/M([\d.]+),([\d.]+)/);
    if (m) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', m[1]);
      dot.setAttribute('cy', m[2]);
      dot.setAttribute('r', '1.5');
      dot.setAttribute('class', 'convergence-svg-line');
      svg.append(dot);
    }
  } else if (segs.length > 1) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', segs.join(' '));
    path.setAttribute('class', 'convergence-svg-line');
    svg.append(path);
  }
  return svg;
}

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
      const kind = c > 1000 ? 'bad' : c > 100 ? 'warn' : null;
      const tip = kind === 'bad'
        ? 'Cond > 1000 — COR matrix strongly ill-conditioned; suspect overparameterization.'
        : kind === 'warn'
          ? 'Cond > 100 — ill-conditioned COR matrix; check for highly-correlated parameters.'
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
function renderEstimationOptions(steps, tiersPerStep, lstEstRecords, lstTolerances, hasOde, hasLevel) {
  const outer = document.createElement('details');
  outer.className = 'xml-options';
  const sumOuter = document.createElement('summary');
  sumOuter.textContent = '$EST options (XML, exhaustive — '
    + steps.length + (steps.length === 1 ? ' step)' : ' steps)');
  outer.append(sumOuter);
  for (let i = 0; i < steps.length; i++) {
    const tiers = (tiersPerStep && tiersPerStep[i]) || {};
    const lstRecord = (lstEstRecords && lstEstRecords[i]) || null;
    outer.append(renderEstimationOptionsStep(steps[i], i + 1, tiers, lstRecord, lstTolerances, hasOde, hasLevel));
  }
  return outer;
}

// Tokens NM never emits in the XML even when user explicitly sets them,
// AND that we don't synthesize as their own attr row. PRINT, POSTHOC,
// ETABARCHECK, NUMERICAL, CENTERING are all synthesized via
// `synthesizeInvisibleAttrs` so they show up as proper rows. NOSORT
// remains here because SORT emits visible `objsort='yes'` (so the user
// can see the explicit case in the main table); only the NO-prefix /
// default state would otherwise be invisible.
const INVISIBLE_TOKEN_PATTERNS = [
  /^N?O?SORT$/i,
];

function isInvisibleToken(token) {
  return INVISIBLE_TOKEN_PATTERNS.some((re) => re.test(token));
}

/**
 * Doc-default values for $EST options that NM never emits to XML, plus
 * their method-applicability per Bauer's $EST docs. `applicable` is a
 * set of method-kind labels — `'all'` means universal. Empirically
 * verified universal at probe-attrs-survey/ where probes ran with FOCE.
 *
 * Method-conditional applicability (per Bauer's docs):
 *   - PRINT, POSTHOC, ETABARCHECK: universal (per user's all-methods list)
 *   - NUMERICAL: Laplacian-only (line 2935: "for the Laplacian method")
 *   - CENTERING: FOCE-only (line 2380: "May only be used with METHOD=1")
 *   - PARAFILE, PARAFPRINT, FPARAFILE: universal (parallel-processing knobs)
 */
const INVISIBLE_ATTR_DEFS = {
  print:        { default: '9999', applicable: 'all' },
  // POSTHOC is FO-only per Bauer line 3082 ("This option may be used when
  // the FO method is used") and the user's empirical experience. Pending
  // a probe (task #94 to verify across methods).
  posthoc:      { default: 'no',   applicable: 'fo' },
  etabarcheck:  { default: 'no',   applicable: 'all' },
  numerical:    { default: 'no',   applicable: 'laplace' },
  centering:    { default: 'no',   applicable: 'foce' },
  parafile:     { default: 'OFF',  applicable: 'all' },
  parafprint:   { default: '1',    applicable: 'all' },
  fparafile:    { default: 'OFF',  applicable: 'all' },
  // LEVCENTER/LEVOBJTYPE/LEVWT require $LEVEL record. Bauer says
  // "There is no default. Required with $LEVEL and $ESTIMATION" — so we
  // show empty value when $LEVEL present + user didn't type. The
  // `requiresLevel: true` flag tells the synthesiser to skip when no
  // $LEVEL record is in the control stream.
  levcenter:    { default: '',     applicable: 'all', requiresLevel: true },
  levobjtype:   { default: '',     applicable: 'all', requiresLevel: true },
  levwt:        { default: '',     applicable: 'all', requiresLevel: true },
};

// Convenience: doc defaults indexed by attr name, for tooltip lookups.
const INVISIBLE_ATTR_DEFAULTS = Object.fromEntries(
  Object.entries(INVISIBLE_ATTR_DEFS).map(([k, v]) => [k, v.default]),
);

/**
 * NMTRAN boolean toggle pairs — `[FLAG|NOFLAG]` syntax. NO-prefixed
 * token sets the value to 'no'; bare token sets to 'yes'.
 */
const BOOLEAN_TOGGLE_PATTERNS = {
  posthoc: /^(NO)?POSTHOC$/i,
  etabarcheck: /^(NO)?ETABARCHECK$/i,
  numerical: /^(NO)?NUMERICAL$/i,
  centering: /^(NO)?CENTERING$/i,
};

/**
 * KEY=VALUE-style invisibles. Token regex matches `KEY=...`; value is
 * the user-supplied right-hand side.
 */
const KV_INVISIBLE_PATTERNS = {
  print: /^PRINT=/i,
  parafile: /^PARAFILE=/i,
  parafprint: /^PARAFPRINT=/i,
  fparafile: /^FPARAFILE=/i,
  levcenter: /^LEVCENTER=/i,
  levobjtype: /^LEVOBJTYPE=/i,
  levwt: /^LEVWT=/i,
};

/**
 * Derive the method-kind label for a step from its XML attrs. Used to
 * gate method-conditional synthesised options.
 *   - 'em'      : estimation_method is one of the EM/MCMC labels
 *   - 'laplace' : classical with laplace='yes' (LAPLACIAN was specified)
 *   - 'foce'    : classical with cond_estim='yes' (METHOD=1 / FOCE)
 *   - 'fo'      : classical with no cond_estim (METHOD=0 / FO)
 */
function deriveMethodKind(step) {
  const m = (step.estimation_method ?? '').toLowerCase();
  if (m === 'imp' || m === 'impmap' || m === 'saem' || m === 'its'
      || m === 'direct' || m === 'bayes' || m === 'nuts'
      || m === 'mcmc' || m === 'chain' || m === 'sir') {
    return 'em';
  }
  if (step.laplace === 'yes') return 'laplace';
  if (step.cond_estim === 'yes') return 'foce';
  return 'fo';
}

/**
 * Whether a synthesised attr applies to the given context (method +
 * model features). Returns false when:
 *   - the attr's method-applicability doesn't match (e.g. CENTERING
 *     when methodKind is 'em')
 *   - the attr requires $LEVEL but the model has no $LEVEL record
 */
function attrAppliesToContext(attr, methodKind, hasLevel) {
  const def = INVISIBLE_ATTR_DEFS[attr];
  if (!def) return true;
  if (def.requiresLevel && !hasLevel) return false;
  if (def.applicable === 'all') return true;
  return def.applicable === methodKind;
}

/**
 * Build a synthetic-attr overlay for the step from the user's verbatim
 * $EST tokens. Returns {value, isUserSet, inapplicable} per attr.
 * Method-conditional attrs (NUMERICAL/CENTERING) are skipped from the
 * overlay when inapplicable to the current method AND the user didn't
 * type them. When inapplicable AND user typed → included with
 * `inapplicable: true` so the renderer can flag the warning.
 */
function synthesizeInvisibleAttrs(userTokens, methodKind, hasLevel) {
  const out = {};
  // KV-style: PRINT, PARAFILE, PARAFPRINT, FPARAFILE, LEVCENTER, ...
  for (const [attr, re] of Object.entries(KV_INVISIBLE_PATTERNS)) {
    const match = userTokens.find((t) => re.test(t));
    const applies = attrAppliesToContext(attr, methodKind, hasLevel);
    if (match) {
      out[attr] = {
        value: match.split('=')[1] || '',
        isUserSet: true,
        inapplicable: !applies,
      };
    } else if (applies) {
      out[attr] = {
        value: INVISIBLE_ATTR_DEFS[attr].default,
        isUserSet: false,
        inapplicable: false,
      };
    }
    // else: not user-typed AND inapplicable → skip the row entirely.
  }
  // Boolean toggles.
  for (const [attr, re] of Object.entries(BOOLEAN_TOGGLE_PATTERNS)) {
    const match = userTokens.find((t) => re.test(t));
    const applies = attrAppliesToContext(attr, methodKind, hasLevel);
    if (match) {
      const isNegated = /^NO/i.test(match);
      out[attr] = {
        value: isNegated ? 'no' : 'yes',
        isUserSet: true,
        inapplicable: !applies,
      };
    } else if (applies) {
      out[attr] = {
        value: INVISIBLE_ATTR_DEFS[attr].default,
        isUserSet: false,
        inapplicable: false,
      };
    }
  }
  return out;
}

/**
 * Map a `<nm:estimation_options>` attr to its runtime-resolved value.
 * Prefers the `.lst` trace (most authoritative — reflects the actual
 * runtime value after $EST/$SUBROUTINES overrides). Falls back to the
 * documented Bauer default when the trace is absent (non-ODE models
 * don't emit BASE/EST TOLERANCE blocks). Returns null when no
 * translation applies.
 *
 * Caveat for the fallback: a user-supplied `$SUBROUTINES ATOL=N`
 * override would not be detected without the .lst trace; the inspector
 * would show the doc default `12`. Better than leaking the sentinel.
 */
function resolveEstAttrFromLst(key, value, tolerances) {
  // atol='0' is the wire sentinel for "user didn't set on $EST".
  // Effective value: $SUBROUTINES ATOL (if set) → built-in default 12.
  if (key === 'atol' && value === '0') {
    return (tolerances && (tolerances.estAnrd || tolerances.baseAnrd)) || '12';
  }
  return null;
}

/**
 * Map a `<nm:problem_options>` cov_* attr to its runtime-resolved
 * value. Same trace-prefer-then-doc-fallback pattern as $EST. Returns
 * null when no translation applies.
 */
function resolveCovAttrFromLst(key, value, tolerances) {
  if (key === 'atol' && value === '-1') {
    // cov_atol='-1' inherits from $EST atol (and chain → $SUBROUTINES →
    // built-in 12). Use covAnrd from .lst trace when available; else
    // fall back to the documented Bauer default.
    return (tolerances && tolerances.covAnrd) || '12';
  }
  if (key === 'tol' && value === '-1') {
    return tolerances && tolerances.covNrd;
  }
  return null;
}

function renderEstimationOptionsStep(step, stepNum, tierMap, lstRecord, lstTolerances, hasOde, hasLevel) {
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
  // XML attrs ∪ synthesised.
  const methodKind = deriveMethodKind(step);
  const synthetic = synthesizeInvisibleAttrs(userTokens, methodKind, !!hasLevel);
  const userWroteAtol = userTokens.some((t) => /^ATOL=/i.test(t));
  const merged = { ...step };
  // Filter ATOL from XML when ODE is not used AND user didn't type it.
  // NM always emits atol='0' even for non-ODE models, but the value is
  // irrelevant. Hide rather than mislead.
  if (!hasOde && !userWroteAtol && merged.atol === '0') {
    delete merged.atol;
  }
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
    let cls = 'xml-options-val';
    let tip;
    // v0.0.181 tier scheme: blue (explicit) / blue-italic
    // (explicit-matches-default) / orange (implicit). The tier-map is
    // computed payload-side via classifyEstStep — single source of truth.
    const synthEntry = synthetic[k];
    if (synthEntry !== undefined) {
      // Synthesised invisible attrs — tier based on isUserSet, doc-default
      // match, and method-applicability.
      if (synthEntry.isUserSet) {
        const matchesDocDefault = synthEntry.value === INVISIBLE_ATTR_DEFAULTS[k];
        cls += matchesDocDefault
          ? ' xml-options-val--explicit-default'
          : ' xml-options-val--explicit';
        tip = 'User-typed (NM never emits this to XML; synthesized from .lst echo). Default per Bauer: ' + INVISIBLE_ATTR_DEFAULTS[k] + (matchesDocDefault ? ' — matches default.' : '.');
        if (synthEntry.inapplicable) {
          // Method-applicability warning (e.g. CENTERING typed on SAEM —
          // doc says METHOD=1 only; POSTHOC on non-FO — empirically
          // verified silently ignored).
          const applicableTo = INVISIBLE_ATTR_DEFS[k].applicable;
          if (k === 'posthoc') {
            tip += ' WARNING: POSTHOC/NOPOSTHOC only meaningfully apply to METHOD=ZERO (FO). Empirically verified: other methods compute posthoc etas implicitly regardless of the option, NM 7.6.0.';
          } else {
            tip += ' WARNING: this option only applies to ' + applicableTo.toUpperCase() + ' methods; the current step uses ' + methodKind.toUpperCase() + '. NM silently ignores it.';
          }
        }
      } else {
        tip = 'Documented default per Bauer (NM never emits this to XML). Synthesized for visibility.';
      }
    } else {
      const tier = tierMap[k];
      if (tier === 'explicit') {
        cls += ' xml-options-val--explicit';
        tip = 'Explicitly set on this $EST line (.lst echo).';
      } else if (tier === 'explicitDefault') {
        cls += ' xml-options-val--explicit-default';
        tip = 'Explicitly set on this $EST line, but the value matches the method default — has no effect vs. omitting it.';
      } else if (tier === 'implicit') {
        cls += ' xml-options-val--implicit';
        tip = 'Implicitly set — value differs from default, but the user did NOT type it on this $EST line. Set by AUTO=N\'s per-method overrides or propagated from a prior $EST step.';
      }
    }
    // Special-case `abort='no'`: XML conflates NOABORT/NOHABORT.
    if (k === 'abort' && merged[k] === 'no') {
      if (userWroteNohabort) {
        tip = 'NOHABORT: positive definite correction at all levels of the estimation. More aggressive than NOABORT — can hide ill-posed problems. (XML wire: abort=\'no\' — same as NOABORT)';
      } else if (userWroteNoabort) {
        tip = 'NOABORT: theta-recovery + force most non-PD Hessian matrices to be PD. (XML wire: abort=\'no\' — same as NOHABORT)';
      } else {
        tip = (tip || '') + ' (XML wire abort=\'no\' is shared by NOABORT and NOHABORT; .lst echo absent — can\'t disambiguate.)';
      }
    }
    // Wire-vs-runtime translation. ATOL='0' is a sentinel — display
    // the resolved runtime ANRD from the .lst trace as the cell value.
    // Tooltip preserves the wire format for transparency.
    let displayValue = merged[k];
    const resolved = resolveEstAttrFromLst(k, merged[k], tolerances);
    if (resolved && resolved !== merged[k]) {
      displayValue = resolved;
      const note = ' (XML wire: \'' + merged[k] + '\' — sentinel for the built-in default; effective runtime value ' + resolved + ' from .lst trace.)';
      tip = (tip || '') + note;
    }
    // PsN-wrapper detection on `file` attr: PsN's execute renames the
    // FILE= option to psn.ext in the wrapped control stream. Annotate
    // ONLY when the user did NOT explicitly type FILE= — i.e. tier is
    // 'implicit'. If the user did write FILE=psn.ext intentionally
    // (unusual but valid), it's their choice and the wrapper note
    // would be wrong.
    if (k === 'file' && /^psn\.ext$/i.test(merged[k]) && tierMap[k] === 'implicit') {
      const note = ' (PsN\'s execute wrapper rewrites the FILE= option to psn.ext in the wrapped control stream — not the modeller\'s choice.)';
      tip = (tip || '') + note;
    }
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
 * Per-`$COV`-record option dump from sibling `.xml`'s
 * `<nm:problem_options>` element's `cov_*` attrs. NM 7.6.0 does NOT
 * emit a dedicated `<nm:covariance_options>` element — empirically
 * confirmed by probing on host. Single-block (one $COV per problem),
 * not per-step like $EST. Closed by default.
 *
 * Four-tier classification (computed payload-side in xml-cov-defaults.ts;
 * absent keys render as default):
 *   userDriven  (green) : differs from `BLANK`/identity default
 *   propagated  (yellow): `-1` AND $EST sibling is non-default
 *   nonDefault  (blue)  : differs from empirical baseline
 *   (default, normal)   : matches baseline
 */
const COV_TIER_TIPS = {
  userDriven: 'User-driven: differs from the not-set default (e.g. SIRSAMPLE was actually requested, FILE was set, SEED differs from 11456).',
  propagated: 'Propagated: -1 sentinel AND the corresponding $EST option is user-customised. Effective value is whatever $EST says.',
  nonDefault: 'Non-default: differs from the empirical baseline (probed against NM 7.6.0).',
};

// Doc-default values for $COV options that NM never (or conditionally)
// emits to XML. Boolean-toggle pairs use the NMTRAN `[FLAG|NOFLAG]`
// convention.
//
// `special` is a conditional case — bare $COV emits cov_special='no'
// (visible), but `$COV MATRIX=R` SUPPRESSES it from XML emission
// (empirically verified at probe-cov-survey/matrix_r, NM 7.6.0). The
// synthesis is additive (only adds when XML doesn't carry the key) so
// we surface SPECIAL even when MATRIX=R hides it. Bauer's doc warning
// "MATRIX=R should not be used with SPECIAL" is reflected via a tooltip
// annotation on the synthesized row.
const INVISIBLE_COV_DEFAULTS = {
  conditional: 'yes',     // CONDITIONAL is default; UNCONDITIONAL is the toggle
  parafile: 'OFF',        // PARAFILE=OFF default per Bauer
  parafprint: '1',        // PARAFPRINT=1 default
  special: 'no',          // suppressed from XML when MATRIX=R; surface here
};

const INVISIBLE_COV_TOKEN_PATTERNS = {
  conditional: [
    { re: /^CONDITIONAL$/i, value: 'yes' },
    { re: /^UNCONDITIONAL$/i, value: 'no' },
  ],
  parafile: [{ re: /^PARAFILE=/i, value: null /* extract from `=` */ }],
  parafprint: [{ re: /^PARAFPRINT=/i, value: null }],
  special: [{ re: /^SPECIAL$/i, value: 'yes' }],
};

/**
 * Build synthetic-attr overlay for the $COV step. Surfaces options NM
 * never emits to XML (CONDITIONAL, PARAFILE, PARAFPRINT) with their
 * documented defaults or the user's value when typed. Includes
 * `special` (conditionally emitted: suppressed by MATRIX=R per NM
 * 7.6.0 empirical).
 *
 * Caller decides whether to merge additively (only fill missing keys)
 * or overwrite — see `renderCovarianceOptions`.
 */
function synthesizeInvisibleCovAttrs(covTokens) {
  const out = {};
  for (const [attr, patterns] of Object.entries(INVISIBLE_COV_TOKEN_PATTERNS)) {
    let matched = false;
    for (const p of patterns) {
      const match = covTokens.find((t) => p.re.test(t));
      if (match) {
        const value = p.value !== null
          ? p.value
          : (match.split('=')[1] || '');
        out[attr] = { value, isUserSet: true };
        matched = true;
        break;
      }
    }
    if (!matched) {
      out[attr] = { value: INVISIBLE_COV_DEFAULTS[attr], isUserSet: false };
    }
  }
  return out;
}

function renderCovarianceOptions(opts, tiersMap, resolvedMap, lstTolerances, lstCovRecord, hasOde) {
  const outer = document.createElement('details');
  outer.className = 'xml-options';
  const sumOuter = document.createElement('summary');

  // Synthesize invisible $COV options. ADDITIVE merge — only fills
  // keys missing from XML (e.g. cov_special when MATRIX=R suppresses
  // it). When XML carries the key, trust the wire value.
  const covTokens = lstCovRecord && lstCovRecord.tokens ? lstCovRecord.tokens : [];
  const synthetic = synthesizeInvisibleCovAttrs(covTokens);
  const userWroteAtolCov = covTokens.some((t) => /^ATOL=/i.test(t));
  const userWroteTolCov = covTokens.some((t) => /^TOL=/i.test(t));
  const merged = { ...opts };
  // Filter cov_atol/cov_tol when ODE not used AND user didn't type them
  // on $COV. NM emits cov_atol='-1' regardless; for non-ODE models the
  // value is irrelevant.
  if (!hasOde && !userWroteAtolCov && merged.atol === '-1') delete merged.atol;
  if (!hasOde && !userWroteTolCov && merged.tol === '-1') delete merged.tol;
  // Track which keys were FILLED by synthesis (vs. present in XML) so
  // the renderer can decide whether to apply quirk annotations.
  const filledBySynthesis = new Set();
  for (const k of Object.keys(synthetic)) {
    if (!(k in merged)) {
      merged[k] = synthetic[k].value;
      filledBySynthesis.add(k);
    }
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
    let cls = 'xml-options-val';
    let tip;

    // Unified tier scheme (explicit/explicitDefault/implicit) mirroring
    // $EST. Synthesised invisible-options use their own
    // matches-doc-default classification path; XML-emitted attrs use
    // the `tiersMap` (produced by `classifyCovStep`).
    const synthEntry = synthetic[k];
    // Apply synthesis-tier only when XML didn't already carry this key
    // (additive merge). For `special` specifically, XML carries it
    // unless MATRIX=R suppresses it; in the present-in-XML case fall
    // through to the tier-map.
    if (synthEntry !== undefined && filledBySynthesis.has(k)) {
      if (synthEntry.isUserSet) {
        const matchesDocDefault = synthEntry.value === INVISIBLE_COV_DEFAULTS[k];
        cls += matchesDocDefault
          ? ' xml-options-val--explicit-default'
          : ' xml-options-val--explicit';
        tip = 'User-typed on $COV (NM didn\'t emit this to XML for this run; synthesized from .lst echo). Default per Bauer: ' + INVISIBLE_COV_DEFAULTS[k] + (matchesDocDefault ? ' — matches default.' : '.');
        // MATRIX=R + SPECIAL quirk: NM silently suppresses SPECIAL when
        // MATRIX=R is in effect. The user typed it; NM ignored it.
        // Bauer warns "MATRIX=R should not be used with SPECIAL".
        if (k === 'special' && matrixIsR) {
          tip += ' WARNING: NM silently ignores SPECIAL when MATRIX=R is used (empirically verified, NM 7.6.0; Bauer\'s docs warn against this combination). Setting has no effect.';
        }
      } else {
        tip = 'Documented default per Bauer (NM didn\'t emit this to XML). Synthesized for visibility.';
      }
    } else {
      const tier = tiersMap && tiersMap[k];
      if (tier === 'explicit') {
        cls += ' xml-options-val--explicit';
        tip = 'Explicitly set on the $COV line (.lst echo).';
      } else if (tier === 'explicitDefault') {
        cls += ' xml-options-val--explicit-default';
        tip = 'Explicitly set on the $COV line, but value matches the default — no effect vs. omitting it.';
      } else if (tier === 'implicit') {
        cls += ' xml-options-val--implicit';
        tip = 'Implicitly set — value differs from default, but the user did NOT type it on the $COV line. Likely inherited from $EST or set by method-default (e.g. cov_posdef=3 for EM).';
      }
    }

    // Wire→runtime translation (sentinel values → resolved).
    let displayValue = merged[k];
    const resolved = resolvedMap[k] || resolveCovAttrFromLst(k, merged[k], lstTolerances);
    if (resolved && resolved !== merged[k]) {
      displayValue = resolved;
      const note = ' (XML wire: \'' + merged[k] + '\' — sentinel; effective runtime value ' + resolved + ' — inherited from $EST / $SUBROUTINES / method default.)';
      tip = (tip || '') + note;
    }
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
  // inspector. Detect via the suffix so we don't need a separate field.
  if (s.lst && s.lst.methodShort && s.lst.methodShort.endsWith('-eval')) {
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
  const wrap = document.createElement('span');
  wrap.className = 'meta';
  let any = false;
  const append = (node) => {
    if (any) wrap.append(' · ');
    else wrap.append('· ');
    wrap.append(node);
    any = true;
  };
  if (sumo && sumo.totalRuntime) {
    let s = 'runtime ' + sumo.totalRuntime;
    if (typeof sumo.estimationSeconds === 'number') s += ' (est ' + fmtNum(sumo.estimationSeconds) + 's)';
    append(document.createTextNode(s));
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
    append(metaPart(label, kind, tip));
  }
  // SAEM / BAYES: stationary acceptance rate. No threshold-coloring —
  // healthy range varies by sampler. Surface as plain text.
  if (lst && typeof lst.acceptanceRate === 'number') {
    append(document.createTextNode('accept ' + fmtNum(lst.acceptanceRate)));
  }
  if (sumo && typeof sumo.observations === 'number') {
    append(document.createTextNode(sumo.observations + ' obs'));
  }
  if (sumo && typeof sumo.individuals === 'number') {
    append(document.createTextNode(sumo.individuals + ' subj'));
  }
  return any ? wrap : null;
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

function renderSection(title, rows, hasFit, kind, showLabel = true) {
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
    const ie = r.impliedInit && typeof r.init === 'number' && isFinite(r.init)
      ? impliedInitCell(r.init)
      : r.init;
    if (!hasFit) return [...head, lb, ie, ub];
    const valueCell = renderValueCell(r, kind, hasFit, diagBaseValues);
    // RSE source: ALWAYS prefer NONMEM's authoritative SD/corr-form
    // (`-1000000005`) when present, regardless of the `√Ω/ρ` display
    // toggle. RSE is unit-free — it's intrinsically on the SD/corr
    // scale for OMEGA / SIGMA, and the cvse/2 fallback is mathematically
    // wrong for off-diagonals (treats correlations like diagonals).
    // The toggle is purely a display choice for the FE column.
    // cvse/2 only used when `-1000000005` is absent (old NONMEM / no $COV).
    const isOmegaOrSigma = kind === 'omega' || kind === 'sigma';
    const rseValue =
      isOmegaOrSigma && typeof r.rseStdcorr === 'number' ? r.rseStdcorr : r.rse;
    const rseCell = fmtRse(rseValue, kind);
    const nsdCell = fmtNsd(r.numSigDig);
    const base = [...head, lb, ie, ub, valueCell, rseCell, nsdCell];
    if (!hasShrinkData) {
      base.push(null);
      return base;
    }
    const shrink = matrixIsDiagonal(r.name) ? shrinkSdByIndex[r.index - 1] : undefined;
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

// Hover-tooltips for the short column headers — pharmacometric
// abbreviations aren't universally familiar.
const COL_TITLES = {
  '#': 'Parameter index (or matrix subscript for OMEGA/SIGMA off-diagonals). Hover the cell for the full access key.',
  Label: 'Inline `;<comment>` from the .mod source line — Pirana convention. `$THETA 4.79 ;CL` → "CL".',
  LB: 'Lower bound from `$THETA (lb, ie, ub)`. Em-dash for OMEGA/SIGMA — vscode-nmtran does not yet expose those bounds.',
  IE: 'Initial estimate from the .mod (or the .lst\'s embedded control stream in lst-mode).',
  UB: 'Upper bound from `$THETA (lb, ie, ub)`. Em-dash for OMEGA/SIGMA.',
  FE: 'Final estimate (lst-mode only). Affected by the √Ω/ρ and exp(θ) toggles in the section heading.',
  Value:
    'Final estimate in lst-mode, initial estimate in mod-mode. Affected by the √Ω / exp(θ) toggles.',
  '(RSE%)':
    'Relative standard error. THETA: SE/|estimate|. OMEGA / SIGMA: (SE/variance)/2 — relative SE on the standard-deviation scale (sumo default sd_rse=1 convention).',
  '[Shrinkage%]':
    'ETA shrinkage on the standard-deviation scale, ETASHRINKSD(%) from the .lst. Values above 30% (configurable in `positronNonmem.shrinkageWarnPct`) suggest the random effect is poorly informed by the data.',
  Fixed: '$THETA / $OMEGA / $SIGMA FIX flag',
  Name: 'Parameter access key (matches `.ext` columns)',
  ETABAR: 'Arithmetic mean of the ETA-estimates',
  'P VAL.':
    "NONMEM's two-sided significance test for ETABAR ≠ 0. Small p (< 0.05) flags an ETA whose mean differs from zero — typically a structural model mis-specification or an omitted covariate.",
  'Shrinkage (SD)':
    'ETA / EPS shrinkage on the standard-deviation scale, ETASHRINKSD(%) / EPSSHRINKSD(%) from the .lst. Values above 30% (configurable in `positronNonmem.shrinkageWarnPct`) suggest that the random effect is poorly informed by the data.',
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
    } else if (c instanceof HTMLElement) {
      td.append(c);
    } else if (typeof c === 'number') {
      td.textContent = fmtNum(c);
    } else {
      td.textContent = String(c);
    }
    tr.append(td);
  });
  return tr;
}

vscode.postMessage({ type: 'ready' });

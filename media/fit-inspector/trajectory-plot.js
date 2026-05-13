// trajectory-plot.js — Convergence trajectory subsystem for the Fit
// Inspector. Renders one collapsible <details> block per chained $EST
// step; each block carries an OFV line plot full-width on top, then a
// grid of per-parameter sparklines below. Per-block start-iter slider
// crops early burn-in / huge-OFV swings so trends near convergence
// stay legible.
//
// Public entry: `renderTrajectories(trajectories, xmlResults, xmlOpts,
// methodKinds)` — called once per `render()` from client.js.
//
// External dependencies (resolved via globalThis at function-call time
// in WebView; same in Node tests via the require-bridge in client.js):
//   - `terminationCodeLabel`, `fmtNum` from formatters.js
//
// All-DOM / all-SVG. CSP-safe: `createElement` / `createElementNS` /
// `textContent` / `setAttribute` only — no innerHTML.

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
function renderTrajectories(trajectories, xmlResults, xmlOpts, methodKinds) {
  const wrap = document.createElement('details');
  wrap.className = 'convergence';
  wrap.open = trajectories.length === 1;
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = 'Convergence trajectory (' + trajectories.length
    + (trajectories.length === 1 ? ' $EST step)' : ' $EST steps)');
  wrap.append(summaryEl);
  for (let i = 0; i < trajectories.length; i++) {
    const stepOpts = (xmlOpts && xmlOpts[i]) || null;
    const methodKind = (methodKinds && methodKinds[i]) || null;
    wrap.append(renderTrajectoryStep(trajectories[i], xmlResults[i] || null, stepOpts, methodKind));
  }
  return wrap;
}

function renderTrajectoryStep(t, xmlResult, stepOpts, methodKind) {
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
    // `typeof === 'number'` (not `!== null`) — older payloads / a
    // missing XML attr ship `undefined` here, which the `!== null`
    // check let through, then `terminationCodeLabel(undefined, …)`
    // rendered "termination: undefined" as a red cell.
    if (typeof xmlResult.terminationStatus === 'number') {
      // Method-aware termination labels: EM uses NM73+ documented
      // codes (0/8 = completed, 1/9 = ran out of iters, ...);
      // classical methods use arbitrary FORTRAN error numbers.
      // methodKind comes from payload (xml-est-defaults.ts is the
      // single source of truth for the EM-method list).
      // Collapse to binary for terminationCodeLabel which expects
      // 'em' | 'classical'.
      const codeMethodKind = methodKind === 'em' ? 'em' : methodKind ? 'classical' : null;
      const code = xmlResult.terminationStatus;
      const ok = codeMethodKind === 'em' ? (code === 0 || code === 8) : code === 0;
      const label = terminationCodeLabel(code, codeMethodKind);
      const span = document.createElement('span');
      span.className = ok ? 'meta-good' : 'meta-bad';
      span.textContent = 'termination: ' + label;
      parts.push(span);
    }
    if (typeof xmlResult.burninTime === 'number') {
      parts.push(document.createTextNode('burn-in ' + fmtNum(xmlResult.burninTime) + 's'));
    }
    if (typeof xmlResult.elapsedTime === 'number') {
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
  //
  // Trade-off acknowledged (6th-review FIR6): the measure pass inside
  // `tuneGridColumns` forces one synchronous layout per frame because
  // trace-suffix widths shift with the iteration window (early iters
  // print wider OFVs). At ≤20 params per model — the pharmacometric
  // ceiling — this is single-digit ms per frame and unnoticeable on
  // modern hardware. ResizeObserver wouldn't help: it triggers on
  // container size change, not content width change. If we ever need
  // to optimise further, the right move is caching colWidth across
  // ticks and skipping Phase 2 when the new measurement is ≤5px wider
  // than the cached value — keeps the visible width stable for tiny
  // value drift.
  // Capture `idx` once per `input` event and forward to renderPlots —
  // re-reading `slider.value` inside the rAF callback would let a fast
  // drag land a different value between label-set and render-call,
  // causing one-frame label/plot disagreement at the edges.
  let pendingFrame = false;
  let pendingIdx = defaultStartIdx;
  slider.addEventListener('input', () => {
    pendingIdx = Number(slider.value);
    sliderVal.textContent = String(t.iterations[pendingIdx] ?? 0);
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(() => {
      pendingFrame = false;
      renderPlots(pendingIdx);
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

// Dual-mode export: WebView shares scope across <script> tags; Node /
// vitest needs the explicit globalThis mirror so other files (e.g.
// `client.js`) imported as separate CJS modules can resolve names.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderTrajectories,
    renderTrajectoryStep,
    renderSparklineCell,
    tuneGridColumns,
    renderSparkline,
  };
  Object.assign(globalThis, module.exports);
}

// Fit Inspector WebView client.
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
let thresholds = { shrinkageWarnPct: 30, rseWarnPct: 100 };

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
  // Toggles only useful for parameter sections — show them whenever
  // there's at least one decl, in either mode (the transforms apply
  // to init values too).
  if (payload.thetas.length || payload.omegas.length || payload.sigmas.length) {
    root.append(renderToggles());
  }
  let rendered = false;
  if (payload.thetas.length) { root.append(renderSection('Theta', payload.thetas, hasFit, 'theta')); rendered = true; }
  if (payload.omegas.length) { root.append(renderSection('Omega', payload.omegas, hasFit, 'omega')); rendered = true; }
  if (payload.sigmas.length) { root.append(renderSection('Sigma', payload.sigmas, hasFit, 'sigma')); rendered = true; }
  if (payload.diagnostics) root.append(renderDiagnostics(payload.diagnostics));
  if (!rendered && !payload.summary && !payload.runNotes) {
    root.append(emptyMessage('Model has no parameter declarations.'));
  }
}

/**
 * Display-preference toggles: `√Ω` (SD scale for OMEGA/SIGMA) and
 * `exp(θ)` (exponentiate THETA, useful when THETA is on the log
 * scale). State persists via vscode.setState; toggling re-renders
 * `lastPayload` in place — no extension round trip.
 */
function renderToggles() {
  const wrap = document.createElement('div');
  wrap.className = 'toggles';
  wrap.append(
    toggleEl(
      'sqrtOm',
      '√Ω',
      'Display OMEGA/SIGMA on the SD scale: diagonals → SD = √variance, off-diagonals → correlation (cov/√(var_i·var_j)). Matches the sumo / xpose convention.',
    ),
    toggleEl('expTh', 'exp(θ)', 'Exponentiate THETA estimates (useful when THETA is on the log scale)'),
  );
  return wrap;
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
    tag.className = d.termination === 'SUCCESSFUL' ? 'ok' : 'term';
    // Use the verbatim phrase NONMEM emitted (e.g. "OPTIMIZATION WAS
    // COMPLETED" for SAEM/BAYES vs "MINIMIZATION SUCCESSFUL" for
    // FOCE) so the label reflects the actual estimation method.
    // Fall back to a synthesised label if the phrase wasn't captured.
    tag.textContent = d.terminationPhrase || 'MINIMIZATION ' + d.termination;
    line.append(tag);
    wrap.append(line);
    if (d.terminationReason) {
      const reason = document.createElement('div');
      reason.className = 'diag-reason';
      reason.textContent = d.terminationReason;
      wrap.append(reason);
    }
  }
  if (d.eigenvalues) {
    // Condition number lives in the summary meta line (from sumo);
    // not repeated here. Show signed min/max so a negative
    // eigenvalue (non-PD COR matrix) is visible.
    const line = document.createElement('div');
    line.className = 'diag-line';
    line.textContent =
      'Eigenvalues: min ' + fmtNum(d.eigenvalues.min) +
      ' · max ' + fmtNum(d.eigenvalues.max);
    wrap.append(line);
  }
  if (d.etabar.length || d.etaShrinkSd.length) {
    wrap.append(renderShrinkageTable('ETA', d.etaShrinkSd, d.etabar));
  }
  if (d.epsShrinkSd.length) {
    wrap.append(renderShrinkageTable('EPS', d.epsShrinkSd));
  }
  if (d.prderr) {
    wrap.append(renderPrderr(d.prderr));
  }
  return wrap;
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
 * column (mean of the EBE estimates); EPS does not (it isn't
 * meaningful per the NONMEM error model). When `etabar` is omitted
 * the table collapses to `Name | Shrinkage (SD)`.
 */
function renderShrinkageTable(label, shrinkSd, etabar) {
  const n = Math.max(shrinkSd.length, etabar ? etabar.length : 0);
  const wrap = document.createElement('div');
  wrap.className = 'section';
  wrap.append(subHeader(label));
  const cols = etabar ? ['Name', 'ETABAR', 'Shrinkage (SD)'] : ['Name', 'Shrinkage (SD)'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const name = label + '(' + (i + 1) + ')';
    rows.push(
      etabar
        ? [name, etabar[i] ?? null, fmtShrinkage(shrinkSd[i])]
        : [name, fmtShrinkage(shrinkSd[i])],
    );
  }
  wrap.append(sectionEl('', cols, rows, []));
  return wrap;
}

/**
 * Shrinkage formatted as `XX.XX%`. Returns a `.bad` span when above
 * `thresholds.shrinkageWarnPct` (configurable; default 30) so the
 * renderer can drop it into the table cell as-is.
 */
function fmtShrinkage(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const text = v.toFixed(2) + '%';
  return v > thresholds.shrinkageWarnPct ? badge(text, 'bad') : text;
}

/** Build a `<span class="…">text</span>`. Reused by RSE / shrinkage threshold colouring. */
function badge(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function subHeader(text) {
  const h = document.createElement('h4');
  h.textContent = text;
  h.style.fontSize = '11px';
  h.style.fontWeight = '500';
  h.style.margin = '6px 0 2px 0';
  h.style.color = 'var(--vscode-descriptionForeground)';
  return h;
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
  if (s.lst && s.lst.methodShort) {
    const tag = document.createElement('span');
    tag.className = 'method';
    tag.textContent = s.lst.methodShort;
    if (s.lst.method) tag.title = s.lst.method;
    top.append(tag);
  }
  if (s.ofv !== null && s.ofv !== undefined) {
    const ofv = document.createElement('span');
    ofv.className = 'ofv';
    ofv.textContent = 'OFV = ' + fmtNum(s.ofv);
    top.append(ofv);
  }
  const meta = metaLine(s.sumo, s.lst);
  if (meta) {
    const span = document.createElement('span');
    span.className = 'meta';
    span.textContent = meta;
    top.append(span);
  }
  div.append(top);
  if (s.sumo && s.sumo.statuses && s.sumo.statuses.length) {
    div.append(renderStatuses(s.sumo.statuses));
  }
  return div;
}

function metaLine(sumo, lst) {
  const parts = [];
  if (sumo && sumo.totalRuntime) {
    let s = 'runtime ' + sumo.totalRuntime;
    if (typeof sumo.estimationSeconds === 'number') s += ' (est ' + fmtNum(sumo.estimationSeconds) + 's)';
    parts.push(s);
  }
  if (lst && typeof lst.sigDigits === 'number') parts.push('sig-digits ' + fmtNum(lst.sigDigits));
  // SAEM / BAYES: stationary acceptance rate. Tooltip-like hint via
  // ranges would be nice but VS Code WebView doesn't easily style
  // partial text — leave as raw value for now.
  if (lst && typeof lst.acceptanceRate === 'number') parts.push('accept ' + fmtNum(lst.acceptanceRate));
  if (sumo && typeof sumo.conditionNumber === 'number') parts.push('cond ' + fmtNum(sumo.conditionNumber));
  if (sumo && typeof sumo.observations === 'number') parts.push(sumo.observations + ' obs');
  if (sumo && typeof sumo.individuals === 'number') parts.push(sumo.individuals + ' subj');
  return parts.length ? '· ' + parts.join(' · ') : '';
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

function renderSection(title, rows, hasFit, kind) {
  // Pirana compact layout: `# | Label | Value | (RSE%) | [Shrinkage%]`.
  //  - `#`: index for diagonals (THETA(1) → "1", OMEGA(1,1) → "1");
  //         subscript for off-diagonals (OMEGA(2,1) → "2,1").
  //  - `Value`: lst-mode = final, mod-mode = init. Toggles transform:
  //         `exp(θ)` exponentiates THETA, `√Ω` rescales OMEGA/SIGMA —
  //         diagonals → SD (sqrt(variance)); off-diagonals →
  //         correlation (cov / sqrt(var_i * var_j)). Computed
  //         per-section using a diagonal lookup so off-diagonals get
  //         the right denominators.
  //  - `(RSE%)` only in lst-mode; PsN sumo's default sd_rse=1 convention
  //         (the ratio is dimensionless so the scale toggles don't
  //         change it).
  //  - `[Shrinkage%]` only on Omega rows in lst-mode.
  const isOmega = kind === 'omega';
  const cols = hasFit
    ? isOmega
      ? ['#', 'Label', 'Value', '(RSE%)', '[Shrinkage%]']
      : ['#', 'Label', 'Value', '(RSE%)']
    : ['#', 'Label', 'Value'];
  const shrinkSdByIndex = collectEtaShrinkages();
  const diagBaseValues = buildDiagBaseValues(rows, hasFit);
  const cellsForRow = (r) => {
    const valueCell = renderValueCell(r, kind, hasFit, diagBaseValues);
    if (!hasFit) return [indexCell(r.name), r.label, valueCell];
    const rseCell = wrapParens(fmtRse(r.rse));
    if (!isOmega) return [indexCell(r.name), r.label, valueCell, rseCell];
    const shrink = matrixIsDiagonal(r.name) ? shrinkSdByIndex[r.index - 1] : undefined;
    return [indexCell(r.name), r.label, valueCell, rseCell, wrapBrackets(fmtShrinkage(shrink))];
  };
  const rowCells = rows.map(cellsForRow);
  const rowAttrs = rows.map((r) => ({ declLine: r.declLine, fixed: r.fixed }));
  return sectionEl(title, cols, rowCells, rowAttrs, 'param-table');
}

/**
 * Build `i -> diagonal variance` lookup for the current OMEGA / SIGMA
 * section. Used by the `√Ω` toggle to compute correlations for off-
 * diagonals (`cov(i,j) / sqrt(var_i * var_j)`). Uses `final` in lst-
 * mode and `init` in mod-mode so the toggle behaves the same in both.
 * Returns an empty Map when no rows match — `transformValue` falls
 * back to the raw value in that case.
 */
function buildDiagBaseValues(rows, hasFit) {
  const out = new Map();
  for (const r of rows) {
    const m = r.name.match(/\((\d+),(\d+)\)$/);
    if (!m || m[1] !== m[2]) continue;
    const v = hasFit ? r.final : r.init;
    if (typeof v === 'number' && isFinite(v)) out.set(Number(m[1]), v);
  }
  return out;
}

/**
 * Pull ETA shrinkages from the diagnostics block so we can interleave
 * the per-OMEGA `[Shrinkage%]` column with the parameter rows. Returns
 * an empty array when no fit / no diagnostics — caller's [i-1] lookup
 * yields undefined, fmtShrinkage handles it.
 */
function collectEtaShrinkages() {
  return (lastPayload && lastPayload.diagnostics && lastPayload.diagnostics.etaShrinkSd) || [];
}

function matrixIsDiagonal(name) {
  const m = name.match(/\((\d+),(\d+)\)$/);
  return !!m && m[1] === m[2];
}

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
  const v = transformValue(base, kind, r.name, diagBaseValues);
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

/**
 * Apply the active display preferences to a parameter value.
 *
 *  - `exp(θ)` on a THETA: `Math.exp(v)`. Useful when THETA is on the
 *    log scale.
 *  - `√Ω` on an OMEGA / SIGMA:
 *      * diagonal `(i,i)` → `sqrt(v)` = SD scale.
 *      * off-diagonal `(i,j)` → `v / sqrt(diag_i * diag_j)` =
 *        correlation. The naive `sqrt(off_diagonal)` is mathematically
 *        meaningless (it's a covariance, not a variance) — the prior
 *        version returned `sqrt(v)` for positive off-diagonals and the
 *        raw value for negative ones, which is what the user saw as
 *        "some values transform, others don't".
 *      * if either diagonal is missing or non-positive (uncommon —
 *        FIXED-to-zero, malformed BLOCK), fall back to the raw value.
 */
function transformValue(v, kind, name, diagBaseValues) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  if (kind === 'theta' && prefs.expTh) return Math.exp(v);
  if ((kind === 'omega' || kind === 'sigma') && prefs.sqrtOm) {
    const m = name && name.match(/\((\d+),(\d+)\)$/);
    if (!m) return v;
    const i = Number(m[1]);
    const j = Number(m[2]);
    if (i === j) {
      // Diagonal: variance → SD. Negative variance is degenerate
      // (estimation failure) and sqrt of it is undefined — return null
      // (em-dash) rather than the raw value so the toggle's effect is
      // consistent across cells.
      return v >= 0 ? Math.sqrt(v) : null;
    }
    // Off-diagonal: covariance → correlation = cov / √(var_i · var_j).
    // When either diagonal is missing, zero, or negative the
    // correlation is undefined — return null rather than the raw
    // covariance so the user doesn't see a half-transformed grid.
    const di = diagBaseValues && diagBaseValues.get(i);
    const dj = diagBaseValues && diagBaseValues.get(j);
    if (typeof di === 'number' && typeof dj === 'number' && di > 0 && dj > 0) {
      return v / Math.sqrt(di * dj);
    }
    return null;
  }
  return v;
}

function wrapParens(inner) {
  if (inner === null || inner === undefined) return null;
  return wrapWith(inner, '(', ')');
}

function wrapBrackets(inner) {
  if (inner === null || inner === undefined) return null;
  return wrapWith(inner, '[', ']');
}

function wrapWith(inner, open, close) {
  const span = document.createElement('span');
  span.className = 'inline-stat';
  span.append(document.createTextNode(open));
  if (inner instanceof HTMLElement) {
    span.append(inner);
  } else {
    span.append(document.createTextNode(String(inner)));
  }
  span.append(document.createTextNode(close));
  return span;
}

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

/** Per-parameter NUMSIGDIG: NONMEM emits 1-decimal precision (`9.2`); preserve. */
function fmtSigDig(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return v.toFixed(1);
}

/**
 * RSE rendered as a percentage with 2 decimals (`6.66%`). Returns a
 * `.bad` span when over `thresholds.rseWarnPct` (default 100% — RSE
 * ≥ |estimate| means the parameter is effectively unidentified).
 */
function fmtRse(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const pct = v * 100;
  const text = pct.toFixed(2) + '%';
  return pct > thresholds.rseWarnPct ? badge(text, 'bad') : text;
}

// Hover-tooltips for the short column headers — pharmacometric
// abbreviations aren't universally familiar.
const COL_TITLES = {
  '#': 'Parameter index (or matrix subscript for OMEGA/SIGMA off-diagonals). Hover the cell for the full access key.',
  Label: 'Inline `;<comment>` from the .mod source line — Pirana convention. `$THETA 4.79 ;CL` → "CL".',
  Value:
    'Final estimate in lst-mode, initial estimate in mod-mode. Affected by the √Ω / exp(θ) toggles.',
  '(RSE%)':
    'Relative standard error. THETA: SE/|estimate|. OMEGA / SIGMA: (SE/variance)/2 — relative SE on the standard-deviation scale (sumo default sd_rse=1 convention).',
  '[Shrinkage%]':
    'ETA shrinkage on the standard-deviation scale, ETASHRINKSD(%) from the .lst. Values above 30% (configurable in `positronNonmem.shrinkageWarnPct`) suggest the random effect is poorly informed by the data.',
  Fixed: '$THETA / $OMEGA / $SIGMA FIX flag',
  Name: 'Parameter access key (matches `.ext` columns)',
  ETABAR: 'Arithmetic mean of the ETA-estimates',
  'Shrinkage (SD)':
    'ETA / EPS shrinkage on the standard-deviation scale, ETASHRINKSD(%) / EPSSHRINKSD(%) from the .lst. Values above 30% (configurable in `positronNonmem.shrinkageWarnPct`) suggest that the random effect is poorly informed by the data.',
};

function sectionEl(title, cols, rowsData, rowAttrs, tableClass) {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    wrap.append(h);
  }
  const table = document.createElement('table');
  if (tableClass) table.className = tableClass;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    if (COL_TITLES[c]) th.title = COL_TITLES[c];
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  // rowAttrs is parallel to rowsData; pass [] for sections that don't
  // need per-row metadata (ETA/EPS shrinkage tables) — rowEl applies
  // its defaults from `attrs || {}`.
  rowsData.forEach((cells, i) => tbody.append(rowEl(cells, rowAttrs[i] || {})));
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function rowEl(cells, attrs) {
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
  for (const c of cells) {
    const td = document.createElement('td');
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
  }
  return tr;
}

function fixCell(fixed) {
  const span = document.createElement('span');
  span.className = fixed ? 'fix' : 'dim';
  span.textContent = fixed ? 'FIX' : 'no';
  return span;
}

function fmtNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e7 || abs < 1e-3) return v.toExponential(3);
  return parseFloat(v.toFixed(3)).toString();
}

vscode.postMessage({ type: 'ready' });

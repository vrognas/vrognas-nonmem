# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely.

## [Unreleased]

### Changed

- **feat: native scrollbars + custom context menu in lineage view (v0.0.82).**
  - **Native browser scrollbars** in both axes. Wrapped `#cy` in a
    `#canvas-wrap { overflow: auto }` container; cytoscape's drag-pan
    + wheel-zoom disabled so they don't fight the wrap. After dagre
    layout the canvas is sized to the graph's bounding box (or the
    wrap's visible size, whichever is bigger) and panned to anchor
    the graph's top-left at scroll position (0, 0).
  - **Zoom is ctrl/⌘+scroll only.** Plain scroll → browser pan.
    Custom wheel handler intercepts ctrl/⌘+scroll, applies
    `cy.zoom()` around the cursor, and resizes the canvas so the
    scrollbars track the new graph extent.
  - **Right-click → custom HTML context menu at the cursor.**
    Replaces `vscode.window.showQuickPick` (which surfaced at the
    command palette, far from the click). Items: `Open .mod` and
    `Promote estimates as new child run`. Dismisses on outside
    click, Escape, or scroll. Native browser context menu blocked
    inside the canvas so the custom one is the only thing that
    appears.

### Fixed

- **fix: spurious vertical scrollbar in the lineage panel (v0.0.81).**
  Body had no `overflow` rule, so legend wrapping on narrow panels
  triggered a vertical scrollbar that scrolled to nothing (cytoscape
  pans its canvas internally, not via native scroll). Added
  `overflow: hidden` on `html, body` so the canvas owns the entire
  pan space. Added a navigation hint to the header
  (`drag to pan · scroll to zoom · right-click a node for actions`)
  so the cytoscape pan/zoom affordances are discoverable.

- **fix: lineage view scale + visual bugs (v0.0.80).**
  - **Discovery inverted to `.lst`-anchored.** Previously scanned all
    `.mod` / `.ctl` workspace-wide (22376 hits in a workspace with
    PsN test fixtures present). Now scans `.lst` instead and resolves
    each one back to its sibling `.mod` — same anchor as the Runs
    pane. Test fixtures without `.lst` files (PsN's `nm_basics/`,
    `nm_validate/`) automatically excluded.
  - **500-node cap.** Workspaces with thousands of fitted runs render
    poorly and the disk scan dominates. Truncate to the 500 most-
    recently-modified `.lst` files with a notice in the Output
    channel.
  - **CSP `'unsafe-inline'` on `style-src`.** Cytoscape applies
    runtime stylesheets via inline styles; without this the canvas
    paints blank and the console fills with CSP violations. Scripts
    stay strict (no inline JS allowed).
  - **`#cy` container `position: relative`.** Cytoscape UI extensions
    require it for correct hit-testing.
  - **Replaced deprecated `width: 'label'` / `height: 'label'`** with
    explicit 130×60 sizes + `text-max-width: 120px`. Silences the
    deprecation warning and gives consistent node sizing across the
    multi-line basename / OFV / Δ-OFV label.
  - **Dropped the custom `wheelSensitivity`.** Default zoom feel; one
    less console warning.

### Changed

- **feat: lineage view now includes ALL `.mod` / `.ctl` files (v0.0.79).**
  Previously the workspace walk required `run<NNN>.mod` naming and
  silently skipped Pirana `m.mod`, hand-rolled `colistin.mod`, etc.
  Now every model file becomes a node — orphans/non-numbered models
  appear as roots with no inbound edges. The user can construct
  lineage in hindsight via the right-click menu (Edit Run Notes is
  the next ship; today, you can promote-as-child from any node).
  Schema migration: graph identity moved from `runNumber` (numeric,
  required) to `modelPath` (string, always unique). `runNumber` is
  now optional metadata used only for parent resolution — a
  `;; Based on: N` link still requires the parent to have a numeric
  runNumber. Edges keyed by `parentModelPath` / `childModelPath`.

- **feat: OFV + ΔOFV on lineage node labels (v0.0.79).** Each node
  now shows its basename, OFV, and (when it has a parent edge with a
  computed ΔOFV) the signed Δ-from-parent — no hover required. Edge
  labels suppressed since the same info now lives on the child node;
  keeps the canvas readable when zoomed out. Multi-line cytoscape
  labels via `text-wrap: 'wrap'`; node size auto-fits.

### Added

- **feat: right-click menu on lineage nodes (v0.0.78).** Right-click any
  node in the Run Lineage panel → QuickPick with two actions:
  `Open .mod` (the existing left-click action, made discoverable from
  the menu too) and `Promote estimates as new child run` — drives PsN's
  `update_inits` against the sibling .lst, names the output via
  `computeNextModelName` (`run002.mod` → `run003.mod`), and writes
  `;; Based on: N` into the new file's runrecord block. Same code path
  as the Active Runs view's right-click promote, surfaced from the
  visual lineage so adding a child to any node in the tree is one
  right-click + Enter away. The new file lands in the editor and the
  panel re-refreshes so the new node appears immediately.

### Fixed

- **fix: 3 more bugs in the SD-scale toggle + RSE% (v0.0.77).**
  - **RSE = 0.00% for FIXED params.** NONMEM emits SE=0 for FIXED
    parameters (no inference attempted) but $COV emits a non-zero row
    overall, so `parseExtFit`'s row-level "all-zero → drop" detection
    didn't catch them. `computeRse` returned `(0/|val|)*factor = 0`,
    displayed as `0.00%` — reads as "infinitely precise" when the
    truth is the opposite. Now returns null when `se === 0`. (+1 test.)
  - **`√Ω` on a negative diagonal variance silently returned the raw
    value.** Variance shouldn't be negative but degenerate fits can
    produce one; the prior code's `v >= 0 ? sqrt(v) : v` fallback made
    the toggle look broken on those cells. Now returns null (em-dash).
  - **`√Ω` on an off-diagonal with missing/zero/non-positive diagonal
    silently returned the raw covariance.** Same "some values transform,
    others don't" symptom from a different angle. Now returns null —
    correlation is undefined when either diagonal is missing or
    non-positive.

- **fix: `√Ω` toggle now produces correlations for off-diagonals (v0.0.76).**
  The prior implementation applied `sqrt(v)` uniformly to all OMEGA /
  SIGMA cells. Diagonal entries (variances) sqrt to standard deviations
  — correct. But off-diagonal entries are covariances, and `sqrt(cov)`
  is mathematically meaningless: positive covariances got sqrt'd to a
  nonsense value, negative covariances were returned raw (sqrt(NaN)
  fallback). User saw "some values transform, others don't". Fix:
  off-diagonals now compute the correlation `cov(i,j) / √(var_i·var_j)`
  using a per-section diagonal lookup, matching sumo / xpose. Diagonals
  unchanged. Tooltip updated to describe the per-cell behaviour.

### Added

- **feat: Cytoscape lineage view (v0.0.75, M11-D).** Replaced the HTML
  nested-list rendering with an interactive Cytoscape graph laid out
  via `cytoscape-dagre` (top-down hierarchical, parent above children).
  Node border colour and edge stroke encode Keizer 2013 ΔOFV class
  (green / red / yellow / gray; root nodes blue). Click a node opens
  its `.mod` in the editor. Native browser tooltip carries OFV /
  description / model path on hover. Pan, zoom, drag-to-position all
  built-in; layout re-fits on Refresh. Bundled via a second esbuild
  context (`webview-src/lineage/client.ts` → `media/lineage/client.js`,
  ~530 KB minified — one-time webview asset, served lazily). Cytoscape
  doesn't read CSS variables for canvas paint, so theme colours are
  resolved at render time via `getComputedStyle`.

- **feat: Pirana compact estimates layout in Fit Inspector.** Replaced the
  verbose 8-column table (`# | Label | LB | IE | UB | FE | RSE% | NSD | Fixed`)
  with a one-line-per-parameter shape: `# | Label | Value | (RSE%) | [Shrinkage%]`.
  Lst-mode shows final estimate + RSE; Omega rows additionally carry
  ETASHRINKSD(%). Mod-mode collapses to `# | Label | Value` (init only).
  Off-diagonal OMEGA rows keep the matrix subscript form (`2,1`).
- **feat: at-boundary highlight.** `InspectorRow.boundary` flags THETA rows
  where `final === lower` or `final === upper` (FIX rows excluded — they're
  stuck at the bound by design). The Value cell renders in
  `var(--vscode-charts-orange)` with a tooltip explaining the convergence
  concern. OMEGA / SIGMA bounds aren't yet exposed by vscode-nmtran so
  those rows never flag today; the wiring is uniform so future bound-aware
  data lands in the right place. (+7 boundary tests, total 257.)
- **feat: √Ω and exp(θ) display toggles.** Two checkboxes above the
  parameter tables transform the Value column: `√Ω` shows variances on
  the SD scale (`Math.sqrt`), `exp(θ)` exponentiates THETA (useful when
  THETA is on the log scale). State persists via `vscode.setState` across
  panel re-mounts. RSE% values pass through unchanged (dimensionless ratio,
  the formula doesn't depend on the displayed scale).

### Fixed

- **Wider codebase audit — 8 bugs, 2 latent fixes, 2 DRY consolidations
  (v0.0.74).** Code-reviewer agent swept the older `runtime/` modules
  that hadn't been audited recently; this ship resolves the actionable
  findings. 250 tests pass (was 245, +5 regression tests).
  - **B2/B3 Poller + stale-timeout leak** on duplicate `psn.mod` events
    (PsN setup re-touches the file). `handlePsnModCreate` now calls
    `stopRunSideEffects(runId)` before reinstalling poller / canceller.
  - **B4 `extractRunNumber` accepts `run0`.** `^run0*([1-9]\d*)$`
    requires N ≥ 1 — PsN's runrecord rejects `;; Based on: 0`.
  - **B7 `parseLastIteration` accepts non-integer iteration column.**
    SAEM/IMP STAT-summary rows could slip through; tightened to
    `/^\d+$/.test(cols[0])`.
  - **B8 `handleLstCreate` race.** PsN copies the .lst back to the
    top-level dir BEFORE copying it under `modelfit_dir<N>/`. We now
    defer once and retry at +1 s when `modelfitDir` is set but the
    per-run lst doesn't yet exist — preserves the stable per-run path
    in the tracker so re-runs can't overwrite this entry's history.
  - **B9 `setBasedOn` CRLF corruption.** The split-edit-rejoin path
    used hardcoded `\n`; Pirana / Windows-edited .mod files (CRLF) got
    silently rewritten on every promote. Now detects dominant line
    separator from the original and preserves it.
  - **B12 `findCallingCwd` ambiguity.** Two distinct dirs each
    containing `run<NNN>.mod` with the wrong one's siblings higher up
    could mis-attribute. New `parseCommandTxtWithHint` surfaces an
    absolute-path hint when command.txt's modelfile arg was absolute
    (Pirana, positron-nonmem); skips the walk-up entirely in that
    case.
  - **L1 Metadata parsers reject `.ctl`.** `parseTranslationFile` and
    `parseCommandTxt` now accept both `.mod` and `.ctl` so PsN runs
    with `.ctl` model files register in Active Runs.
  - **L2 `parseExtFit` NaN OFV.** Missing `OBJ` column now returns
    null (truncated .ext) instead of NaN-stuffing; downstream code
    already handles null but didn't handle NaN.

### Changed

- **`errMsg` adopted across 4 modules (D1).** Replaced inline
  `e instanceof Error ? e.message : String(e)` ternaries (8 sites) in
  `extension.ts`, `views/lineage-panel.ts`, `views/runs-tree-provider.ts`,
  and `runtime/runtime-session.ts` with the shared helper from
  `log-utils.ts`.
- **`listModelfitDirs` shared helper (D3).** `findExtFile`'s tier-2
  cascade and `findLatestModelfitDir`'s top-pick both run the same
  `^modelfit_dir(\d+)$` scan + descending sort. Collapsed to one
  helper in `runtime/find-ext-file.ts`; both call sites swap.

- **Bug-fix + DRY pass following a code-reviewer audit (v0.0.73).**
  Nine bugs identified, all fixed; three TIER-1 DRY items consolidated.
  No user-visible behaviour change beyond bug repair. 245 tests pass
  (was 232, +13 new regression tests).
  - **B1 Self-reference recursion.** `;; Based on: N` where N == own
    runNumber would have caused infinite recursion in the lineage
    renderer. Self-ref → root, no edge.
  - **B2 Cycle detection.** Cyclic `basedOn` chains (run002→3, run003→2)
    no longer make the panel render blank — both nodes become roots.
    Walk-the-chain detector in `lineage-graph.ts`.
  - **B3 Duplicate run numbers.** Two `run<NNN>.mod` files in different
    subdirs now first-wins-with-no-loss instead of silently overwriting
    each other in the byRun map.
  - **B4 modUri fallback.** When no sibling .mod is found in lst-mode,
    `VariablesContext.modUri` is now `undefined` (not `lstUri`); click-
    to-source no-ops instead of jumping into the .lst at a wrong line.
    Type made optional.
  - **B5 Truncated control stream.** `extractControlStream` now caps
    its slice at 2000 lines and requires a real terminator; corrupted
    .lst returns null instead of feeding the parser garbage.
  - **B6 Continuation-line `:` mis-parse.** runrecord continuation
    lines containing `<word>:<word>` (e.g. `;; uses ITS:FOCE first`)
    no longer get treated as new tags. Tag name regex tightened to
    `[A-Z][A-Za-z ]{0,30}`.
  - **B7 setBasedOn `[nodOFV]` preservation.** `setBasedOn` preserves
    the `[nodOFV]` modifier when the parent number stays the same
    (idempotent re-promote); drops it when the parent changes.
  - **B8 Multi-EST terminationReason.** `parseLst` now takes the LAST
    occurrence of the termination-reason text (`matchAll` + last);
    multi-`$EST` chains no longer report a stale earlier-step reason
    as the run's overall failure cause.
  - **B9 Lineage panel error swallow.** `LineagePanel.refresh` now
    catches errors and renders a visible error banner instead of
    leaving the panel silently stale on a failed `discoverLineage`.

### Changed

- **Lineage WebView assets extracted (T1-A).** `LINEAGE_CSS` (95-line
  template literal) → `media/lineage/style.css`. Inline `<script>`
  block → `media/lineage/client.js` with DOM-side rendering. Same
  bug-class barrier we put up after v0.0.59: no template-literal HTML
  carrying user data, no inline `<script>`, no `escapeHtml` plumbing.
  CSP tightened (no `'unsafe-inline'` script-src).
- **`findSiblingByExt` shared helper (T1-B).** Two near-identical
  exact-then-readdir-fallback routines (`findSiblingLst` in lineage-
  discovery, `findModInDir` in variables-context) collapsed into one
  function in `src/fs-utils.ts`. Both call sites swap.
- **`loadExtFitForLst` shared helper (T2-A).** Identical four-step
  pipelines (findExt → readFile → parseExt → guard) in lineage-
  discovery and variables-context now route through one helper in
  `src/runtime/load-ext-fit.ts`.
- **`CHISQ_1DF_05` exported** from `lineage-graph.ts` so the WebView
  legend stays in sync with the classifier (was a magic-number triple
  in the legend HTML strings).

- **Fit Inspector now reads the .lst's embedded control stream (v0.0.72).**
  Previously the inspector pulled decls (and labels) from the SIBLING
  `.mod` via vscode-nmtran's parsedModel API. That meant editing the
  .mod after a run leaked forward into the inspector view of past
  `.lst` files — surprising the user. Fix: extract the embedded NM-TRAN
  control stream from the .lst (NONMEM writes it verbatim at the top,
  terminating at `NM-TRAN MESSAGES` / `1NONLINEAR MIXED EFFECTS MODEL
  PROGRAM`) and parse THAT via vscode-nmtran ≥ 0.4.21's new
  `parseModelFromText` API. The .lst is now self-sufficient for
  Fit-Inspector display; the sibling .mod is only used for the
  click-to-source navigation target.
- **Fit Inspector now works for `.lst` files inside `modelfit_dir<N>/`
  (v0.0.72).** PsN copies the .lst back into `modelfit_dir<N>/`, but
  the source .mod stays at the workspace root one level up. The sibling-
  .mod lookup walks up one directory now to find it. With the embedded-
  control-stream fix above, navigation isn't load-bearing for display
  any more — but it still matters for click-to-source.

### Added

- **Lineage discovery layer + Run Lineage WebView (v0.0.72, M11-B/C
  first cut).** New toolbar icon `$(type-hierarchy)` on the Runs view
  opens a panel that walks the workspace for `run<NNN>.mod` /
  `.ctl`, parses each one's `;; Based on:` linkage, resolves OFV from
  the sibling `.lst` / `.ext`, and renders an HTML nested-list tree
  with Keizer 2013 ΔOFV edge colours (green / red / yellow / gray).
  Clicking a node opens the .mod in the editor. Refresh button
  re-walks. Cytoscape / d3 curved-edge rendering is the next iteration
  — same wire-shape (`LineageGraph`) so the renderer swap is surface
  only.

### Changed

- **Pirana-style parameter labels in Fit Inspector (v0.0.71).** Each
  THETA/OMEGA/SIGMA row now shows `# | Label | <values>`, where the
  `Label` column carries the inline `;<comment>` from the .mod source
  (e.g. `$THETA 4.79 ;CL` → `CL`). Headings switched to singular
  (`Theta`, `Omega`, `Sigma`). Access key moved to a tooltip on the `#`
  cell. Off-diagonal OMEGA(2,1)-style rows show `2,1` in the `#` cell.
  Required vscode-nmtran ≥ 0.4.20 (which now exposes `comment` per
  decl on the `nmtran/parsedModel` LSP request — multi-decl single-line
  case correctly assigns the comment only to the LAST decl per the
  NM-TRAN `;` runs-to-EOL rule).
- **Fit Inspector colors made theme-aware (v0.0.71).** Replaced
  `--vscode-testing-iconPassed/Failed/Queued` (used as solid backgrounds
  with hardcoded `color: #fff` — broken on light themes with bright
  bg) with outline-only `.status` badges using `--vscode-charts-*`
  variables. Stripped hex fallbacks elsewhere. `tr.fixed-row` now uses
  `--vscode-charts-blue` instead of `--vscode-textLink-foreground`.

- **`.lst` decoration tooltip de-cluttered (v0.0.70).** First line now
  combines `<method> · OFV = <n>`; the meta line stands alone.
  Termination reason inlined with `—` instead of an indented
  continuation line. Sumo OK statuses dropped — the badge already
  conveys overall state, so listing six "✓ Hessian not reset" lines
  was noise; only WARNING / ERROR statuses appear.
  Also added an FS watcher (`**/*.lst`) that invalidates the cache
  and fires `_onDidChangeFileDecorations` on create/change/delete, so
  the badge tracks live re-runs without requiring an explorer hover.

- **`.lst` hover moved from in-editor to file-explorer (v0.0.69)**.
  Replaced `LstHoverProvider` with `LstFileDecorationProvider` so the
  run summary appears when hovering an `.lst` in the Explorer / Open
  Editors / breadcrumbs (the original UX intent). Added a 1-char badge
  (`✓` / `✗` / `⚠`) for at-a-glance termination state. Tooltip is
  plain text — the markdown formatting is gone since
  `FileDecoration.tooltip` is `string`, not `MarkdownString`. Two-tier
  load: parse-lst first (instant), sumo backfilled async with a
  `_onDidChangeFileDecorations` re-fire. 211 tests pass (+10 −5).

- **DRY pass on the recent feature chunks, no behaviour change**
  (5 fixes from a code-reviewer audit). 206 tests still pass.
  - **Shared `formatNumberCompact`** (`src/format-number.ts`)
    replaces a byte-identical copy in `lst-hover-provider.ts`. The
    WebView client.js keeps its own copy because it runs in the
    browser sandbox and can't import TS modules.
  - **Shared `errMsg` + `tryLoad`** (`src/log-utils.ts`) replace
    the try/catch+log boilerplate at every parallel-loader site
    (`variables-context.ts`'s 5 loaders shrink by ~3 lines each)
    and the duplicate `errMsg` definitions across modules.
  - **`makeOmegaSigmaRow` helper** in `fit-inspector-payload.ts`
    is now the single source of truth for OMEGA / SIGMA row
    construction (diagonals + off-diagonals), reusing the existing
    `parseMatrixIndex`. The two callers (diagonal-from-decl,
    off-diagonal-from-fit) now feed through one builder.
  - **`renderShrinkageTable(label, shrinkSd, etabar?)`** collapses
    `renderEtaTable` + `renderEpsTable` in the WebView client. The
    `etabar` arg toggles the optional ETABAR column.
  - **`stopRunSideEffects(runId)`** in `active-runs-watcher` is the
    single place that stops the per-run poller + stale-timeout.
    `dispose()` loops it; `handleLstCreate` calls it once.

### Changed

- **`SE` column → `RSE%` column matching PsN sumo's `sd_rse=1`
  default.** Sumo source-verified (`bin/sumo` v5.3.1 lines 800-840):
  THETA shows `cvse = SE/|estimate|`; OMEGA / SIGMA show `cvse / 2`
  — relative SE on the SD scale, the pharmacometric reporting
  convention. Fit Inspector now matches: column header `RSE%`,
  values formatted `XX.XX%`, hover tooltip explains the rule.
  Absolute SE is kept on `InspectorRow.se` for future surfaces
  (CSV export, raw-data panes); the WebView doesn't display it.

### Added

- **Off-diagonal OMEGA / SIGMA initial estimates from `.ext`
  iteration-0 row.** Previously off-diagonal rows showed `—` for
  init because vscode-nmtran's parsed-model API doesn't expose
  BLOCK matrix elements. NONMEM writes the initials at
  iteration 0 in the `.ext`, so we now parse that row and use it
  as the source for off-diagonal `init`. Diagonal init still comes
  from vscode-nmtran (the .mod stays authoritative for what's
  typed). New `inits: Map<string, number>` field on `ExtEstimates`.

- **Threshold-based row colouring.**
  - **RSE > 100%** rendered red (`.bad` class) — when SE ≥ |estimate|
    the parameter is effectively unidentified.
  - **Shrinkage > N%** rendered red, where N is configurable via
    the new `positronNonmem.shrinkageWarnPct` setting (default 30,
    the pharmacometrics convention; set to 100 to disable).
  - **FIXED parameter rows** tinted blue (`.fixed-row` class) so
    they're visually distinct from estimated params at a glance.

- **More column-header tooltips.** `ETABAR` → "Arithmetic mean of
  the ETA-estimates"; `Shrinkage (SD)` → explanation of ETASHRINKSD
  / EPSSHRINKSD plus the configurable warn threshold; `NSD` shortened
  to "Number of significant digits in final estimate".

### Added

- **Status badge tooltips show sumo's detail block.** When sumo
  emits indented detail under a status row (e.g. parameter pairs +
  correlation values under `Large correlations between parameter
  estimates found [WARNING]`), the parser now captures those
  lines as `SumoStatus.detail`. The Fit Inspector renders the
  detail in the badge's `title` attribute so hovering the badge
  pops a native multi-line tooltip with the actual offending
  pairs / values. 2 new parser tests cover detail capture +
  bounded propagation (doesn't bleed into the next status row).

- **Per-parameter NUMSIGDIG column.** NONMEM emits a
  `NUMSIGDIG:` row in the LAST iteration block of the .lst —
  one value per parameter, in the same column order as the
  `.ext`. The Fit Inspector now adds a `NSD` column to the
  parameter tables that shows each parameter's individual
  significant-digits-of-precision; values noticeably below the
  global `NO. OF SIG. DIGITS IN FINAL EST.` flag a parameter
  that pulled the global precision down. Parser handles
  multi-line continuation (>10 params).

- **Column-header tooltips on the parameter tables.** Hover any
  short-form column header (`LB`, `IE`, `UB`, `FE`, `SE`, `NSD`,
  `Fixed`, `Name`) to see its full meaning ("Lower bound",
  "Initial estimate", "Final estimate", "Standard error",
  "Per-parameter NUMSIGDIG …", etc.) — the abbreviations aren't
  universally familiar.

### Changed

- **Shrinkage display: title `Shrinkage (SD)`, values `XX.XX%`.**
  ETA / EPS shrinkage tables previously showed `Shrink% (SD)` as
  the column header and rendered values via the generic 3-decimal
  `fmtNum` (`32.846`). Now the column reads `Shrinkage (SD)` and
  values format as `32.85%` (2 decimals + percent sign), matching
  pharmacometric reporting conventions.

### Fixed

- **`parseSumo`'s condition-number regex required whitespace, but
  sumo actually emits `Condition number: 420.3` with a colon.**
  Empirical fixture from qphcmp03 confirms the colon-separated
  form (verified against PsN 5.3.1). The previous test fixture
  was synthesised and used the wrong format. Inspector summary
  meta line will now show `cond 420.3` for runs with a successful
  `$COV` step (instead of silently being null). Test fixture
  updated to match real output, including the parallel status
  row (`Condition number  [   OK   ]`) that sumo also emits.

### Added

- **`.lst` hover provider — Markdown popover summarising any `.lst` file.**
  Hover anywhere in the `.lst` body and a popover shows: title +
  method badge (`FOCE-INTER`, `SAEM`, …), OFV + meta line (runtime,
  sig-digits, cond, obs, subj), the verbatim termination phrase
  with a ✓/✗ glyph, and a sumo status bullet list. Caches per
  file path keyed on mtime so repeated hovers don't re-shell sumo.
  Cancellation-aware. Pure `buildLstHoverMarkdown` helper in
  `src/views/lst-hover-provider.ts`; 5 unit tests cover the
  composition (full / sumo-only / lst-only / both-empty / failed-run).

- **Off-diagonal OMEGA / SIGMA rows in the Fit Inspector.** When a
  run has been executed (`.ext` available), `buildInspectorPayload`
  now emits BLOCK matrix elements like `OMEGA(2,1)` / `OMEGA(3,2)`
  alongside the diagonals — sorted lower-triangular row-major.
  `init` and `declLine` are null for off-diagonals
  (vscode-nmtran's parsed-model API doesn't expose BLOCK matrix
  initials yet); `final` and `SE` come from the `.ext`. Section
  titles drop the now-misleading "(diag)" suffix; `omegasDiag`
  / `sigmasDiag` fields rename to `omegas` / `sigmas`. Two new
  payload tests cover the off-diagonal merge + sort and the
  mod-mode skip.

### Added

- **Method-specific termination phrasing + SAEM/BAYES acceptance rate.**
  `parseLst` now also recognises `OPTIMIZATION WAS COMPLETED` /
  `OPTIMIZATION TERMINATED` (the SAEM / IMP / BAYES vocabulary) on
  top of the FOCE-flavour `MINIMIZATION SUCCESSFUL` /
  `MINIMIZATION TERMINATED`. The Diagnostics block renders the
  verbatim phrase NONMEM emitted (so a SAEM run shows
  `OPTIMIZATION WAS COMPLETED` in green, not a synthesised
  `MINIMIZATION SUCCESSFUL` label).
  - New `terminationPhrase: string | null` on `LstSummary` /
    `InspectorDiagnostics` carries the verbatim text;
    `termination` keeps the `'SUCCESSFUL' | 'TERMINATED'` enum
    that drives the colour.
  - New `acceptanceRate: number | null` parses
    `Mean Acceptance Rate:` lines (SAEM iterative loops, BAYES
    sampling). The LAST value (stationary, post-burn-in) is taken,
    rendered in the summary meta line as `accept N.NN`. FOCE / FO /
    IMP runs leave it null.
  - 3 new parser tests covering SAEM success, SAEM termination
    with reason, and FOCE phrase pass-through. Failure-mode test
    extended to assert `acceptanceRate === null` and
    `terminationPhrase === null`.

### Changed

- **Fit Inspector WebView assets extracted from `INLINE_JS` /
  `INLINE_CSS` template-literal strings to plain
  `media/fit-inspector/client.js` + `media/fit-inspector/style.css`
  files**, loaded via `webview.asWebviewUri`. Closes the entire
  template-literal-escape bug class (the `/\r?\n/` regex bug we
  just hit), drops the provider from ~580 LOC to ~120 LOC, and
  gets editor JS/CSS tooling on the WebView code. CSP unchanged
  except dropping `'unsafe-inline'` from `style-src` and the inline
  `'nonce-…'` from `script-src` since neither is needed any more.
  No behaviour change.

- **Fit Inspector watcher now matches `.ctl` runs too.** The
  `.lst → modelPath` candidate-list in `active-runs-watcher`
  hardcoded `.mod`; it now mirrors `findSiblingModUri`'s
  `.mod` + `.ctl` cascade so a run launched on a `.ctl` model is
  matched on completion.

- **Sibling-`.mod` lookup is now case-insensitive.**
  `findSiblingModUri` (used by lst-mode resolution) does the cheap
  exact-case probe first and falls back to a directory scan that
  matches `.mod` / `.ctl` regardless of stem casing — so e.g.
  `Run001.MOD` next to `run001.lst` is recognised as the sibling.

- **Eigenvalue condition number sourced from sumo, not recomputed.**
  PsN's `sumo` already emits `Condition number` directly; we were
  redundantly computing it from `min/max` of eigenvalue values
  (and getting `+Inf` for any non-strictly-positive min, which
  was wrong for negative-eigenvalue / non-PD-COR cases).
  `InspectorDiagnostics.eigenvalues` now carries `min` + `max` +
  `values` only; the condition number stays in the summary meta
  line via `sumo.conditionNumber`.

- **`promote-estimates.ts` cross-ref comments** explain the
  intentional asymmetry between `computeNextModelName` (handles
  Pirana `+N` names) and `extractRunNumber` (only matches
  `run<NNN>` for `;; Based on:` writes) so future readers see why
  the runrecord marker is skipped for non-runrecord-compatible
  parents.

### Fixed

- **Fit Inspector blank since v0.0.59 — regex literal escape bug.**
  The PRDERR rendering helper added in v0.0.59 used the regex
  literal `/\r?\n/` inside `INLINE_JS`. Because `INLINE_JS` is a
  TypeScript template literal, `\r` and `\n` were processed as
  escape sequences and embedded actual CR/LF characters into the
  regex, which the JS parser then rejected (`Invalid regular
  expression: missing /`). The script never finished parsing, so
  the message handler was never installed and every `update()`
  was dropped — the panel stayed at its initial empty state. Fix:
  double-escape (`/\\r?\\n/`) so the resulting WebView source
  contains a literal `\r?\n`. Comment added next to the regex
  flagging the constraint for future edits.

### Added

- **Fit Inspector — visibility-change re-post.** WebView posts to
  hidden views are silently dropped by VS Code; we now listen on
  `view.onDidChangeVisibility` and re-post `lastPayload` whenever
  the panel becomes visible again. Plus diagnostic logging at every
  step (`update — view=resolved visible=true payload=present`,
  `postMessage delivery failed`, `resolveWebviewView fired`,
  `visibility=true`) so the next "panel is empty" report has a
  trail.

### Added

- **Fit Inspector WebView now surfaces render errors to the Output
  channel** instead of silently producing empty output. A try/catch
  in the WebView script wraps `render(payload)`, and any thrown
  error postMessages back to the extension under
  `[positron-nonmem] fit-inspector: webview render error: …`.
  Same path catches uncaught `error` / `unhandledrejection`
  events. Diagnostic-only — no behaviour change when render
  succeeds.

### Fixed

- **Fit Inspector no longer blanks when active editor changes to an
  unrecognised type** (Output channel, terminal, walkthrough, etc.).
  The previous code cleared the panel for any unrecognised
  `activeEditor`, so glancing at the Output channel to read the
  diagnostic logs the panel itself emits would blank what the user
  was just looking at. Now: editor === undefined → clear; editor
  exists but unrecognised → keep last context; recognised
  (.mod/.ctl/.lst) → resolve and update.

### Added

- **`parseLst` reads multi-line ETABAR / ETASHRINKSD(%) /
  EPSSHRINKSD(%) rows.** NONMEM wraps these onto continuation lines
  when N_ETAs > ~6; the reader now walks consecutive numeric-only
  lines after the labelled row until it hits a blank line or the
  next labelled row. Two new tests cover a 9-ETA wrap fixture and
  the "no blank between rows" boundary case.

### Added

- **Fit Inspector — collapsible PRDERR (NONMEM warnings) block.**
  Reads the run's `PRDERR` file (numerical issues, integration
  warnings) and renders it as a `<details>` element at the bottom
  of the Diagnostics block. Two-tier discovery (matches PsN's
  `-clean` matrix, see docs/psn-notes.md):
  1. **plain file** at `<modelfitDir>/NM_run1/PRDERR` — used when
     `-clean ≥ 3` left NM_run1/ unarchived.
  2. **archive extraction** via Runner: `7z e -so -y
     <modelfitDir>/NM_run1.7z PRDERR` — used when PsN archived
     NM_run1 (default `-clean=1` does this).
  Hidden when no PRDERR was emitted (clean run with no warnings),
  when `7z` isn't available, or when neither path resolves.
  Header line: `PRDERR — NONMEM warnings (N lines from NM_run1.7z)`
  in the theme's WARNING colour. Click to expand the contents in a
  scrollable, monospace-rendered block (preserves NONMEM's
  whitespace). New module `src/runtime/read-prderr.ts` + 6 tests
  covering plain-file path, archive-via-runner path, missing-file
  fallbacks, and 7z-binary-missing handling.

### Added

- **Fit Inspector — full diagnostics block + Run Notes from `;;` block.**
  Significantly more of what NONMEM emits in the `.lst` is now visible
  alongside the parameter tables, plus a Run Notes block surfaces the
  user's own runrecord annotations from the `.mod`:
  - **Termination state**: `MINIMIZATION SUCCESSFUL` (green) or
    `MINIMIZATION TERMINATED` (red) with the multi-line reason
    (`DUE TO ROUNDING ERRORS (ERROR=134)` etc.) below it.
  - **Per-ETA `ETABAR` and `ETASHRINKSD(%)`** rendered as a small
    table: `ETA(1) | ETABAR | Shrink% (SD)`.
  - **Per-EPS `EPSSHRINKSD(%)`** as a sibling table.
  - **Eigenvalue summary line**: `min · max · cond` (raw values
    from `EIGENVALUES OF COR MATRIX OF ESTIMATE` plus the derived
    condition number).
  - **Run Notes** at the top of the panel: `Based on`, `Label`,
    `Description`, plus any other PsN runrecord tag the user
    populated (Structural model, Covariate model, Interindividual
    variability, …). Hidden when the .mod has no runrecord block.
  - Pure parser extensions in `src/runtime/parse-lst.ts` (5 new
    tests covering termination, ETABAR, shrinkages, eigenvalues,
    failure-fallback). Loaded in parallel with sumo + .ext + the
    `parseRunrecord` read in `variables-context.ts` —
    single-`Promise.all` round-trip per editor switch.

### Added

- **Fit Inspector now parses `.lst` directly** for the FOCE-essential
  fields sumo doesn't expose:
  - **Estimation method** (`#METH:` line) — rendered as a compact
    badge next to the .lst basename: `FOCE-INTER` / `FOCE` / `FO`
    / `ITS` / `SAEM` / `IMP` / `BAYES` (verbose label kept on
    hover). Picks the LAST `$EST` block when methods are chained
    (e.g. ITS→FOCE-INTER), since that's the final convergence step
    the user cares about.
  - **`NO. OF SIG. DIGITS IN FINAL EST.`** — added to the meta line
    as `sig-digits N.N`. Null when NONMEM wrote `UNREPORTABLE`
    (failed minimization).
  - **`Estimation seconds`** from sumo now also displayed alongside
    the wall-clock runtime: `runtime 0:00:01 (est 0.12s)`.
  Sample summary line (lst-mode): `run001.lst [FOCE-INTER] OFV =
  -638.795 · runtime 0:00:01 (est 0.12s) · sig-digits 3.4 · cond
  3.245e+2 · 4 obs · 2 subj` plus the colour-coded sumo status
  badges below. New parser `src/runtime/parse-lst.ts` (will grow
  with shrinkages / eigenvalue range / ETABAR in 0.0.58); 7 unit
  tests. Wired through `variables-context.ts` in parallel with
  the existing sumo + .ext loads (`Promise.all`).

### Added

- **M11-A — `promoteEstimates` now writes PsN runrecord-style parent
  linkage** (`;; Based on: N`) directly below `$PROBLEM` in the new
  `.mod`. Format matches PsN's `runrecord_userguide.pdf` v5.3.1
  exactly so PsN's own `runrecord` tool reads our markers without
  modification — interoperability over invented conventions.
  - Marker only written when the parent basename matches
    `run<NNN>(.mod|.ctl)` (`run001` → `1`, `run042` → `42`). For
    Pirana-style `m.mod` / `m+1.mod` parents, no marker is written
    rather than emitting a non-runrecord-compliant value.
  - Idempotent re-promote: an existing `;; Based on:` (with or
    without optional `;; <N>. ` cosmetic prefix) is **replaced**
    rather than duplicated, so `update_inits`'s comment carry-over
    can't accumulate stale parents.
  - New parser `src/runtime/parse-runrecord.ts` reads the **full**
    runrecord block (Based on, Description, Label, Structural model,
    …) into a `tags: Map<string, string>` plus the special-cased
    `basedOn` / `computeDeltaOfv` fields. Honours the `[nodOFV]`
    modifier on `Based on:`. M11-B's lineage discovery will use
    the full tag set; today only `basedOn` is consumed.
  - 14 parser tests + 5 promote-estimates integration tests
    (marker insert, marker replace, run-number extraction,
    non-numeric-skip, `$PROB` short form). Total now 171.

### Added

- **Stale-running cleanup.** Active Runs entries that get stuck in
  `running` (because the watcher missed the `.lst` event, the run
  crashed silently after creating `psn.mod`, the workspace path
  scope was off, etc.) now auto-fail after a configurable timeout.
  Setting `positronNonmem.staleRunTimeoutMinutes` (default `1440`
  = 24 h, set to `0` to disable). New pure helper
  `scheduleStaleTimeout(tracker, runId, timeoutMs, log)` in
  `active-runs-watcher.ts`; tracker test exercises it with
  `vi.useFakeTimers()` (3 new tests). Wired in
  `handlePsnModCreate` (per-run `setTimeout` stored alongside the
  poller) and cleared in `handleLstCreate` / `dispose` so a
  legitimate completion never trips a spurious failure.

### Added

- **M3 — Fit Inspector now surfaces `sumo` status badges and run
  metadata in lst-mode.** Right after parsing the `.ext` finals, the
  variables-context resolver shells out PsN's `sumo <basename>.lst`
  in the .lst's parent dir and folds the parsed result into the
  inspector summary. Renders as:
    `run001.lst   OFV = -638.795   · runtime 0:00:01 · cond 3.245e+2 · 4 obs · 2 subj`
    `[Termination problems][No rounding errors][Zero gradients ...][...]`
  Status badges colour by level (`OK` green, `WARNING` yellow,
  `ERROR` red) using Positron's testing-icon CSS variables so the
  palette tracks the active theme. Hovering a badge shows its level.
  - Pure `parseSumo(text)` parser in `src/runtime/parse-sumo.ts`
    handles the full status-line / OFV / runtime / cond-nr /
    sample-size grammar; tolerates stray free-form lines (e.g.
    `No covariance step run.`); returns null on garbage input.
  - Thin `runSumo({ lstPath, runner })` wrapper in
    `src/runtime/run-sumo.ts` shells in the .lst's parent dir
    (RC≠0 → null, unparseable stdout → null; caller logs).
  - Wired into `resolveLstMode` (parallel `Promise.all` with the
    .ext fit load — independent reads, no need to serialise).
    Sumo is opt-in via the new `runner` field on `ResolveDeps`;
    extension.ts passes it through, tests omit it for pure parsing.
  - 7 new unit tests (4 parser, 3 runner). Total now 149.

### Changed

- **Larger maintainability pass over the codebase, no behaviour change**
  (Tier 1 + Tier 2 from a multi-agent code review). 142 tests still
  pass.
  - **Shared helpers**: new `src/shell.ts` (`quote()`) and
    `src/fs-utils.ts` (`pathExists()`) eliminate three duplicate
    impls (`shellQuote`/`quote` in run-model.ts + promote-estimates.ts;
    `fileExists`/`exists` in active-runs-watcher.ts + find-ext-file.ts).
  - **`ActiveRunsWatcher` moved `src/views/` → `src/runtime/`**.
    It's the engine that fills the tracker, not a vscode UI binding;
    the move restores the one-direction `views/ → runtime/ → pure`
    rule. Test moved alongside.
  - **`resolveVariablesContext` extracted** from `extension.ts`
    (~120 LOC) into `src/views/variables-context.ts`. Logger is
    now an injected param. `extension.ts` is back to wiring only.
  - **`ExtFitResult` → `ExtEstimates`**. "Fit" was overloaded
    between the parsed-`.ext` data type and the Fit Inspector UI;
    keeping "Fit" as a UI brand only.
  - **`runDir` → `modelfitDir`** across 17+ call sites + 3 test
    files. The old name didn't say which dir in the
    `modelDir > modelfit_dir<N> > NM_run1` cascade was meant; now
    every reference is explicit. `findRunDir` option/callable on
    `pollProgress` and `chooseRunAction` correspondingly renamed
    to `findModelfitDir`.
  - **Smaller cleanups**: dropped legacy `tracker | deps`
    constructor branch on `ActiveRunsWatcher`; removed
    single-field `ActiveModelTarget` wrapper; collapsed triplicate
    "Variables pane init-only" comment to one location; dropped
    `stripExtension` one-liner reimpl in run-model.ts; tightened
    `dispatch`'s stdout/stderr emit logic via a small closure.

### Changed

- **Cleanup pass on the recent Fit Inspector / lst-mode chunks.**
  Three small DRY/cohesion fixes from a code review, no behaviour
  change:
  - `findDispatchedRun` helper extracted in
    `active-runs-tracker.ts` so `reconcileCompletion` and
    `reconcileFailure` no longer copy the same
    `list().find(modelPath + startedAt window)` lookup.
  - `parsedModelStatsLine(model)` helper in `extension.ts` collapses
    the duplicated `thetas=X omegas=Y sigmas=Z eqs=W` log lines in
    `resolveModMode` and `resolveLstMode` so the format stays in
    sync when vscode-nmtran adds new fields.
  - Misleading "Always on for now — chunk-debugging window" comment
    on `logVars` removed; the gate doesn't actually exist, so the
    comment was lying about the function's behaviour.

### Changed

- **Fit Inspector: unified column schema across THETA / OMEGA / SIGMA
  sections.** All three now render `Name | LB | IE | UB | FE | SE |
  Fixed` (FE/SE collapse out in mod-mode). LB/UB for OMEGA/SIGMA show
  as em-dash today since vscode-nmtran doesn't expose bounds for them
  yet (`$OMEGA (0.001, 0.1, 1.0)` syntax) — when it does, no
  inspector-side change required; the wire-through happens
  automatically. Two `renderThetas`/`renderDiag` helpers collapsed
  into one `renderSection`. `InspectorTheta` / `InspectorOmegaSigma`
  types unified into `InspectorRow`.

### Fixed

- **Editor-title run-button no longer shows on `.lst` files.** vscode-nmtran
  sets `languageId == 'nmtran'` on `.lst` as well as `.mod` / `.ctl`, so
  the original `when:` clause `resourceLangId == nmtran || resourceExtname
  == .mod || resourceExtname == .ctl` matched `.lst` too via the languageId
  alternative. Dropped the languageId clause — extension-only check —
  since `.lst` is read-only output and we shouldn't offer to "run" it.

### Added

- **Fit Inspector — custom WebView for converged-estimate display.**
  New view in the NONMEM activity bar (sibling to Active Runs / Runs).
  Renders a multi-column table matching the Pirana-style "Details"
  pane:
    Thetas: `Name | LB | IE | UB | FE | SE | Fixed`
    Omegas (diag): `Name | Init | Final | SE | Fixed`
    Sigmas (diag): `Name | Init | Final | SE | Fixed`
  - Driven by active-editor change (same `resolveVariablesContext`
    cascade that feeds the Variables comm). `.mod` / `.ctl` → init
    columns only; `.lst` → all columns including FE/SE pulled from
    the fit overlay.
  - Top-of-pane summary line in lst-mode: `<basename>.lst  OFV = …`.
  - Click a row → jumps to the corresponding `$THETA`/`$OMEGA`/
    `$SIGMA` line in the .mod (recovers the navigation that lived
    on the Variables pane in mod-mode, in a place that makes sense
    for both contexts).
  - Theme-aware via Positron CSS variables (`--vscode-foreground`
    etc.); CSP locks scripts to a per-load nonce; DOM
    construction uses `createElement` + `textContent` only (no
    `innerHTML`) so untrusted strings can't escape into HTML
    structure.
  - `buildInspectorPayload` is a pure helper; 4 unit tests cover
    mod-mode, lst-mode, missing-decl-after-edit, and null-model
    paths.

- **Run-button-with-dropdown in editor title for `.mod` / `.ctl`
  files.** Adds `Run Current Model` (primary, $(play) icon) and
  `Show NMTRAN Parsed Model (Debug)` to the `editor/title/run`
  menu group, gated on `resourceLangId == nmtran || resourceExtname
  == .mod || resourceExtname == .ctl`. Mirrors Positron's R Markdown
  pattern: ▶ click runs the model; chevron exposes secondary actions.

### Changed

- **Variables pane is now permanently init-only.** Dropped the
  fit-augmentation hack added in M6-finish (v0.0.46) — Positron's
  Variables comm caches row metadata (has_viewer, display_type) in
  ways that fight live restructuring between mod-mode and lst-mode
  pushes. Fit/converged display moved to the Fit Inspector WebView
  where we own the rendering. `setParsedModel(model, uri)` no longer
  takes a `fit` parameter; `mapParsedModelToVariables(model)` no
  longer takes one either. Tests for the dropped fit path moved
  into `fit-inspector-payload.test.ts`.

### Changed

- **lst-mode UX redesigned: final value is the value, init is a
  decoration, no view button.** Per user feedback (".lst is read-only
  output, .mod is the editable source"), the Variables pane in
  lst-mode now renders parameters as:
    `display_value` = the converged FINAL estimate (e.g. `2.523`)
    `display_type` = `init <init> · SE <se>` (decoration)
    `has_viewer` = `false` (no double-click jump-to-decl)
  Replaces the previous `<init> | <final>` two-column display. The
  final estimate is the primary number the user is consulting the
  .lst for; init + SE stay one glance away as type-column
  decoration. Positron hides display_type behind a "View" button
  when has_viewer is true, so disabling it keeps init + SE visible.
  Mod-mode (`.mod` / `.ctl`) behaviour unchanged: init in display_value,
  has_viewer true (jump-to-decl preserved).

### Fixed

- **Active editor with `languageId === 'nmtran'` on a `.lst` was eating
  lst-mode dispatch.** `isNmtranEditor` returned true purely on
  languageId, so vscode-nmtran setting `nmtran` on `.lst` files (or
  any `.lst` opened in an nmtran-aware editor) routed through the
  mod-mode branch with the .lst URI, never hitting the lst-mode
  resolver. resolveVariablesContext now branches on file extension
  FIRST (`.lst` → lst-mode, `.mod` / `.ctl` → mod-mode, then fall
  through to `languageId === 'nmtran'` for non-standard-extension
  edge cases). Diagnostic logging at entry now emits `activeEditor:
  <path> langId=<id> ext=<ext>` so future "no fit shown" reports
  identify which branch took the editor in one log line.

### Fixed

- **Duplicate Active Runs entry on completion (`32s` + `0ms` rows for one
  run).** The watcher's `.lst` create/change handler was completing the
  tracker entry before `runModel.then` resolved; the .then's
  find-by-`state === 'running'` then missed the watcher's already-`done`
  row and synthetic-registered a duplicate. Reconciliation now uses a
  `startedAt >= dispatchedAt` window — the timestamp captured at
  `runCurrentModel` entry — so any entry the watcher made for THIS
  dispatch is found regardless of state, while stale `done`/`failed`
  rows from earlier runs of the same .mod stay outside the window.
  Extracted as `reconcileCompletion` / `reconcileFailure` pure helpers
  in `active-runs-tracker.ts` with 5 regression-guard tests.

- **lst-mode silently shows init-only when `.mod` hasn't been opened
  as an editor.** vscode-nmtran's language server only parses
  documents it's seen; opening just the `.lst` left the `.mod`
  unparsed, so `getParsedModel(modUri)` returned null and the lst-mode
  branch fell through. Fix: force-load the sibling `.mod` via
  `vscode.workspace.openTextDocument(modUri)` before requesting the
  parsed model. No editor tab is opened — only the document model is
  populated. Diagnostic logging on the lst-mode resolver now emits
  `[positron-nonmem][vars] lst-mode: …` lines to the Output channel
  for every step, so future "no fit shown" reports are debuggable
  from logs alone.

### Added

- **M6-finish — Variables pane in `.lst` mode (two-column init | final).**
  Open a `<basename>.lst` whose run produced a `<basename>.ext` and the
  Variables pane renders parameters as `<init> | <final>` with SE on the
  type column (e.g. `1.5 (0..10) | 2.523` / `theta · SE 0.123`). When
  `$COV` was skipped/failed the SE row is all-zeros; we drop it and
  render `—` instead of misleading `SE 0`. Equations stay
  init-evaluated for now (re-eval with finals lands when we own the
  evaluator end-to-end).
  - `.ext` discovery cascade: top-level sibling first
    (Pirana / nmfe-direct), then highest-N
    `<dir>/modelfit_dir<N>/<basename>.ext` (PsN with our default
    `-nm_output=ext,...`).
  - Source URI passed to `setParsedModel` is the **`.mod`** even in
    lst-mode, so view-RPC click-to-source still navigates to decls.
  - `.mod` / `.ctl` editors: behaviour unchanged (init-only display).
  - New modules: `src/runtime/parse-ext-fit.ts` (NONMEM 7
    `-1000000000` final + `-1000000001` SE row parser; rewrites
    `THETA1` → `THETA(1)` to match our access_key convention) and
    `src/runtime/find-ext-file.ts` (locator cascade). 11 new unit
    tests cover parser, locator, and fit-augmented rendering.

### Added

- **M10 — Promote Estimates to New Model.** Right-click a `done`
  Active Runs entry → input box prefilled with the bumped name
  (`run001.mod` → `run002.mod`; non-numeric stems fall back to Pirana's
  `+N` convention, `m.mod` → `m+1.mod`). Shells out to PsN's
  `update_inits`, opens the new `.mod` in an editor, refreshes the
  Runs tree. Verified empirically against PsN 5.3.1 in
  `docs/psn-notes.md`. Hidden from the command palette
  (right-click-only). New module `src/runtime/promote-estimates.ts`
  with 7 unit tests covering name-bump, command-build, and runner
  end-to-end (success / non-zero exit / missing-output paths).

### Fixed

- **Non-zero `EXIT` from `execute` is now treated as failure** even
  when `.lst` was produced. Previously a `EXIT=255` run (NONMEM
  crashed mid-estimation, MINIMIZATION TERMINATED escalated to a
  PsN error, etc.) would mark the tracker entry as `done` because
  `.lst` existed. Now `runModel` throws when `exitCode !== 0`,
  carrying the parsed PsN/NMtran error plus an `execute exited with
  code <N>; .lst was produced — review for termination messages.`
  preamble.

### Added

- **Click a failed Active Runs entry → opens the full error.**
  Replaces the previous transient warning toast. Prefers `NM_run1/FMSG`
  (NONMEM's canonical error file with rich NMtran detail) when
  available; otherwise opens a virtual readonly document carrying
  the full parsed PsN/NMtran message **including the Perl trailer**
  (`at /usr/local/share/perl/.../*.pm line NNN`). Useful for
  debugging; copy-paste-friendly. The trailer is no longer stripped
  in `diagnoseFailure` — clean enough to keep, diagnostically useful.

### Fixed

- **runCurrentModel now synthetic-registers tracker entries on
  success** (mirrors the existing failure-path fallback). Previously,
  successful runs could be silently absent from Active Runs if the
  FS-watcher missed the `psn.mod` create event. Now: on
  `runModel.then(success)`, if no matching "running" entry exists,
  a fresh entry is registered and immediately marked complete with
  the OFV / runDir / lstPath from runModel's parsed result. Active
  Runs always reflects every Run-Current-Model invocation.

- **Watcher now logs every event to the Output channel** for
  diagnostic visibility (`watcher: psn.mod created at <path>`,
  `watcher: skipped (no model name found …)`, etc.). When the user
  reports "no entry appeared", the Output channel now tells us
  whether the event fired and was dropped, vs. never fired at all.

- **Watcher dedupes against existing entries** when both
  `runCurrentModel` and the FS-watcher try to register the same run
  (e.g. workspace-included path). The watcher now checks for an
  existing "running" entry with matching modelPath and reuses it
  rather than creating a duplicate.

### Fixed

- **PsN early-die failures (e.g. `$BAD_RECORD`) now surface in
  Active Runs.** When PsN bails out during record validation
  (BEFORE creating `NM_run1/psn.mod`), the FS-watcher never sees a
  filesystem event and would have left the user with no UI feedback.
  Two changes close this:
  1. `diagnoseFailure` recognises generic PsN early-die messages
     (anything starting with `PsN ` on stderr/stdout); the Perl
     `at /path/file.pm line NNN` trailer is stripped consistently
     via a new `stripPerlTrailer` helper.
  2. `runCurrentModel`'s rejection handler **synthetically registers
     a failed tracker entry** when no matching "running" entry
     exists. The user sees a red x with the parsed PsN message
     immediately, not silent failure.

- **NMtran failures now transition Active Runs entries to "failed".**
  The FS-watcher only completes runs via `<basename>.lst` create/change
  events, but NMtran failures don't produce a .lst → entries would
  spin forever. `runModel`'s rejection path now bridges to
  `tracker.markFailed` for the matching running entry, so the parsed
  PsN/NMtran error message lands on the tree (red x with tooltip).

### Changed

- **`active-runs-tracker.ts` moved from `src/views/` to `src/runtime/`.**
  It's a domain-model state machine with zero vscode dependency
  (`chooseRunAction` is a pure function). Path was misleading future
  readers expecting `src/views/` to contain UI concerns. Tracker test
  moved alongside.

- **Doc fixes**: `run-progress.ts` header comment was stale (claimed
  used by `runCurrentModel`; actually used by `ActiveRunsWatcher`).
  Comment in `runtime-session.ts` clarifying that the
  `isExecuteModelRun` regex (Console-output suppression) and the
  FS-watcher (run discovery) are deliberately independent signals.

### Changed

- **Runs view is now hierarchical (file-explorer style).** Common
  workspace-relative ancestors collapse into expandable folder nodes;
  click a chevron to expand, click a label to open the run's primary
  `.lst`. A directory that's both a run AND a parent of more runs
  (e.g. `slow/` with its own `run001.lst` plus `modelfit_dir1/…7/`
  inside) renders as a hybrid: clickable AND expandable. Pure
  `buildRunsTree` helper in `runs-tree-builder.ts`, separately tested
  (8 new tests), wraps the existing flat-discovery output without
  changing it.

### Fixed

- **Console prompt redraws immediately for model runs.** `dispatch`
  was awaiting `runner.run` for the full ~30s+ run wall, so the
  session stayed Busy for that long after typing
  `cd '…' && execute run001.mod`. Now fire-and-forget for model runs
  (Active Runs tracks completion via FS events, not via the dispatch
  await chain).

- **Active Runs entries store the per-run `.lst` path**
  (`<runDir>/<basename>.lst` inside `modelfit_dir<N>/`) instead of
  the top-level `<modelDir>/<basename>.lst`. The top-level path gets
  overwritten on every re-run, so an old "done" entry's
  click-to-LST was showing the new run's content. Per-run snapshot
  preserves history.

- **Active Runs spinner now transitions to "done" on re-runs.** The
  watcher only listened to `**/*.lst` `onDidCreate`, but PsN
  *overwrites* the .lst when the file already exists from a previous
  run — vscode fires `onDidChange`, not `onDidCreate`. Listening to
  both events now. Idempotent — the running-state guard means a
  successful create + spurious change after that don't double-mark.

- **Console-typed `execute run001.mod` no longer floods the Console.**
  `NonmemSession.dispatch` detects model-run invocations
  (`isExecuteModelRun` regex — also matches the canonical
  `cd '…' && execute …` and any with flags) and suppresses
  stdout/stderr emission for them; emits a single
  `[NONMEM run dispatched — see Active Runs in the NONMEM activity pane]`
  pointer line instead. Other PsN tools (`sumo`, `update_inits`,
  `vpc`, …) keep their normal output — those are informational and
  brief.

### Changed

- **`ActiveRunsWatcher` is now the single source of truth for run
  registration.** Workspace-wide FS watcher on `**/NM_run1/psn.mod`
  (PsN's universal setup-phase signature) discovers every run
  regardless of how it was launched — Run Current Model, Console-typed
  `execute run001.mod`, runs started from external terminals.
  Completion via `**/<basename>.lst` create. `runCurrentModel` is now
  a thin shim — fires the run, returns; the watcher does all
  tracking. Empirically validated against `-clean=0..5` and the
  `-directory=` / `-model_dir_name` / `-model_subdir` variants in PsN
  v5.3.1 (see `docs/psn-notes.md` "Clean-level effects").

  Helpers in `active-runs-watcher.ts`: `parseTranslationFile` (PsN's
  `model_NMrun_translation.txt`), `parseCommandTxt` (fallback for
  clean ≥ 2), `findCallingCwd` (walks up from runDir looking for the
  .mod file — handles every PsN dir-naming variant). 12 unit tests +
  4 tracker tests cover the helpers.

  Race fix in the progress poller: in-flight ticks now check `stopped`
  at every await, so a `.stop()` call mid-fs-read no longer leaks a
  spurious `onProgress` for content written after the stop.

### Added

- **Live iteration progress in Active Runs entries.** While a run is in
  flight, the description shows `iter 47, OFV=4.532 · 12s` instead of
  just `running for 12s`. Mechanism:
  - `src/runtime/run-progress.ts` polls `<modelfit_dir<N>>/NM_run1/psn.ext`
    every 500ms during the run, parses the latest non-sentinel iteration
    row (column 1 = iter, last column = OBJ), dedupes same-iter ticks.
  - `tracker.updateProgress(runId, { iter, ofv })` updates the run's
    `currentIter` / `currentOfv` and fires `onDidChange` so the tree
    re-renders.
  - Poll lifecycle: started in `runCurrentModel` alongside the dispatched
    `runModel` promise; stopped in both `.then` and `.catch` so no
    dangling timers after completion.
  - Negative-iteration sentinel rows (`-1000000000`-class) NONMEM writes
    after estimation are skipped — they're not real iterations.
  - 9 e2e tests cover the parser (5) and the poller lifecycle (3 with
    real timers + tmp dirs); 2 new tracker tests cover `updateProgress`
    in running and post-completion states.

### Changed

- **`chooseRunAction` extracted as a pure decision helper** (in
  `active-runs-tracker.ts`). The click-dispatch policy (running →
  OUTPUT, done → .lst, failed → toast) used to live inline in
  `extension.ts`'s `openRun`; it now returns a `RunOpenAction` discriminated
  union and the side-effecting bits stay in extension.ts. Snapshots
  `run.state` at entry so concurrent transitions during the
  `findRunDir` await don't flip the branch — the user sees the file
  appropriate to the moment they clicked.

- **`ActiveRun.lstPath` populated by `markCompleted`** so `openRun` no
  longer re-derives the .lst path. Single source of truth (PsN's
  `RunModelResult.lstPath`) flows through the tracker.

- **Activity-bar icon circle r=10** (was 10.5). Outer-edge math now
  fits inside the 12-unit half-width comfortably; was clipping at the
  edge of the icon container at small render sizes.

### Changed

- **Custom activity-bar icon.** Replaces the stock `$(beaker)` codicon
  with `media/nonmem-icon.svg`: a circle with "NM" inside, drawn as
  paths (not `<text>`) so rendering is consistent across platforms.
  Uses `currentColor` so light/dark themes color it correctly.

### Added

- **Click an Active Runs entry to open its output.** Click handler
  dispatches by run state:
  - **running** → opens `<modelfit_dir<N>>/NM_run1/OUTPUT`, the live
    iteration printout NONMEM writes line-by-line during estimation.
    VS Code reloads the file as it grows.
  - **done** → opens the final `<basename>.lst` next to the .mod.
  - **failed** → toasts the parsed PsN/NMtran error message
    (NMtran failures don't produce a .lst).

  Single command (`positronNonmem.openRun`) keyed by run id; the
  branch logic lives in `extension.ts`, the tree provider stays
  policy-free.

### Changed

- **Tooltip timestamps are now `YYYY-MM-DD HH:MM:SS` (24h, local).**
  Was `toLocaleString()` — locale-dependent and inconsistent across
  user machines. New `formatTimestamp` helper is locale-stable.

- `feat: Run Current Model now executes in the background`. The command
  fires `psn execute` and returns immediately — no longer awaits, no
  longer pipes stdout to anywhere visible. Multiple models can run in
  parallel; each is an independent child process via `runner.run`.

### Added

- **Active Runs tree view in the NONMEM activity pane.** Sibling to the
  existing "Runs" view: lists models launched this session with a
  spinner / check / x icon for state, description showing
  `OFV=… · 12s` (or elapsed time while running, or `failed · 3s` on
  error), tooltip with full details (model path, started/finished
  timestamps, runDir, error message). Clicking a finished run opens
  the `.lst`. The two views complement each other: "Active Runs"
  answers "what's running now / just ran?", "Runs" answers "what
  completed runs are on disk?".

- `src/views/active-runs-tracker.ts` — pure state machine
  (`start` → `markCompleted` / `markFailed`), no vscode dependency.
  5 unit tests cover transitions, parallel runs, and silent no-op
  on unknown ids. The tree provider is the only vscode bridge.

### Added

- **`-nm_output=ext,phi,cov,cor,coi` passed by default**, so PsN copies
  the NM7 aux files into `modelfit_dirN/<basename>.<ext>` (as
  `m.ext`, `m.phi`, …) rather than leaving them buried inside
  `NM_run1/psn.<ext>`. The Variables pane and a future `sumo`-backed
  summary command can now read them at predictable paths. Caller can
  override the extension list (`nmOutputExtensions`) or pass `[]` to
  opt out.

- **`runDir` returned from `runModel`.** After a successful run we scan
  the `.mod`'s parent directory for `modelfit_dir<N>` and return the
  highest-numbered match. Logged to the Output channel as
  `runModel: aux files in <runDir>`. Future summary / Variables-pane
  refresh commands take this as input rather than re-discovering it.

- **Privacy scrubber for stdout / stderr.** PsN/NONMEM print
  `Manager Location <hostname>//home/<user-email>/...` and
  `License Registered to: <organization>` lines verbatim — the host's
  real name, the running user's email, and the org name all leak into
  the Console pane. `src/scrub.ts` redacts those values (keeping the
  marker line so a debugger can tell what was scrubbed) plus generic
  `/home/<user>/...` path components and bare email tokens. Wired
  through `NonmemSession.dispatch` (Console streams) and
  `runModel`'s failure path (defense-in-depth).

### Changed

- `feat: register one runtime per psn.conf [nm_versions] entry`. The
  Positron runtime picker now lists exactly the labels you've configured
  in `~/psn.conf` (or the bundled PsN default) — `default`, `74`, `75`,
  etc. — instead of the synthetic "highest-version nmfe binary on disk"
  derived in chunk A. The picked label flows to runModel as
  `-nm_version=<label>`, so `psn execute` resolves the matching NONMEM
  install. Phantom entries (label points at a missing dir) are dropped
  at activation time and reported on the Output channel — picking them
  would fail at run time anyway.

- `feat: -nm_version=<label>` is now passed through to `execute` when the
  active session targets a non-default psn.conf entry.

### Removed

- **`positronNonmem.nmfeBinary` setting.** Override via `~/psn.conf`
  instead — it's PsN's source of truth for NONMEM versions, no need
  for a parallel mechanism in the extension. (`positronNonmem.nmfeBinary`
  was a pre-PsN-runner artefact.)

- **`src/nmfe-detect.ts` + `parseNonmemVersion`** — superseded by
  `fetchNmVersions` (psn.conf-driven).

### Changed (chunk A)

- `feat: runModel drives PsN execute instead of direct nmfe`. PsN's
  `execute` is "an nmfe replacement with advanced extra functionality"
  per its own help text — it handles dataset copy-in, output collection,
  and (later, off by default) retries/parallel runs. The runModel
  command now invokes `execute m.mod` in the .mod's directory and PsN
  copies the resulting `.lst` back next to the .mod. Hard dep: if PsN's
  `execute` isn't on `$PATH`, the run fails with a clean error.

### Added

- **NMtran-failure detection.** `execute` exits 0 even when NMtran
  rejected the model (no `.lst` produced) — RC alone can't tell us. We
  now check for the `.lst` after the run and, if missing, parse PsN's
  output for `NMtran failed.` / `No NONMEM version with name "X" defined
  in psn.conf` and throw with the parsed message. The user sees the
  actual NMtran error code instead of a "OFV=null" toast.

- **`docs/psn-notes.md`** — empirical reference for PsN's CLI surface,
  output layout, exit-code semantics, and per-tool roadmap. Pinned to
  v5.3.1 (the version on qphcmp03); 5.4+ features (`$PSNCONFPATH`)
  off-limits unless we explicitly bump.

- **`.vscodeignore`** — VSIX now contains only runtime artefacts
  (`out/extension.{js,js.map}`, package.json, LICENSE, README,
  CHANGELOG). Shrinks the package from ~88 KB to ~29 KB; keeps
  devtime sources (`src/`, `test/`, `.vscode/`, `.remember/`,
  `docs/`, build/lint configs) out of the published bundle.

## [0.0.27] — 2026-05-03

### Removed

- **PsN dependency dropped from nmfe detection** (note: chunk A in
  Unreleased re-introduces a hard dep on PsN as the *runner*; this entry
  is about *detection* only, which never needed PsN). Detection no
  longer shells out to `psn -nm_versions`. PsN may not be installed;
  even when it is, every install it points at lives under a directory
  the `/opt/nm*/run/` and `/usr/local/nm*/run/` scans already find.
  Removing the dependency simplifies activation, drops an SSH/exec
  round-trip, and removes a failure mode (PsN install corruption
  couldn't break NONMEM detection before, but the indirection invited
  the question).

### Changed

- **`filterExecutable` runs at the merge funnel, not per-source**, so
  every detection source (currently `$PATH` and `/opt|/usr/local/nm*`)
  gets the same `fs.access(binary, X_OK)` sanity check. Dropped entries
  are reported through an optional `onDropped` callback so
  extension.ts can log them to the Output channel for diagnosis.

### Fixed

- `fix: PsN-discovered NONMEMs verified for existence + executability`.
  PsN's `-nm_versions` lists configured installs, not necessarily
  reachable ones — the binary at `<dir>/run/nmfe<MM>` may have moved or
  been removed. We now `fs.access(.., X_OK)` each PsN-derived path and
  drop the ones that fail, so the picker doesn't surface phantoms that
  fail at run time.

### Added

- `feat: multi-version NONMEM picker`. Detection now finds *every* nmfe
  install reachable from the host, not just the highest-version one.
  Each becomes its own runtime in Positron's session picker — pick
  "NONMEM 7.6 (nm760)" or "NONMEM 7.5 (nm751)" depending on what you
  want to run. The session's nmfe binary is read back from
  `runtimeMetadata.extraRuntimeData.nmfeBinary` so subsequent
  `runModel` invocations honor the selection.
  - **Sources, in order**: `psn -nm_versions` (when PsN is installed —
    this is the most authoritative registry of NONMEM installs at sites
    that use PsN), `$PATH` scan for `nmfe<digits>`, common install dirs
    (`/opt/nm*/run/`, `/usr/local/nm*/run/`).
  - **Deduplication**: by canonical binary path; sources don't double-count.
  - **Sort**: highest version first, so the runtime picker shows the
    newest install at the top.
  - **Explicit override** `positronNonmem.nmfeBinary` still wins; when
    set, only that single binary is registered (no auto-detect).
- `feat: auto-detect nmfe* on $PATH`. Leave `positronNonmem.nmfeBinary`
  blank (now the default) and the extension scans every $PATH directory
  for `nmfe<digits>` files, picking the highest-version match
  (e.g. `nmfe76` wins over `nmfe75`). Explicit setting still wins. Logged
  to the Output channel on activation so the user can see what was found.

### Changed

- `chore: parse NONMEM version from the binary basename`. nmfe's stdout
  doesn't reliably carry a version on every install (NONMEM 7.6.0 here
  showed up as "unknown"). The binary name does — `nmfe76` → 7.6,
  `nmfe75` → 7.5, `nmfe7` → 7.0. Now the primary source; banner-line
  scrape is the fallback.

### Changed

- **Architecture: drop our own SSH layer; rely on Positron Remote SSH.**
  We were reimplementing a slice of what Positron Remote SSH already does
  better (alias resolution, control-master sessions, hostname scrubbing,
  banner draining, `~` expansion …) and kept tripping on edge cases. The
  contract now is: the extension must be able to invoke `nmfe76` on the
  host it's running on. Use Positron's Remote SSH to put yourself on a
  host that has NONMEM, or install locally.
  - **Removed**: SSH transport, scp put/get, host-alias settings, host
    profile resolver, `positron-nonmem://` FileSystemProvider, alias-
    keyed runtime metadata, manifest writing, audit log, "Test Connection"
    and "Open Remote Path" debug commands. ~1000 lines deleted.
  - **Replaced**: Transport interface → tiny `Runner` interface (just
    `run(cmd, cwd?)`). Single `LocalRunner` impl wraps `child_process.spawn`.
  - **runModel** now runs `nmfe76` in the .mod's directory with classic
    NONMEM naming: `colistin.mod` → `colistin.lst` next to it. No more
    `pn-<ts>` subdirs, no manifest.json, no `m.lst` rename. Indistinguishable
    from a hand-rolled `nmfe76` invocation — the extension is invisible to
    runs done other ways (Pirana, PsN, hand-rolled).
  - **Runs tree** now scans the open workspace folders via
    `vscode.workspace.findFiles('**/*.lst')` (respects `.gitignore`,
    excludes `node_modules` and `.git`) and emits plain `file://` URIs.
    Auto-refreshes on `.lst` create / change / delete.
  - **Runtime registration** probes `nmfe76` at activation (configurable
    via `positronNonmem.nmfeBinary`). If absent, runtime isn't registered
    and the user gets a one-line "use Remote SSH or install locally"
    message in the Output channel.
  - **Setting** `positronNonmem.nmfeBinary` (default `nmfe76`) replaces
    `positronNonmem.host.alias` / `host.transport` / `runs.root`.
- **`.vscode/launch.json`**: added a "Launch Extension (Remote SSH)"
  config so the dev host can be brought up directly inside a Remote-SSH
  session against the NONMEM box.

### Fixed

- `fix: positron-nonmem:// FS provider stripped leading / on absolute paths`.
  v0.0.21 unconditionally stripped the URI path's leading `/`, which turned
  absolute remote paths (e.g. `/home/<user>/positron-nonmem/pn-X/m.lst` —
  what `find` emits when the user's `$HOME` is involved) into relative
  paths the SSH `cat` resolved against `$HOME`, so opening any tree-view
  row failed with "Unable to resolve nonexistent file". Now the leading
  `/` only strips for tilde-form URIs (`/~/...`); absolute-form URIs keep
  the slash so the path stays absolute on the remote side.

### Added

- `feat: NONMEM Runs tree view (M7 chunk B)`. New activity-bar container
  ("NONMEM" / `$(beaker)` icon) with a "Runs" tree that scans
  `positronNonmem.runs.root` (default `~/positron-nonmem`) for any
  directory containing one or more `.lst` files. Works for our own
  `~/positron-nonmem/<id>/m.lst` layout, Pirana flat dirs, PsN nested
  layouts, and hand-rolled folders.
  - Discovery: `find <root> -maxdepth 4 -type f -name '*.lst' -printf '%h\t%f\t%T@\n'`,
    grouped by parent dir, sorted by most-recent `.lst` mtime descending.
  - Each row's click target is the dir's primary `.lst` (prefers `m.lst`,
    otherwise alphabetically first), opened via the
    `positron-nonmem://` FS provider. No local sync.
  - Refresh button on the view title; auto-refresh on
    `positronNonmem.runs.root` config change and after a successful run.
  - Empty / errored states surface as a single tree row instead of a
    blank pane, so users know the scan ran.

- `feat: positron-nonmem:// FileSystemProvider (M7 chunk A)`. Read-only
  custom FS scheme that translates VSCode FS reads into `Transport` ops
  on demand, so remote run outputs (`m.lst`, `m.ext`, `manifest.json`, …)
  can be opened in editor tabs without local syncing.
  - URIs: `positron-nonmem://<alias>/<remote-path>`. Leading `/` of the
    URI path is stripped; `~/...` paths round-trip cleanly.
  - `Transport` interface gains `stat(remotePath)` and
    `readDirectory(remotePath)`. LocalTransport wraps `fs.lstat` /
    `fs.readdir`; SshTransport shells out to `stat -c '%s|%Y|%F'` /
    `find -maxdepth 1 -mindepth 1 -printf '%f\t%y\n'`.
  - New `RemoteFileNotFoundError` lets the FS provider map missing-path
    errors to `vscode.FileSystemError.FileNotFound`.
  - Debug command `positronNonmem.openRemotePath` prompts for a path
    and opens it via the FS provider; smoke-test surface for chunk A.
  - Lazy transport: factory called on first FS request so activation
    doesn't block on `ssh -G`.
  - Writes (`writeFile` / `delete` / `rename` / `createDirectory`) throw
    NoPermissions; chunk D will lift this for edit-in-place flows.

### Fixed

- `fix: ssh writeFile hung when remote ssh emits stdout banners`. With
  `VisualHostKey yes` (or any other chatty ssh config) the client writes
  fingerprint art to stdout. writeFile() registered a stderr listener
  but no stdout listener, so the OS pipe buffer (~64KB) filled and the
  ssh child blocked forever — the run completed remotely but the manifest
  was never written and no toast surfaced. Now drains stdout symmetrically
  with `run()`.

### Fixed

- `fix: ssh writeFile / readFile broke ~ expansion`. v0.0.17 single-quoted
  the path passed to `cat > / cat`, which made bash treat `~` as a
  literal so `~/positron-nonmem/.../manifest.json` failed with
  "No such file or directory". `quoteRemotePath` now expands a leading
  `~/` to `"$HOME"/` and single-quotes only the rest. Error reporting
  also takes the LAST non-empty line of stderr so the `VisualHostKey yes`
  fingerprint banner doesn't leak into toasts.

### Changed

- **Remote-first architecture (M7-prep).** Run outputs (`m.lst`,
  `m.ext`, `manifest.json`) now stay on the host. Previous behaviour
  pulled `m.lst` + `m.ext` back to `<workspace>/.positron-nonmem/runs/<runId>/`
  and wrote `manifest.json` + `audit.jsonl` locally — all gone.
  - `runModel` no longer accepts `localRunsDir` / `auditLogPath`; result
    drops `lstPath` / `extPath` / `manifestPath` (local) and gains
    `remoteRunDir` / `manifestPath` (remote).
  - OFV is now extracted by `transport.readFile('<remote>/m.lst')` +
    `parseOfv` instead of downloading the file.
  - Manifest is written via `transport.writeFile('<remote>/manifest.json', …)`.
  - `audit.jsonl` removed entirely. The tree view (M7) discovers runs by
    scanning the remote root with `find`; the per-developer JSONL audit
    is redundant given that.
  - Constants `LOCAL_RUNS_SUBDIR` / `LOCAL_AUDIT_FILE` removed.
- **`Transport` interface gains `writeFile(remotePath, content)` and
  `readFile(remotePath)`**. `LocalTransport` wraps `fs`; `SshTransport`
  pipes via `ssh <alias> 'cat > path'` (write) / `ssh <alias> 'cat path'`
  (read), with the path single-quoted to defend against exotic names.

- `chore: equation display_name prefixes the owning $RECORD`. Setting
  `has_viewer: true` causes Positron's frontend to replace the
  display_type cell with the View action button, hiding the `$PRED` /
  `$PK` / `$ERROR` / … label that lived there. The block is now prepended
  to display_name (`$PRED: Y`) so the context stays visible AND the
  alphabetic sort groups equations by record. access_key is unchanged
  (`Y`), so view-RPC lookup still resolves correctly.

### Added

- `feat: parameter rows (THETA / OMEGA / SIGMA) navigate to declaration`.
  Builds on the equation goto-definition shipped in 0.0.13. With
  vscode-nmtran >= 0.4.18 (which now exposes `line` on `ThetaDecl` /
  `OmegaSigmaDecl`), every parameter row in the Variables pane is
  navigable. `resolveAccessKeyLine(model, accessKey)` parses
  `THETA(n)` / `OMEGA(n,n)` / `SIGMA(n,n)` and looks up the matching
  decl. Off-diagonal `OMEGA(i,j)` (i≠j) and unknown access_keys fall
  through to no-op. Older vscode-nmtran releases (no `line` on params)
  degrade gracefully — `has_viewer` stays `false` so we don't advertise
  a dead navigation.

### Fixed

- `fix: Variables-pane "View Queued…" stuck after first double-click`.
  Inbound `view` / `list` RPCs now get a JSON-RPC 2.0 response correlated
  via `parent_id = message_id` so Positron's frontend resolves the
  pending request. Without the reply the per-row in-flight tracker
  blocked further double-clicks until the comm was torn down. Same
  treatment applied to `list` for symmetry — frontend was tolerant of
  the missing reply but it wasn't strictly correct.

### Added

- `feat: Variables-pane double-click jumps to equation source`. Equation rows
  ($PRED / $PK / $ERROR / $DES assignments) now carry `has_viewer: true`, so
  Positron's frontend issues a `view` RPC on double-click. The session
  resolves the access_key against `currentParsedModel.equations`, looks up
  the line stored on each Equation, and opens the source `.mod` editor at
  that position via an injected `navigator` callback.

### Changed

- `chore: round Variables-pane display values to 3 decimal places`. THETA inits,
  OMEGA/SIGMA values, equation results — all formatted via the same helper:
  max 3 decimals, trailing zeros dropped (so `0.5` not `0.500`, integers stay
  integers), scientific notation for extremes (`>= 1e7` or non-zero `< 1e-3`)
  so we don't silently lose tiny values to "0.000". Underlying numbers in the
  model file are unchanged; only the display string rounds.

- `chore: equation display_type now shows owning control record`. Previously the
  Variables-pane right column read `equation = THETA(1) + ETA(1) + EPS(1)` for
  every equation row — duplicating the rhs already encoded in `display_value`
  for unevaluable equations and adding noise for evaluable ones. Now it shows
  the owning block (`$PRED`, `$PK`, `$ERROR`, `$DES`, etc.). Concise, says
  where the binding is defined.

- `chore: split parameters from derived equations in Variables pane`. Declared
  THETA / OMEGA / SIGMA now use `kind: 'class'`, so Positron's frontend
  (group names hard-coded to Data / Values / Functions / Classes) puts them
  under "CLASSES" while equations stay in "VALUES". Mild semantic compromise
  on the label — proper "PARAMETERS" / "VARIABLES" headings would require a
  custom TreeDataProvider view (deferred). Variable.kind enum widened to the
  full OpenRPC spec set so future chunks can use 'table' / 'function' / etc.

### Added

- `feat: NONMEM runtime icon` — bold "NM" monogram on a teal rounded square
  shows in the Positron session picker, distinguishing it from R (blue) and
  Python. SVG is inlined and base64-encoded at module load; no asset file IO.

### Fixed

- `fix: Variables comm wire format`. v0.0.7 used the legacy `{msg_type, ...}`
  envelope from positron-javascript's `variables.ts` reference, which the
  current Positron frontend drops as "unexpected message". The actual wire
  format is JSON-RPC per `positron/comms/variables-frontend-openrpc.json`:
  outbound events use `{method: 'refresh', params: {variables, length, version}}`.
  Inbound RPCs are `list / clear / delete / inspect / clipboard_format / view` —
  we currently respond to `list` only by re-pushing a refresh. Also added the
  spec-required `updated_time` field on each Variable.

### Added

- `feat: file-context-aware Variables pane`. NONMEM sessions now serve a
  `RuntimeClientType.Variables` comm whose contents reflect the *active
  NMTRAN file's declarations*, not a runtime environment. Each THETA/OMEGA/
  SIGMA shows its declared value; each `name = rhs` assignment in
  `$PRED`/`$PK`/`$ERROR`/etc. shows its evaluated value (or the rhs text when
  not evaluable). When the active editor switches, the model is re-fetched
  via vscode-nmtran's `getParsedModel(uri)` API and pushed to all open
  Variables comms via the wire format documented in `positron-javascript`'s
  reference: `{msg_type: 'list', variables, length}` outbound,
  `{msg_type: 'refresh'}` inbound.

- `feat: NmtranClient + Show NMTRAN Parsed Model (Debug) command`. Bridges to
  vscode-nmtran's public `getParsedModel(uri)` API via
  `vscode.extensions.getExtension('vrognas.nmtran').activate()`. The debug
  command opens the parsed-model JSON in a new editor; verifies the
  cross-extension API path before Variables-pane wiring lands.

### Changed

- `chore: drop hard dependency on vscode-nmtran`. Removed
  `extensionDependencies: ["vrognas.nmtran"]`. The two extensions now install
  independently — positron-nonmem provides runtime/runModel; vscode-nmtran
  provides syntax/IDE features. Without vscode-nmtran installed, the parsed-
  model and (future) Variables-pane features silently degrade; runModel still
  works on `.mod` / `.ctl` files (we now match by file extension as a fallback
  when languageId isn't `nmtran`).

### Added

- `feat: per-run manifest.json + workspace audit.jsonl` (M3 chunk 3C).
  Each run writes `<workspace>/.positron-nonmem/runs/<runId>/manifest.json`
  with `{runId, started, completed, exitCode, ofv, modelHash, datasetHash,
  nmfeBinary, nonmemVersion, hostAlias, parentRunId?}`, and appends one
  JSON line per run to `<workspace>/.positron-nonmem/audit.jsonl`. Hashes
  are sha256 of the uploaded files. Privacy: only the alias is recorded
  — never the resolved hostname.

- `feat: parse OFV from m.lst, pull m.ext` (M3 chunk 3B). `runModel` now
  also downloads `m.ext` (parameter trajectory; sets up future Variables-pane
  wiring) and parses the OFV from `m.lst`'s `#OBJV:` banner line. Toast now
  reads `Run <runId>: EXIT=0, OFV=-20.5421` when the value is present.
  `RunModelResult` gains `extPath` and `ofv` fields.

### Fixed

- `fix: SshTransport.getFile` now mkdir's the local parent dir before invoking scp.
  scp doesn't auto-create destinations and would fail with `open local "...": No such
  file or directory` whenever the workspace's `.positron-nonmem/runs/<runId>/` didn't
  already exist. Mirrors LocalTransport.getFile semantics. Also documented scp's
  banner-on-stderr quirk in `docs/empirical-notes.md`.

### Added

- `feat: positronNonmem.runModel` command (M3 chunk 3A) — sftp `.mod` (and `$DATA`-referenced
  dataset sibling) to `~/positron-nonmem/<runId>/`, run `nmfe76`, pull `m.lst` back to
  `<workspace>/.positron-nonmem/runs/<runId>/`, surface EXIT code in an info-message. No
  Variables-pane / OFV / manifest / audit yet — those land in chunks 3B–3D.
- `Transport.putFile` / `Transport.getFile` for both `LocalTransport` (`fs.copyFile` + `~`
  expansion to `os.homedir()`) and `SshTransport` (spawn `scp` with `BatchMode=yes`).

### Changed

- **SSH transport now shells out to the system `ssh` CLI**, defering entirely to
  `~/.ssh/config` (HostName / User / Port / IdentityFile / ProxyJump / ControlMaster
  resolved by OpenSSH). Removes the `ssh2` library dependency. Settings collapse to
  a single field: `positronNonmem.host.alias`. The 7 previously-required fields
  (user, host, port, auth, privateKeyPath, remoteWorkspace, nmfeBinary, nonmemVersion)
  are gone — the first 5 are unnecessary because OpenSSH already knows them; the
  last 3 will return when their respective milestones land (M2+).
- Privacy: scrubbing now uses the HostName resolved by `ssh -G <alias>` (cached
  per-alias) so DNS / connection-refused stderr from the ssh CLI never leaks the
  hostname into the Output channel or toasts.
- Diagnostic: `ssh -G <alias>` echoing the alias as the resolved HostName surfaces
  as a clear "no Host block matched in ~/.ssh/config" error rather than a silent
  network failure.

### Removed

- `ssh2`, `@types/ssh2` runtime dependencies.
- `expandEnvVars` / `expandHomeDir` helpers in `host-profiles.ts` (no longer needed).
- `${env:VAR}` indirection pattern from settings (replaced by SSH config).

## [0.0.1] — 2026-05-02

### Added

- Repo scaffold (M0): TypeScript + esbuild + vitest + eslint + prettier; mirrors the
  sven / redmyne / vscode-nmtran convention.
- `positronNonmem.testConnection` command (M1): opens an SSH connection to the
  configured host (alias-only logging), runs `uname -a`, surfaces output in the
  "Positron NONMEM" channel.
- `host-profiles.ts` with `${env:VAR}` indirection so hostnames never land in committed
  configs.
- `ssh-transport.ts` wrapping the ssh2 library; supports `ssh-agent` and `ssh-key` auth.
- Vitest unit tests for env-var expansion, home-directory expansion, and host-profile
  validation.

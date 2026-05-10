# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely.

## [Unreleased]

### Added

- **feat: `.lst $EST` echo parser — recovers info XML loses (v0.0.178).** Empirically proven (NM 7.6.0) that the XML's `<nm:estimation_options>` element flattens user intent in two ways: (1) **NOABORT vs NOHABORT** — both emit identical `abort='no'` even though Bauer's docs distinguish them (NOABORT = theta-recovery + force most non-PD Hessian PD; NOHABORT = PD correction at all levels, more aggressive). (2) **PRINT, POSTHOC, AUTO=0/1, CENTERING, ETABARCHECK, NOSORT** — user-typed tokens that XML never emits, even when set. Verified via 42-probe sweep at `~/positron-nonmem/probe-attrs-survey/` showing each option produces identical XML to bare $EST. New `parse-lst-est-records.ts` extracts verbatim `$EST` records from the `.lst`'s embedded control-stream echo (reuses existing `extractControlStream`); preserves user's literal tokens including NOABORT/NOHABORT distinction. Wired through InspectorDiagnostics + Fit Inspector renderer: each step's `$EST options` block now annotates the `abort='no'` row's tooltip with which token the user wrote (NOABORT vs NOHABORT vs unknown), and appends an "Also typed (invisible to XML):" caption listing tokens like `PRINT=10` `POSTHOC` etc. when present. 11 new tests for the parser covering all `$EST` keyword aliases ($EST/$ESTM/$ESTIMATE/$ESTIMATION), continuation lines, `;` comment stripping, comma- and whitespace-separated tokens, and the NOABORT/NOHABORT preservation case. Suite to 403/403.

### Changed

- **fix + refactor: $COV tier classification (v0.0.177).** Two production bugs from v0.0.176 + DRY/KISS review fixes, batched into one ship: (1) **`cov_atol='-1'` rendered yellow when $EST was also at default** — propagated tier was too aggressive; "look at $EST for the effective value" is meaningless when $EST is itself at the default. New rule: `cov_*='-1'` only triggers propagated-yellow when the corresponding $EST sibling is itself non-default. We cross-reference the LAST $EST step's options at payload-build time. Posdef removed from PROPAGATION_SOURCES (method-determined default, not propagation); tol removed (chain skips $EST through $SUBROUTINES, no sibling to cross-reference). (2) **`sirsample='BLANK'` rendered green** — `'BLANK'` is NM's not-set default sentinel, not a user setting; user-driven tier now requires the value to differ from the baseline default (so `seed='11456'` matches default and renders normal too — was always-green before). (3) **DRY/KISS refactor**: collapsed three exported helpers (`findCovNonDefaultKeys` / `findCovPropagatedKeys` / `findCovUserDrivenKeys`) into a single `classifyCovKeys(cov, lastEst)` returning `Record<key, tier>`. Tier-precedence is now encoded in one place (was duplicated in renderer's `.includes()` cascade). Renderer becomes a single map lookup per cell. (4) Dropped `/g` flag + `[...matchAll()][0]` materialisation in `parse-xml-problem-options.ts` — only one `<nm:problem_options>` per problem, plain `match()` is enough. (5) Tightened SIR detection: `Number(opts.sirsample) > 0` (was `'sirsample' in opts && opts.sirsample !== 'BLANK'` — would mis-fire on `sirsample='0'`). 13 cov-defaults tests rewritten for the single-classifier API; suite remains at 392/392.

### Added

- **feat: `$COV options` section in Fit Inspector (v0.0.176).** Mirrors the v0.0.155+ `$EST options` section — same exhaustive option-dump pattern, expandable, three-tier coloring, but for the covariance step. Empirical NM 7.6.0 probing confirmed: NM does NOT emit a dedicated `<nm:covariance_options>` element; instead `<nm:problem_options>` carries `nm:cov_<knob>` attrs (22 attrs in the bare-$COV baseline, +14 SIR-block attrs when SIRSAMPLE>0). New `parse-xml-problem-options.ts` extracts `cov_*` attrs (returns null when no $COV record at all — distinct from `cov_omitted='yes'` which signals explicit `$COV OMITTED`). New `xml-cov-defaults.ts` with BARE_COV + SIR_BLOCK composition + four-tier classification: green = user-driven (file, format, seed, sirsample, sirniter), **yellow = propagated** (`-1` sentinel meaning "inherits from $EST / $SUBS / method default" — atol, tol, siglcov, siglocov, knuthsumoff, posdef), blue = non-default vs empirical baseline, normal = default. The yellow/propagated tier is new and $COV-specific; "actual effective value isn't here, look at $EST" is an important user signal that doesn't apply to $EST options. Resolved doc contradiction: `cov_thbnd='1'` is the actual emitted default (Bauer's $COV reference contradicted itself between two paragraphs). 18 new tests in test/runtime/parse-xml-problem-options.test.ts + test/runtime/xml-cov-defaults.test.ts. Suite to 392/392.

### Changed

- **fix: cond + termination-codes UI polish (v0.0.175).** Three small UX fixes off the v0.0.174 reorg: (1) renamed `cond X` → `Condition number: X` in the diagnostics line and made the threshold colouring (`warn > 100` yellow / `bad > 1000` red) actually fire — globalised the `.meta-warn` / `.meta-bad` / `.meta-good` selectors so they apply outside `.meta` parents (was a CSS scoping bug — semantic colour classes shouldn't require a specific ancestor). (2) Renamed `term codes:` → `Termination codes:` and labelled the codes via a new `textmsgsCodeLabel()` empirically probed against `/opt/nm760/source/TEXTMSGS.f90` (e.g. `54` → `54 (rounding errors)`, `134` → `134 (rounding (ERROR=134))`, `50` → `50 (MINIMIZATION TERMINATED)`). Coverage limited to the codes confirmed by reading the NM 7.6.0 source; unknowns render bare. (3) Updated the tooltip on the codes line to explain the structure: first code = FORTRAN-runtime ERROR=N value, subsequent codes = TEXTMSGS.f90 line indices that compose the verbatim phrase shown above.

- **refactor: Fit Inspector layout — co-locate identifiability + estimation-flow signals (v0.0.174).** Reorganised the inspector vertical so each topic gets its own section: summary meta line keeps only run-level scalars (runtime, EM-verdict, accept, obs, subj); cond moves out of the meta line into the diagnostics block, merged onto the eigenvalues line (`Eigenvalues: min X · max Y · cond Z`) since cond *is* max/min eigenvalue of the COR matrix — and now sits directly above the correlation red-flags table that uses the same identifiability story. sig-digits moves out of the meta line onto the OFV headline (info-about-the-result, co-located with the result; threshold-coloured red when below the user's $EST NSIG= target). Convergence trajectory + EST options + ETA table become three top-level sections in that order — previously buried inside diagnostics; now: trajectory (estimation dynamics) → EST options (configuration that drove the dynamics) → ETA table (per-individual post-hoc diagnostics). Added `conditionNumber: number | null` to InspectorDiagnostics with the same sumo-first / lst-fallback as before. Removed unused `subHeader()` helper now that ETA uses an h3 like its sibling sections. No behavioural change to the data; pure layout reorg.
- **refactor: DRY extract `COMMON` / `CONDITIONAL` / `EM_BASE` / `MC_BASE` / `IS_DENSITY` baselines + 3 new tests (v0.0.173).** Code review of v0.0.167-172 found ~150 lines of repeated attrs across the 8 method baselines. Extracted five composition layers: `COMMON` (~35 universal attrs), `CONDITIONAL = {...COMMON, cond_estim:'yes'}` (FOCE family base), `EM_BASE = {...CONDITIONAL, ...}` (adds laplace/centered_eta/anneal/auto/constrain/grd/mum + CTYPE-conditional defaults), `MC_BASE` (clockseed/eonly/ranmethod/seed for MC sampling chain), `IS_DENSITY` (iaccept/iscale/mapiter family — IMP/IMPMAP only). Each method now reads as a small spread + method-specific overrides — what's *genuinely different* about each method jumps out. **Bug caught and fixed in the refactor**: HYBRID's baseline incorrectly included `centered_eta='no'`; empirical probe shows HYBRID emits cond_estim only (no centered_eta, no laplace). The new HYBRID = `{...CONDITIONAL, epseta_interaction:'no'}` correctly omits both. Behaviorally harmless before (extra-attr-in-baseline keys are never consulted by `findNonDefaultKeys`'s loop), but baseline-fidelity bug. Three new tests for: empty step routing → ZERO/FO, IMPMAP default mapinter='0' doesn't false-flag, NM 7.7+ unknown attr flags as non-default. Suite to 18/18.

- **docs: empirical-notes entry for `$EST` option defaults work (v0.0.172).** Per CLAUDE.md empirical-validation discipline ("Behavioural assertions that end up in `docs/empirical-notes.md` need their own probe on the live 7.6.0 host"), added a comprehensive `$EST option defaults per method — wire-format coverage limits` section consolidating: probe inventory at `~/positron-nonmem/probe-defaults/`, the seven empirical findings (stable skeleton, classical-method routing, CTYPE-conditional emit, PRINT-dependent cinterval, never-emitted options, IMPMAP/emapinter doc-vs-emit reconciliation, deferred methods), and how-to-apply pointers to `xml-est-defaults.ts` + the nmguides commit. Code unchanged from v0.0.171.

### Added

- **feat: close Category A — CTYPE-conditional defaults + cinterval/PRINT-dependency handling (v0.0.171).** Probed each EM/MC method (SAEM, ITS, IMP, IMPMAP, DIRECT) with `CTYPE=3` set and captured the conditionally-emitted `calpha` / `citer` / `cinterval` defaults. Added `calpha='5.000000000000000E-02'` and `citer='10'` to all five baselines so user runs with `CTYPE>0` and unmodified CALPHA/CITER no longer false-positive blue. **`cinterval`** moved into `USER_DRIVEN_KEYS` (green tier) rather than the baseline — it defaults to `PRINT`'s value (which itself defaults to 9999), so a user dialing `PRINT=10` cascades to `cinterval=10` without typing it; static baseline can't model that cleanly. Header comment in `xml-est-defaults.ts` rewritten with three coverage-limit categories: (1) conditionally-emitted attrs (RESOLVED in this ship for CTYPE; NUTS family still uncovered), (2) option-dependent defaults (`cinterval`→`PRINT`; handled via USER_DRIVEN_KEYS), (3) options that never emit to XML at all (`PRINT`, `NOSUB`, `OMITTED`, `NOABORT`, `CENTERING` family — fundamental wire-format limitation, no fix possible without a different data source). 2 new tests bring defaults file to 15/15.

### Changed

- **docs: tighten IMPMAP `mapinter` comment with symbol-table evidence (v0.0.170).** The v0.0.169 comment said the resolution is "NM dispatches on the label and runs an internally different code path" — now backed by concrete evidence: `strings`/`nm` inspection of the shipped binary reveals the `__nmbayes_int_MOD_*` namespace contains parallel `mapiter` / `mapinter` (user-set) and `emapiter` / `emapinter` (effective/internal) variables, plus the runtime string `"Mapinter turned on"`. Confirms NM maintains a separate "effective" set internally — the user-set side is what reaches the XML/.lst (and what we mirror), the effective side runs the algorithmic equivalent of the doc's IMPMAP claim. Inspection-only — no disassembly, no decompilation, well within fair use.

- **docs: explain IMPMAP `mapinter` vs doc-claimed equivalence (v0.0.169).** The NM7 doc says `IMPMAP ≡ IMP INTERACTION MAPITER=1 MAPINTER=1` but `<nm:estimation_options>` for default `METHOD=IMPMAP` emits `mapinter='0'` (verified in both `.xml` and `.lst` ESTIMATION OPTIONS block). NM dispatches on the `estimation_method` label internally and runs the IMP-with-interleaved-MAP code path regardless of `mapinter`'s raw value. Added a multi-paragraph comment in `xml-est-defaults.ts` documenting this so a future maintainer doesn't "fix" the IMPMAP baseline by changing `mapinter` to `'1'` (which would mis-flag default IMPMAP runs as customised). No code change — the comment is the fix.

### Added

- **feat: $EST defaults for ZERO/FO + HYBRID + IMPMAP + DIRECT (v0.0.168).** v0.0.167 covered FOCE/ITS/IMP/SAEM but missed several legitimate NONMEM 7 methods. Empirically probed against NM 7.6.0 and added: **ZERO** (`METHOD=ZERO`, the actual NONMEM default — FO with no conditional estimation; XML omits `cond_estim` / `centered_eta` / `laplace` entirely), **HYBRID** (`METHOD=HYBRID ZERO=(...)`; emits `etas_fixed_to_zero` from the user's ZERO list — added to `USER_DRIVEN_KEYS`), **IMPMAP** (Importance Sampling assisted by MAP estimation; same defaults as IMP except `estimation_method='impmap'`), **DIRECT** (Monte Carlo Direct Sampling; lighter than IMP — no IS-density tuning knobs). Matcher now routes by `estimation_method` value plus, for classical methods (no `estimation_method` attr), distinguishes ZERO / FOCE / HYBRID via `cond_estim` and `etas_fixed_to_zero` presence. Still deferred: BAYES (needs `$PRIOR`), NUTS (NM74+, BAYES variant), CHAIN (initial-value generator, doesn't fit the option-baseline model). 5 new tests bring defaults file to 13/13.

### Fixed

- **fix: collapse IMP-EONLY / FOCE-INTER sub-baselines so EONLY=1 / INTER flag as non-default (v0.0.167).** v0.0.165's matcher routed `METHOD=IMP EONLY=1` to a separate IMP-EONLY baseline (where `eonly='1'` is "default") so the user's deliberate `EONLY=1` choice didn't render blue. Same for FOCE vs FOCE-INTER: writing `INTERACTION` matched the FOCE-INTER baseline (`epseta_interaction='yes'`) instead of flagging the deviation. The user's mental model is "I wrote EONLY=1 — that's a change from default IMP, flag it." Single baseline per method family now: FOCE (canonical: no INTERACTION), IMP (canonical: eonly=0), SAEM, ITS. Any user toggle that flips one of those defaults now correctly flags blue. Removed the `IMP_EONLY` and `FOCE_INTER` constants. Suite stays balanced (lost 1 test, gained 2 new ones for the EONLY-blue / INTER-blue assertions): 10/10 in the defaults file.

### Added

- **feat: green tier for user-driven `$EST` options + reviewer fixes (v0.0.166).** Three-tier classification in the option dump: green = "user-driven" (NONMEM requires user to set: `niter` / `nburn` / `isample` for EM methods, OR per-run identity: `seed` / `clockseed` / `file` / `estimation_method`), blue = "non-default" (differs from method's empirical baseline), unstyled = matches default. Disjoint by construction (user-driven keys are excluded from the non-default check). Hover tooltip on each tinted cell explains the classification. New `findUserDrivenKeys` helper exports `USER_DRIVEN_KEYS` (renamed from internal `IGNORE_KEYS` for clarity) + intersection logic. Wire-format gains a parallel `xmlEstimationUserDriven: string[][]`. Also bundled: reviewer fixes — `findNonDefaultKeys` now returns sorted `string[]` instead of `Set` (drops Set→Array→Set ping-pong, ~1 line saved in renderer); NM-version-pin comment at top of `xml-est-defaults.ts`; documented coverage limit (conditionally-emitted attrs like `calpha` / `nuts_*` not in baselines, may show as false-positive blue when triggered). Cross-checked nmguides `iii-dd-ctl#sec-dd-estimation-record-options` — every NM-emit-by-default attr is in the table; conditional-emit attrs deferred. 8 tests (suite stays consistent).

- **feat: M14-C — non-default `$EST` options highlighted in blue (v0.0.165).** Each method's `<nm:estimation_options>` baseline empirically captured by running a minimal model with `$EST METHOD=X` (and the smallest extra options NONMEM accepts). Probes: `~/positron-nonmem/probe-defaults/{foce_inter,foce,its,imp,imp_eonly,saem}/run001.xml` against NM 7.6.0 (2026-05-09). Frozen as `runtime/xml-est-defaults.ts` (~250 lines static data + `findDefaultsForStep` matcher + `findNonDefaultKeys` differ). Method match: `estimation_method` attr (`its` / `saem` / `imp`) plus `eonly` to distinguish IMP-iterative from IMP-EONLY; classical FOCE / FOCE-INTER detected by `epseta_interaction` (no `estimation_method` attr). `IGNORE_KEYS` (`niter` / `nburn` / `isample` / `seed` / `clockseed` / `file` / `estimation_method`) are user-driven or run-specific — never flagged. BAYES not yet probed (would need `$PRIOR` plumbing) — falls through to no-highlight. Inspector renders non-default values in `var(--vscode-charts-blue)` with bold weight; default values stay foreground colour. The diff is computed extension-side (defaults table stays in TS); per-step `nonDefaultKeys: string[]` arrays ride through `InspectorDiagnostics.xmlEstimationNonDefaults` (Set materialised because Set doesn't survive postMessage). 6 new tests. Docs follow-up (`nmguides nonmem-tips.qmd`) deferred to next commit.

### Changed

- **style: $EST options table — uppercase keyword values too (v0.0.164).** Extended `fmtXmlOptionValue` to uppercase non-numeric values that look like NM-TRAN keywords. NONMEM emits them lowercase in XML (`saem`, `pop`, `s1pe12.5`, `tsol`, `noslow`); now displayed as `SAEM`, `POP`, `S1PE12.5`, `TSOL`, `NOSLOW` — matching the convention you'd write in actual NM-TRAN code (`METHOD=SAEM`, `FORMAT=S1PE12.5`). **Exception:** values that look like file extensions (`psn.ext`, `psn.lst`, dataset paths matching `/\.[a-z]{2,6}$/i`) keep their case so they remain grep-able on disk. Numeric values unchanged from v0.0.163.

- **style: $EST options table — uppercase keys, trim trailing-zero noise on values (v0.0.163).** NONMEM emits attr values verbatim from internal storage (`1000000.00000000` / `0.400000000000000` / `5.000000000000000E-02` / `1.000000000000000E-06`); table now renders them as `1000000` / `0.4` / `0.05` / `1E-06`. New `fmtXmlOptionValue` in `formatters.js`: parses to Number, picks fixed vs `E[+-]NN` scientific by magnitude, strips trailing zeros from both forms. Non-numeric strings (`BLANK`, `no`, `pop`, method names) pass through. Keys upper-cased via CSS `text-transform: uppercase` on `.xml-options-key` — display-only (copy-paste preserves the lowercase XML names) and matches the NM-TRAN keyword convention.

### Fixed

- **fix: systemic 7z subpath bug in `readArchivedFile` (v0.0.162).** Reviewing v0.0.161's narrow fix, the same root cause silently affects `readPrderr` / `readFmsg` — both pass bare names (`'PRDERR'`, `'FMSG'`) to `readArchivedFile`, which uses bare names in the `7z e -so` call. `7z e -so archive.7z PRDERR` returns 0 bytes when `PRDERR` is inside a subdirectory; needs the subpath form. `readArchivedFile`'s plain-file branch already prefixes `NM_run1/` (`<modelfitDir>/NM_run1/<member>`) — the inconsistency was only in the 7z branch. Fixed at the source: `readArchivedFile` now prepends `NM_run1/` to the member name passed to `7z`, so all three callers (xml / prderr / fmsg) work uniformly with bare names. Reverted v0.0.161's load-xml-text-side workaround. PRDERR / FMSG were silently broken for archived runs since their introduction; this fix restores them.

- **fix: 7z extract for psn.xml requires the full archive subpath (v0.0.161).** v0.0.158 added a tier-2 archive fallback for the .xml when PsN's `-clean` had archived `NM_run1/psn.xml` into `NM_run1.7z`. The fallback was passing `'psn.xml'` as the member name to `readArchivedFile` — but `7z e -so archive.7z psn.xml` returns 0 bytes when the member is in a subdirectory; the subpath form `NM_run1/psn.xml` works. Verified empirically on a test-signals archive: bare → empty, subpath → 80KB of XML. Test-signals/run001 now lights up the "$EST options" expandable section + per-step termination/timing line. Granular logging added to differentiate "no .ext found" / "no runner" / "extract failed" cases (previous catchall hid which condition failed).

- **fix: drop duplicate termination-code mapping; refactor buildDiagnostics to options-object (v0.0.160).** Independent code review of v0.0.159 caught a critical bug: the new `terminationLabel(code)` switch in client.js had **different semantics** from the existing `terminationCodeLabel` in formatters.js (e.g. code 2 = "failed precision" in one, "max evals" in the other) — same numeric source, contradictory user-facing labels, would have shown different text in adjacent panels. Empirically verified the existing `terminationCodeLabel` is consistent with NM 7.6.0 — code 2 shows up for both `EXPECTATION ONLY PROCESS WAS NOT TESTED FOR CONVERGENCE` and SAEM `STOCHASTIC PORTION WAS NOT TESTED` cases. Deleted the new switch, reuse the existing function from formatters.js (loaded into the webview before client.js, so in scope). Also: `buildDiagnostics` was at 9 positional args after v0.0.159; refactored to a single `BuildDiagnosticsArgs` options-object — single call site, mechanical change, prevents further positional bloat as v0.0.160+ adds more XML-derived fields. Suite stays 356/356.

### Added

- **feat: M14-B — XML pivot phase 2: per-step termination + timing (v0.0.159).** Each chained `$EST` step in the convergence-trajectory section now shows an XML-derived results line under its heading: `termination: success · burn-in 15.4s · elapsed 24.8s` (or `termination: failed precision` red, etc.). New pure module `runtime/parse-xml-results.ts` parses `<nm:estimation>` blocks for `termination_status` (numeric NM7 code), `estimation_burnin_time`, `estimation_elapsed_time`. Same regex approach as `parse-xml-options.ts` — these are flat text-content-of-named-element fields, no nested-structure parsing needed. New `EstimationStepResult[]` field flows through `VariablesContext` → `BuildContext` → `InspectorDiagnostics.xmlEstimationResults`. Index-aligned with `payload.trajectories` so each trajectory step's heading gets enriched. Termination code 0 renders green (success), non-zero red. Burn-in field is null for non-EM steps (FOCE / IMP-EONLY) and the line gracefully omits it. **Practical wins**: per-step timing was previously last-step-only via `.lst`'s `#CPUT:`; numeric termination code complements the existing text-form parser. 3 new tests bring suite to 356/356.

### Fixed

- **fix: locate the .xml even for PsN-archived runs (v0.0.158).** v0.0.156's `readXmlText` only looked for plain `<basename>.xml` next to the .lst — but PsN's default `-clean` packs `NM_run1/psn.xml` into `NM_run1.7z` and **`xml` was not in `run-model.ts`'s default `-nm_output` list**, so PsN never copied it out. Result: the inspector's "$EST options" section never appeared for any PsN-driven run (most of the empirical workflow). Two fixes: (1) `'xml'` added to `DEFAULT_NM_OUTPUT_EXTENSIONS` so future runs copy `psn.xml` to `modelfit_dir<N>/run001.xml` directly. (2) `readXmlText` extended with a tier-2 fallback that extracts `psn.xml` from `NM_run1.7z` via the existing `readArchivedFile` helper (same pattern `readPrderr` / `readFmsg` use). Pre-existing PsN runs now light up the inspector section without re-running. Test for the default `-nm_output` flag updated for the new extension.

### Changed

- **refactor: tighten parseEstimationOptions outer regex (v0.0.157).** Code review of v0.0.156 surfaced one regex robustness concern: `[\s\S]*?` would match across an attribute value if it ever contained `/>`, capturing a truncated body. Tightened to `[^>]*?` — fails cleanly when the body contains an unexpected `>` rather than producing partial garbage. NM 7.6.0 doesn't emit such values empirically; the change is defensive. Added a regression test confirming the new behaviour. Most other reviewer concerns were YAGNI-deferred (XML parser dep until Phase 2 forces nested-element parsing; FOCE-INTER label heuristic; importance-ordered attrs; integration test for the wiring).

### Added

- **feat: M14-A — XML pivot phase 1: exhaustive `$EST` options surface (v0.0.156).** New collapsible "$EST options (XML, exhaustive — N steps)" section in the inspector diagnostics block. One nested `<details>` per chained `$EST` step (`Step 1: SAEM (63 attributes)`, `Step 2: IMP (45 attributes)`, etc.) with a 2-column key→value table sorted alphabetically. Source: NONMEM 7.2+'s `<basename>.xml` `<nm:estimation_options nm:knob='value' ... />` element — the **canonical surface for $EST configuration**, more complete than the `.lst` echo (the .lst formatted block is a human-readable subset; XML carries kernel-sampling internals like `isample_m1a` / `ikappa` / `massreset` that the .lst doesn't show). Empirically verified: NM 7.6.0 writes the .xml automatically unless `nmfe76 -xmloff` was used; PsN's `execute` doesn't pass `-xmloff` so .xml is present for PsN-driven runs too. Pure modules: `runtime/parse-xml-options.ts` (regex extractor — self-closing element with simple attr pairs, no XML parser dep needed) and `runtime/load-xml-text.ts` (find sibling .xml + read mirror of `load-ext-text`). New `VariablesContext.xmlEstimationOptions` / `BuildContext.xmlEstimationOptions` / `InspectorDiagnostics.xmlEstimationOptions`. Default closed (verbose; opens on demand to look up specific knobs). 3 new tests bring suite to 352/352. **Phase 2 (XML primary, .lst fallback for the parsers themselves)** comes in subsequent milestones — incremental swap, parser-by-parser.

### Changed

- **style: capitalize the IMP-EONLY badge to `IMP EONLY` (v0.0.155).** `shortMethodLabel` now returns `IMP EONLY` instead of `IMP eonly` for `Objective Function Evaluation by Importance Sampling`. The all-caps form matches the NM-TRAN keyword convention (`$ESTIMATION METHOD=IMP EONLY=1`) and reads consistently with the other badges (`SAEM`, `FOCE-INTER`, `BAYES`).

### Fixed

- **fix: Fit Inspector tables overlap when the pane is narrow (v0.0.154).** With percentage column widths and `table-layout: fixed`, the THETA / OMEGA / SIGMA tables compressed below readable widths once the inspector pane fell under ~460px, causing visible overlap (`1e+06` colliding with `LB`/`UB`, RSE% running into NSD, etc.). Floored `table.param-table { min-width: 460px; }` and added `body { overflow-x: auto; }` so a narrow pane scrolls horizontally instead of compressing the cells. Above the floor, the percentage widths still distribute extra space proportionally — no behaviour change for normal-width panes.

### Changed

- **refactor: M13-D signal-send polish — collapse duplicate validation + tighten toast (v0.0.154).** Independent code review surfaced two cheap fixes: (1) DRY — `signalStopRunCommand` had its own `arg.modelPath` typeof check before reading the .mod for `$EST` counting; the same check then ran in `sendSignalCommand`. Moved the `stop.sig`-only chain-length detection inside `sendSignalCommand`, keyed off `signal === 'stop.sig'`. `signalStopRunCommand` is now a one-liner. (2) YAGNI — toast text trimmed from `next PRINT cycle (latency = $EST PRINT value, in iterations)` to `next PRINT cycle.` The full latency table lives in `docs/empirical-notes.md` (and now in nmguides upstream); the toast just needs to convey "not instant, but soon".

- **fix: signal-send toast no longer hardcodes "~10 iterations" (v0.0.153).** Empirical PRINT-vs-latency probes (`probe-signals/p1` / `s1` / `p50` against NM 7.6.0): latency between `touch <sig>` and NONMEM's `Ending Mode` is **exactly 1 `$EST PRINT` cycle in iterations** — 1 iter at PRINT=1, 10 at PRINT=10, 50 at PRINT=50. The previous toast `~10 iterations` was right only for PRINT=10. New text: `next PRINT cycle (latency = $EST PRINT value, in iterations)`. Empirical-notes.md updated with the table — nmguides documents *what* signals exist but is silent on the polling cadence.

- **fix: trim stop.sig confirmation modal (v0.0.152).** The 4-sentence warning was wall-of-text. Shortened to one line: `Stops at the current $EST. Remaining steps in the chain (N) will be skipped — use "End current EM mode" to advance through them instead.` Same essential info (count of skipped steps + alternative action), one-third the words. Empirical verification of v0.0.145's `stop.sig` path passed in test-signals/run001 — modal appeared, signal landed in NM_run1/, IMP-EONLY interrupted cleanly, $COV still ran.

- **refactor: trajectory UX review fixes (v0.0.151).** Independent code review of v0.0.146-150 surfaced three small fixes, all applied: (1) Dropped the `requestAnimationFrame` wrapper around `tuneGridColumns`. `offsetWidth` reads inside the function already force a synchronous layout flush, so rAF wasn't buying anything — and it caused a visible single-frame flicker where un-tuned cells paint at the CSS-default 110px before snapping to the measured width. Now synchronous immediately after `plotsContainer.append(grid)`. (2) rAF-coalesced the slider `input` handler — `input` fires per drag pixel, and each fire does a full grid rebuild + measure pass. Coalescing via a `pendingFrame` flag so at most one render runs per animation frame keeps fast drags smooth without dropping responsiveness. (3) Added `overflow: hidden; text-overflow: ellipsis;` belt-and-braces to `.convergence-range` — `tuneGridColumns` already locks columns to the widest measured range, but sub-pixel font-hinting differences can still shave a pixel cross-platform; ellipsis prevents ugly overflow rather than catastrophic spill. ~10 LOC total.

### Fixed

- **fix: trajectory grid measurement was constrained by the CSS column track (v0.0.150).** v0.0.149 set `cell.style.width = 'max-content'` to measure intrinsic content width — but grid items can't escape a fixed-px track via cell-side width alone. The CSS default `repeat(auto-fill, 110px)` clamped every cell at 110px during measurement, so `offsetWidth` reported 110 and the lock-step then "matched" 110 across the board. `tuneGridColumns` now (1) switches `grid-template-columns` to `repeat(auto-fill, max-content)` BEFORE measuring (track grows with cell), (2) sets `white-space: nowrap` on the range text during measurement so wrap-induced narrow widths don't fool the read, then (3) locks both grid columns AND every cell back to the measured max width. Long final/Δ strings (`-40992.071 (Δ -1060.189)`) now sit on one line in cells wide enough to hold them.

### Changed

- **feat: trajectory grid columns auto-size to widest cell content (v0.0.149).** v0.0.148 locked columns at a fixed 110px so cells aligned, but long range strings (`-40992.071 (Δ -1060.189)`) wrapped inside cells and looked cramped. Now `tuneGridColumns(grid)` runs after each slider movement: temporarily sets cells to `width: max-content`, reads `offsetWidth`, and locks every cell + the grid's `grid-template-columns` to the widest cell's width (lower-bounded at 110px so tiny ranges still get a usable sparkline). The SVG is `width: 100%` so the sparkline stretches with the cell instead of leaving an indent. Result: columns are as wide as needed for the trace-suffix data + still pixel-aligned across rows. Re-runs on every slider movement because the start-iter changes which final value appears in the suffix (hence its width).

### Fixed

- **fix: trajectory grid alignment (v0.0.148).** The per-parameter sparklines weren't aligning across rows: cells expanded to fit their `range` string (final value + Δ), so a row with one wide value (e.g. `-40992.071 (Δ -1060.189)`) widened all its cells and shifted the next row's wrap point. Switched `.convergence-grid` from flex-wrap to CSS Grid with fixed 110px `auto-fill` columns. Cells now have `width: 110px` (was `min-width: 110px`) with `overflow-wrap: anywhere` so long range strings wrap inside the cell instead of stretching it. Result: clean 6-column grid (or however many fit) with every cell pixel-aligned across rows.

### Changed

- **fix: trajectory defaults to accumulation phase for SAEM / BAYES (v0.0.147).** When a `$EST` block has both burn-in (negative iters) and accumulation (>= 0), the start-iter slider now initialises at the first accumulation iter rather than 0. Pharmacometric rationale: convergence is assessed in the stationary phase; burn-in iterations show *exploration*, not convergence. Showing burn-in by default flattened the accumulation trace because the OFV drops several orders of magnitude in the first 1-2 iterations. The slider is still draggable left to pull burn-in back into view; a `title` on the slider label explains the default. All-burn-in runs (interrupted via `next.sig` before iter 0) and all-accumulation runs (FOCE / IMP EONLY) default to start=0 so the full trace is visible.

### Added

- **feat: per-block start-iter slider on the convergence trajectory (v0.0.146).** Each `$EST` block in the convergence section now has a `start at iter <N>` slider above its plots. Drag right to crop the leading iterations — the OFV usually drops several orders of magnitude in the first 1-2 iterations of SAEM/IMP burn-in (10^5 → 10^-something), which flattens the rest of the trace beyond visibility. With the slider you can skip those early dramatics and inspect the actual convergence behaviour near the asymptote. Native `<input type="range">` styled with VS Code's theme accent. Per-block (each step has its own iter range — SAEM might be -2000..200, IMP-EONLY 0..5). Updates plots live on `input` (drag-to-redraw); displays the actual iteration number next to the slider, not the index.

- **feat: M13-D signal-send UX for running estimations (v0.0.145).** Right-click any **running** entry in the Active Runs view to send NONMEM signal files mid-estimation: **End current EM mode (next.sig)** and **Stop run cleanly (stop.sig)**. Signal lands at `<modelfit_dir>/NM_run1/<name>` (nmfe76's actual cwd under PsN execute — empirically verified, see `docs/empirical-notes.md`). NONMEM consumes the file at the next PRINT cycle (~10 iterations) and reacts: `next.sig` advances to the next mode (burn-in → accumulation, or one $EST → the next), `stop.sig` skips ALL remaining $EST records and goes straight to $COV (or end-of-run). Multi-`$EST` warning: when sending `stop.sig` to a model with > 1 `$ESTIMATION` record (e.g. the SAEM → IMP-EONLY refinement chain), a modal warns explicitly that subsequent steps including the IMP-EONLY OFV refinement will be skipped — user can confirm or cancel. New pure modules: `runtime/signal-dispatch.ts` (`sendSignal({modelfitDir, name})` writes empty file, returns `{ok, path, error}` — no-throw shape so the UX can toast/log uniformly) and `runtime/count-estimation-records.ts` (`countEstimationRecords(modText)` regex counter, comment-aware). Two new commands hidden from the command palette (right-click only, since they require a tree-view item arg). 7 new tests bring the suite to 349/349. **Local-only for now** — when SSH-driven runs land (M3+ in the design plan), `signal-dispatch.ts` will gain a Runner-aware variant that SFTP-puts the file on the remote.

### Changed

- **refactor: trajectory review fixes (v0.0.144).** Code review of v0.0.142+143 surfaced four small fixes, all applied: (1) `client.js renderSparklineCell` — the Δ-from-first hint (`0.987 (Δ -0.013)`) now requires both endpoints to be `Number.isFinite`. Previously a NaN value rendered as `NaN (Δ NaN)`. (2) `client.js renderSparkline` — single-finite-point trajectories now render as a small circle marker (`<circle r="1.5">`); SVG `M x,y` alone renders nothing per spec, leaving an empty box for runs with PRINT > NITER. (3) `client.js renderSparkline` — burn-in→accumulation marker boundary widened from `xMax > 0` to `xMax >= 0` so a SAEM run interrupted exactly at iter 0 (`next.sig` at clean burn-in completion) still shows the transition line. (4) DRY: extracted `runtime/load-ext-text.ts` (`readExtText` helper). Inspector path now reads the `.ext` text once and parses it twice (`parseExtFit` + `parseExtTrajectory`) instead of two find+read+parse roundtrips. Matters for slow remote-mounted FS. `loadExtFitForLst` and `loadExtTrajectoryForLst` retained as thin wrappers for callers that don't share text (lineage discoverer). YAGNI: dropped unused `lastExtTrajectory` helper (parity-with-siblings was the only justification, no production callsite). Suite stays 342/342.

- **fix: suppress per-parameter sparklines for IMP-EONLY trajectory blocks (v0.0.143).** EONLY=1 freezes the parameters by definition — the step refines only the OFV via importance sampling. Showing flat per-parameter lines was just visual noise. The trajectory section for an `Objective Function Evaluation by Importance Sampling` block now renders only the OFV plot plus a one-liner note `Parameters frozen — EONLY=1 refines the OFV only.` Detection by NONMEM's verbatim method label so we don't conflate with iterative IMP (which DOES update parameters).

### Added

- **feat: convergence-trajectory section in the Fit Inspector (v0.0.142).** New collapsible block at the bottom of the inspector showing per-iteration trajectories for every parameter + the OFV, one section per chained `$EST` step. SAEM/IMP burn-in iterations (negative) and accumulation iterations (positive) both render; a yellow dashed marker at `iter=0` highlights the burn-in→accumulation transition. The OFV plot is full-width (480×80) and emphasised; per-parameter sparklines are 110×32 in a wrapped flex grid. Each cell shows the final value plus signed Δ-from-first as a numeric hint. NaN values break the line (gap, no spurious zero-crossing). Constant traces render as a dashed flat midline so the user can see "this didn't move" instead of an empty box. Defaults: open for single-`$EST` runs (the common FOCE case), closed for chained runs (so the inspector stays scannable). New pure modules: `runtime/parse-ext-trajectory.ts` (multi-table aware, drops the `-1000000xxx` marker rows that `parseExtFit` consumes for finals/SEs/etc., normalises `THETA1` → `THETA(1)`) and `runtime/load-ext-trajectory.ts` (find+read+parse mirror of `load-ext-fit`). New wire-format `TrajectoryWire` (Record-keyed instead of Map-keyed — Maps don't survive `postMessage`'s structured clone). New `VariablesContext.trajectories`, `BuildContext.trajectories`, `InspectorPayload.trajectories`. Three new tests bring suite to 342/342.

### Fixed

- **fix: OMEGA / SIGMA BLOCK off-diagonal initial values now sourced from the .lst (v0.0.141).** Off-diagonal rows (e.g. `OMEGA(2,1)`, `OMEGA(3,2)` in a `$OMEGA BLOCK(N)`) were rendering with `init = .ext` iteration-0 — but for SAEM/IMP runs that row holds NONMEM's *perturbed* starting matrix (NM pads the diagonal for numerical stability before SAEM begins), not what the user typed. New `runtime/parse-initial-matrix.ts` parses the `0INITIAL ESTIMATE OF OMEGA:` / `0INITIAL ESTIMATE OF SIGMA:` echo from the .lst (NONMEM-authoritative — it's the verbatim parse of the user's `$OMEGA` / `$SIGMA`). Lower-triangular row-counting handles both BLOCK form and the implicit-zero-off-diagonal form NONMEM emits for diagonal `$OMEGA` (so callers can distinguish "explicitly zero" from "not declared"). New `LstSummary.initialOmega` / `initialSigma` Map fields. `pickInit` and `offDiagonalRows` in `fit-inspector-payload` now prefer this NONMEM-authoritative source over the `.ext` fallback for both diagonals (when vscode-nmtran returns null/NaN — `$THETA (a, , b)` empty-init form) and off-diagonals (which vscode-nmtran's API doesn't expose at all). The `impliedInit` muted-render flag now fires for the `.ext` fallback branch only, since the lst echo IS the user's value. Three new tests bring suite to 339/339. User-visible fix: in a `$OMEGA BLOCK(4)` model with off-diagonal init 0.05, the inspector now shows `0.05` in the `init` column for `OMEGA(2,1)`, `OMEGA(3,2)` etc., not `—`.

### Added

- **feat: chained-`$EST` multi-method badges + IMP-EONLY detection (v0.0.140).** Inspector now renders one method badge per `$EST` record in chain order — e.g. a SAEM→IMP-EONLY model shows `[SAEM] [IMP eonly]` side by side instead of just `[IMP]` (the previous last-`#METH:`-wins display dropped earlier steps). New `LstSummary.methods: string[]` and `LstSummary.methodsShort: string[]` fields collect all `#METH:` markers in order; existing `method` / `methodShort` scalars retained as last-wins for back-compat (used by the EVAL-ONLY pill detection, which only cares about the final step). `shortMethodLabel` now distinguishes `Objective Function Evaluation by Importance Sampling` (NONMEM's wording for IMP `EONLY=1`) → `IMP eonly`, separate from plain iterative `Importance Sampling` → `IMP`. Realises the SAEM→IMP-EONLY-OFV-refinement convention visually (see project memory). Common chains the inspector now renders correctly: `[ITS] [FOCE-INTER]`, `[SAEM] [IMP eonly]`, `[FOCE-INTER] [FOCE-INTER]` (re-run with updated inits). Client.js falls back to the scalar `methodShort` when a fixture / older payload omits the array.

### Changed

- **refactor: M13-A post-review polish (v0.0.139).** Code review of v0.0.138 surfaced four small fixes, all applied: (1) `parse-cnv.ts` — guard against a stray `ITERATION` line stomping `paramNames` against already-collected marker rows (header is only set once per `TABLE NO.` block now). (2) `parse-cnv.ts` — `finalize` tightened to require **all four** marker rows (means + SDs + p-values + alphas) match `paramNames.length`, plus a minimum 2 columns (one parameter + the OFV column). Degraded / truncated tables drop out of `parseCnv`'s output entirely so `classifyCnv` only sees fully-populated data. (3) `cnv-verdict.ts` — OFV column is now detected by `/OBJ$/i` name pattern (matches NM7's `SAEMOBJ` / `IMPOBJ` / `BAYESOBJ` / `OBJ`) rather than positionally. Falls back to "last column" when no `…OBJ` header is found. (4) DRY win: `extractMethod` and `pickOfvColumn` are now shared via `runtime/parse-table-header.ts` instead of duplicated three ways across `parse-cor` / `parse-cnv` / `parse-phi` (rule-of-three threshold hit). One new test verifies OFV-by-name detection works regardless of column position. Suite 336/336.

### Added

- **feat: M13-A `.cnv` convergence verdict for EM/MCMC runs (v0.0.138).** Fit Inspector meta-line now shows a green `EM converged` / red `EM NOT converged` pill for SAEM / IMP / ITS / BAYES runs that had `$EST CTYPE > 0`, sourced from the sibling `.cnv` (NM 7.2+). Pill text: `· EM converged (OFV p=0.34 ≥ α=0.05, 8/9 params converged)`. Hover tooltip lists offending parameters when any drift; describes the linear-regression slope-vs-zero test (Bonferroni-corrected per parameter; OFV α uncorrected). Hidden for FOCE / no-CTYPE runs (no `.cnv` written) — the pill only renders when the verdict is actionable. New pure modules: `runtime/parse-cnv.ts` (parses the four marker rows `-2000000000…-2000000003` = means / SDs / p-values / alphas; multi-table last-`$EST`-step rule) and `views/cnv-verdict.ts` (classifier — converged ⇔ OFV p≥α AND every tested param p≥α). PsN `.cnv.7z` archive fallback shared with `.cor` via new `readArtifactText` helper in `variables-context.ts`. New `VariablesContext.cnv`, `BuildContext.cnv`, `InspectorSummary.cnvVerdict`, `.meta-good` CSS class. Empirical structure of the `.cnv` marker rows verified live against NONMEM 7.6.0 — see `docs/empirical-notes.md` "Signal-file mechanism" section. Seven new tests bring the suite to 335/335.

### Fixed

- **fix: correlation table `r` column polish — right-aligned header + hover tooltip (v0.0.137).** Header cell was left-aligned while values were right-aligned, leaving the `r` label visually disconnected from its column. Added `diag-corr-r-header` class (`text-align: right !important;`) so header tracks values. Header now also carries a `title` attribute explaining "Pearson correlation coefficient between the two parameter estimates from NONMEM's .cor (correlation matrix of estimate); sign preserved" for users encountering the `.cor` surface for the first time.

### Added

- **feat: two-tier colouring for the correlation red-flag list (v0.0.136).** Pair list now shows everything `|r| ≥ 0.90` (the lower **warn** threshold) rather than just `|r| ≥ 0.95`. Cells in `[0.90, 0.95)` render yellow (`diag-corr-r-warn`), cells `≥ 0.95` render red (`diag-corr-r-bad`) — same colour vocabulary as the inspector's RSE / shrinkage / sig-digits cells. New workspace setting `nonmem.corrWarnThreshold` (default 0.90); existing `nonmem.corrRedFlagThreshold` (default 0.95) still controls the red tier. Set warn ≥ red to collapse to single-tier (everything red). Classifier moved into `findCorrelationRedFlags(table, warn, red)` so the client doesn't reapply threshold logic — the helper now returns `{a, b, r, kind: 'warn' \| 'bad'}`.

### Fixed

- **fix: M12-B `.cor.7z` per-file archive extraction (v0.0.135).** v0.0.134 only resolved plain-file `<basename>.cor`; PsN's default behaviour for COV-step matrices is to compress them individually as `<basename>.cor.7z` (and `.cov.7z`, `.coi.7z`) inside `modelfit_dir<N>/`, distinct from the `NM_run1.7z` directory archive that holds PRDERR / FMSG. Empirically observed on `~/positron-nonmem/probe-psn/slow/run001` — a 4-OMEGA fit with strong off-diagonal correlations (e.g. OMEGA(3,2) ↔ OMEGA(2,2) = -0.968) but the inspector's red-flag list was empty because we silently failed to find the .cor. Fix: `loadCor` now falls back to extracting `.cor.7z` via `7z e -so -y <archive> <member>` through the injected runner when no plain `.cor` exists. Single-member archive — file inside is `<basename>.cor`. NONMEM 7.2+ stores parameter SEs on the matrix diagonal (not 1.0); we preserve verbatim because the red-flag scan is upper-triangle off-diagonal so the diagonal value doesn't matter to the filter.

### Added

- **feat: M12-B `.cor` correlation red-flag list in the inspector (v0.0.134).** Fit Inspector now loads the sibling `.cor` (NONMEM correlation matrix of estimates), scans for parameter pairs with `|r| ≥ 0.95`, and renders them as a small table in the diagnostics block (heading `Highly-correlated parameter pairs (N)`; columns `parameter A · parameter B · r`; sorted `|r|` desc; upper-triangle only). Hidden when no pair meets the threshold so a clean run stays uncluttered. New pure modules: `runtime/parse-cor.ts` (multi-table aware, last-`$EST`-step rule shared with `.ext` / `.phi`; reads parameter ordering from the `NAME` row rather than assuming TSO) and `views/correlation-redflags.ts` (`findCorrelationRedFlags(table, threshold)` helper). New workspace setting `nonmem.corrRedFlagThreshold` (default 0.95). New `VariablesContext.cor`, `BuildContext.cor`, `InspectorThresholds.corrRedFlagThreshold`, `InspectorDiagnostics.correlationRedFlags`. Surface intentionally fact-only — no editorialising, no overparameterization framing in copy. The user combines this with `cond` (already threshold-coloured in meta-line) and per-row RSE% (already threshold-coloured in tables) to read collinearity / overparameterization themselves. Six new tests bring suite to 328/328.

### Added

- **feat: M12-A inspector convergence-quality polish — threshold-coloured cond/sig-digits + NONMEM-direct cond-number fallback (v0.0.133).** Two visual + data quality fixes for the Fit Inspector summary meta-line. (1) **Threshold-coloured cond / sig-digits.** The meta-line was a flat comma-list (`cond 1247 · sig-digits 2`) — the user had to do the threshold check in their head. Now: cond > 1000 → red (strong overparameterization signal), cond 100-1000 → yellow (ill-conditioning suspect); sig-digits below the user's `$EST NSIG=` request → red (didn't reach precision bar). Native title attributes carry the rationale on hover. CPU time and acceptance rate stay plain — no community-standard threshold to apply. The meta-line was refactored from a string-concat to a DOM-fragment builder so individual parts can be colour-coded; CSS adds `.meta-warn` / `.meta-bad` classes mirroring the inspector tables' yellow/red vocabulary. (2) **NONMEM-direct condition number from `.ext` `-1000000002` eigenvalues** (via `parseLst`'s already-parsed `eigenvalues` array). Previously cond was only shown when sumo had been run successfully — when sumo failed, the diagnostic was silently absent even though we already have the input data. New `LstSummary.conditionNumber: number \| null` — max/min eigenvalue ratio for the all-positive case, null when any eigenvalue ≤ 0 (non-PD COR matrix; the negative eigenvalue itself is the diagnostic in that case, surfaced via the eigenvalues min/max display). Inspector prefers `sumo.conditionNumber` (PsN's battle-tested derivation) and falls back to `lst.conditionNumber` when sumo missing. Three new tests bring suite to 322/322.

- **feat: M11-Δi-D lineage diagnostics — stale-override GC + unresolved-parent surfacing (v0.0.132).** Two data-quality fixes for the Run Lineage view, both surfaced via a new diagnostics banner above the legend (hidden when there's nothing to report). (1) **Stale `lineageOverrides` GC.** The workspace setting accumulates dead pointers when the user renames / removes override target or source files (we silently dropped them at apply time, but the entries persisted in `.vscode/settings.json` forever). New pure `findStaleOverrides(overrides, knownPaths)` flags entries by reason: `child-missing` (child path no longer in workspace) or `parent-missing` (parent path not null but absent — override silently no-ops). Force-root overrides (`parent === null`) with present child are NOT stale. The banner shows count + a "Clean N stale" button → modal confirm with up to 5 sample basenames + reason → write back the pruned record. Falling through to runrecord `;; Based on:` is the conservative reset (the user can re-set if needed). (2) **Unresolved parent links count.** New `LineageGraph.unresolvedParentCount` tracks nodes that claim a parent (`basedOn N` or `basedOnPath`) which doesn't resolve to any node in the input set — typically Pirana / hand-rolled runs referencing a numbered parent that hasn't been imported. Cycle nodes are excluded (different cause, separate diagnostic). Informational only — no one-click fix because we don't know the user's intent. Seven new tests bring the suite to 319/319.

### Fixed

- **fix: M11-Δi-C lineage robustness — cycle prevention, edge survival, override badge (v0.0.131).** Three Run Lineage fixes from the post-v0.0.130 review pass: (1) **Drag-to-parent / Set parent… / Create relation… now refuse cycle-creating overrides** instead of silently fragmenting the tree. New `wouldOverrideCreateCycle(edges, child, parent)` predicate in `lineage-graph.ts` walks UP from the proposed parent via current edges; cycle iff it reaches the proposed child (i.e. child is already an ancestor of parent). `LineagePanel.writeOverride` checks against `lastGraph.edges` before persisting and shows a warning toast on rejection. Without this, `buildLineageGraph`'s `isOnCycle` would catch the loop and drop both endpoints to roots — leaving the user with a fragmented tree and no explanation of what happened. (2) **Selected edge survives panel refresh.** Previously the side panel closed on every graph re-render (promote estimates, set-parent, even just Refresh) — fatal for the iterative-review loop the panel exists for. Webview client now re-resolves the selected edge in the new graph: if both endpoints + the edge between them still exist, it stays open and re-fetches the ΔiOFV (the underlying `.phi` may have changed); only when the edge is genuinely gone does the panel close. (3) **Override edges render dashed.** New `viaOverride: boolean` field on `LineageEdge` distinguishes file-canonical (`;; Based on:` runrecord) from workspace-state (`lineageOverrides` setting) edges. Renders with `stroke-dasharray: 5 4`; same colour signal so the user reads ΔOFV class first, provenance second. New legend entry `─ ─ workspace override`. Five new tests bring the suite to 312/312.

### Refactor

- **refactor: DRY/YAGNI cleanup pass (v0.0.130).** code-reviewer subagent flagged 15 items; acted on the high+medium ones with clear value: (1) Deleted dead `loadPhiForLst` (no production caller — `lineage-discovery.ts` only needs the path, which `findArtifactFile` returns directly). Drops `src/runtime/load-phi-fit.ts` entirely; `lineage-discovery.ts` calls `findArtifactFile(lstPath, '.phi')` inline. (3) Dropped never-used `topK` parameter from `computeEdgeIOfvSummary` / `loadEdgeIOfvSummary`; hardcoded module-level `TOP_K = 10`. Production caller in panel never set it; only tests touched it (and didn't need to). (4) Single-pass classify in `computeEdgeIOfvSummary` — was 3 passes (count loop + filter+sort improved + filter+sort worsened); now bucket-fills `improved[]`/`worsened[]` while counting, then sorts each. Hot path on panel click; clinical datasets can hit 1000+ subjects. (5,6) Dropped write-only edge data attrs (`data-parent-model-path` / `data-child-model-path` / `data-*-basename` / `data-delta-ofv`) on path elements in webview client; click handler uses closure-captured nodes. (8) Deleted speculative "kept for future shrinkage diagnostics" comment promise on PHC columns. (9) Made `LineageNodeInput.phiPath` non-optional (`phiPath: string | null`) — was a mix of `?:` and `: T | null` after the M11-Δi-A refactor; the `??  null` coercion in `buildLineageGraph` is now redundant. (13) Hoisted `NOOP_LOGGER` from 3 sibling modules to `src/log-utils.ts`. Skipped: 7 (extractMethod simplification — production logic is correct), 10/11/12/14/15 (speculative refactors / stale-data risk / under-justified). 307/307 tests still pass.

### Added

- **feat: M11-Δi soft warning when parent and child use different estimation methods (v0.0.129).** Extends the comparability gate from v0.0.128 with a SOFT warning tier: when normalized method labels differ between parent and child (e.g. FOCEI → IMP, FOCE → SAEM, FOCEI → Bayesian), the per-subject summary is still computed but a yellow warning row sits above the tables. Rationale: the methods' additive constants in the OFV decomposition (½log det Ω, ½log det Vᵢ from basic-theory Eq.12–13) take different forms — Laplace expansion vs first-order linearisation vs Monte-Carlo IS estimate vs SAEM stochastic step. The per-subject Δ remains a useful relative-influence signal but Σ ΔiOFV won't equal total ΔOFV; the gap is the constant difference (informative, but absolute Δ values shouldn't be over-interpreted). The `(Evaluation)` MAXEVAL=0 suffix is normalised away — same likelihood function, different parameter values, no warning. New return field `IOfvLoadResult.warning: string | null`. Two new tests: warning fires on FOCEI→IMP; warning suppressed when only `(Evaluation)` differs.

### Fixed

- **fix: M11-Δi side panel — refuse to compare iOFV across `$DESIGN` / D-OPTIMALITY runs (v0.0.128).** Empirical: a `run001 (FOCEI) → run008 ($DESIGN)` edge displayed `Total ΔOFV (.ext) = −39.61` alongside `Σ ΔiOFV = +25` and `0 improved · 5 worsened` — visually impossible because the two sums measure different things. Root cause: `$DESIGN` runs (typified by `D-OPTIMALITY` in the `.phi` table label) emit per-subject Fisher Information Matrix contributions in the OBJ column, NOT per-subject likelihoods. The total `.ext` "OFV" for a $DESIGN run is the global D-optimality criterion (e.g. det-derived), also not a fit OFV. Comparing either of those numbers to a fit run is a category error. Fix: new `checkComparability(parent, child)` gate runs after both `.phi` files are parsed; on D-OPTIMALITY hit (either side), `loadEdgeIOfvSummary` returns `{summary: null, incomparableReason}`. The panel renders a yellow warning row with the specific reason plus a caveat that the `.ext` ΔOFV above the warning is also not interpretable. New return type `IOfvLoadResult = { summary, incomparableReason }`. New regression test covers both sides; existing fs-shell tests rewritten to the richer return shape.

### Added

- **feat: M11-Δi-B — clickable edges in Run Lineage view; per-subject ΔiOFV side panel (v0.0.127).** Edges in the lineage tree are now clickable: click an edge → lazy-loads both `.phi` files, computes per-subject ΔiOFV via the M11-Δi-A `computeEdgeIOfvSummary`, and renders a side panel on the right of the canvas with: total ΔOFV from `.ext` (sanity-check vs the parent/child link), Σ ΔiOFV across subjects (should approximate the .ext ΔOFV when the method's additive constant cancels — gap is itself informative), three count badges (improved / worsened / indifferent at the same χ²₁,0.05 = 3.84 threshold as the edge colouring), and two ranked tables of top-K most-improved / most-worsened subjects with parent iOFV, child iOFV, and Δ. Renders `null` summary as a hint ("disjoint subject IDs / .phi missing"). New panel-side message handler `requestEdgeIOfv` resolves both endpoints' `phiPath` from the cached graph and posts back via `edgeIOfv`. New `loadEdgeIOfvSummary` fs shell (read + parse + compute). Two new tests bring the suite to 304/304. Edge cursor / hover-stroke styling makes the click affordance discoverable.

- **feat: M11-Δi-A — `computeEdgeIOfvSummary` data layer for lineage-edge ΔiOFV (v0.0.126).** Foundation for the Run Lineage view's per-subject ΔiOFV drill-down. New pure function takes parent + child `PhiTable` and returns aggregate counts (`nImproved` / `nWorsened` / `nIndifferent`, classified by χ²₁,0.05 = 3.84 cutoff per Keizer 2013, same threshold as the existing total-ΔOFV edge colouring) plus top-K most-improved / most-worsened subjects sorted by |Δ|. Inner-joins on subject ID with leading-zero / numeric-vs-string normalisation; returns null on either-side-missing or disjoint subject sets. Wired into discovery: every `LineageNodeInput` now carries `phiPath` (Pirana-flat or PsN modelfit_dir cascade — same logic as `findExtFile`, refactored to a shared `findArtifactFile` helper). New `loadPhiForLst` runtime helper mirrors `loadExtFitForLst`. UI surfacing deferred to M11-Δi-B (panel-side `requestEdgeIOfv` lazy load on edge hover/click + sortable drill-down). Decision rationale: per-subject iOFV ranking *within* one fit isn't a recognised standalone diagnostic per the published PopPK literature (PsN `cdd`, PAGE linearized-dOFV) — meaning only emerges in the paired ΔiOFV-between-related-fits framing this lays groundwork for. Six new tests (3 phi parser, 3 edge summary).

- **feat: `parsePhi` runtime parser for NONMEM `.phi` files (v0.0.125).** Foundation for ΔiOFV diagnostics — surfaces per-subject ETA estimates and individual OFV from `<basename>.phi`. Multi-table aware (one table per `$EST` step); `lastPhiTable()` returns the final-step table per the last-$EST-wins rule shared with `parseExtFit`. Treats any column whose header ends in `OBJ` (`OBJ`, `SAEMOBJ`, …) as the iOFV column to handle NM7's per-method header variants. PHC (conditional covariance) columns parsed past but not surfaced — kept for future shrinkage / IIV-distribution diagnostics. Not yet wired into any view: raw iOFV is methodologically uninterpretable in isolation (-2·LL has a method-dependent additive constant); it's only meaningful as ΔiOFV between paired parent/child runs. The intended consumer is the M11 Run Lineage view (case-deletion–style "which subjects benefit from the change").

### Fixed

- **fix: `shortMethodLabel` unknown-method fallback preserved case (v0.0.124).** v0.0.123's fallback returned `base.trim() + '-eval'` where `base` was `method.toLowerCase()` — so for any unknown method (e.g. hypothetical NM76+ "Monte Carlo EM (Evaluation)") the fallback rendered `monte carlo em-eval`, fully lowercased. The non-eval branch returned `method` verbatim with original case. Now strips `(Evaluation)` from the original mixed-case `method` and appends `-eval`, giving `Monte Carlo EM-eval`. Also dropped the redundant `.trim()` (the same-line `.replace(/\s+/g, ' ')` collapses internal whitespace; `.trim()` once at the end suffices). New regression test covers the case-preservation and the multi-space collapse.

- **fix: review pass — three real bugs from v0.0.115-v0.0.122 (v0.0.123).** (1) `pickInit` regression: for the empty-init `$THETA (-1, , 1)` form (and the bare-form NaN case), the .ext-iteration-0 fallback made `r.init` finite, which silently disabled the muted-with-tooltip indicator (the `impliedInitCell` gate was `!isFinite(r.init)`). Added `impliedInit: boolean` to `InspectorRow` set by `pickInit` when the fallback path took effect; client gates on the flag now, not on numeric finiteness. The "this isn't from .mod text" indicator fires correctly again. (2) Duplicate `transformValue` in `client.js` shadowed the `transforms.js` definition (loaded first). The `client.js` copy never received the `prefsArg` parameter or any future bug fix — anything we changed in `transforms.js` was silently overridden at runtime, including the unit-tested code path. Removed the duplicate. (3) `shortMethodLabel` pass-through: when the method name didn't match any known pattern AND included `(Evaluation)`, the `-eval` suffix wasn't appended, so the EVAL-ONLY badge never fired for unknown methods. Now strips `(Evaluation)` and appends `-eval` for any unmatched method too — covers any future NONMEM 7.6+ method we haven't taught the inspector about yet.

### Added

- **feat: visible signals for MAXEVAL=0 evaluation-only runs (v0.0.122).** Two complementary signals so users skimming the inspector can't miss the special status: (1) yellow `EVAL ONLY` badge next to the method badge in the summary header, tooltipped with "MAXEVAL=0 — NONMEM evaluated the model at the initial estimates without iterating. FE = initial values, no SE / RSE / shrinkage / termination diagnostics. Useful for sanity-checking model setup; not a fitted result." (2) The OFV headline above THETA changes from `OFV` to `OFV (at init)` with the same tooltip — so the headline number reads as evaluation-at-init, not a converged fit. Both gated on `methodShort.endsWith('-eval')` (set by v0.0.121's `shortMethodLabel` for `(Evaluation)`-suffixed methods).

### Fixed

- **fix: `shortMethodLabel` recognises NONMEM's `(Evaluation)` suffix from MAXEVAL=0 runs (v0.0.121).** When `$EST METHOD=0 MAXEVAL=0` runs, NONMEM emits `#METH: First Order (Evaluation)` verbatim. The pattern table did exact-match `m === 'first order'` so the verbose `First Order (Evaluation)` string fell through to the pass-through and rendered as the full string in the method badge. Now strips the `(Evaluation)` suffix for the pattern lookup, adds a `-eval` suffix back to the result so the badge reads `FO-eval` / `FOCE-INTER-eval` etc — the user can still tell it was an eval-only run. New parse-lst test covers the suffix variants.

- **fix: init column falls back to .ext iteration-0 when vscode-nmtran returns NaN / undefined (v0.0.120).** For bare-form declarations like `$THETA 1` and `$OMEGA 0.1`, vscode-nmtran has been observed returning `init: NaN` (or undefined). The `.ext` iteration-0 row holds the value NONMEM actually used — same as where `fit.inits` already comes from. New `pickInit` helper prefers the model value when finite, falls back to `fit.inits.get(name)` otherwise. Applied to THETA, OMEGA-diagonal, and SIGMA-diagonal paths. The empty-init `$THETA (-1, , 1)` muted-midpoint display still works (vscode-nmtran returns null + bounds present → midpoint computed in client.js); only the bare-form NaN path changes behaviour. New regression test covers the NaN fallback for both THETA and OMEGA.

- **fix: termination-codes display shows only non-zero values, no misleading labels (v0.0.120).** The `.ext -1000000007` row is "termination status (first item) followed by termination codes" with a long zero-padded tail matching the .ext column count. Earlier rendering listed all values including the zeros (16+ entries with 13+ "(success)" labels — noise) and applied a 0-7 EM-method label mapping that mis-labelled FORTRAN error codes like 134 / 50 / 54 as "cov failure". Now filters to non-zero values only and shows raw numbers without `(label)` suffix; tooltip explains "Bauer NM7 docs reference textmsgs.f90 for full code interpretation". The first non-zero code typically matches the `(ERROR=N)` reason text already shown by the diagnostics block, so the line is supplementary not redundant.

### Changed

- **chore: client.js split into navigable modules; transforms unit-tested (v0.0.119).** Resolves the long-deferred review finding HIGH #6. Pulled out two helper files alongside the inspector script:
  - `media/fit-inspector/formatters.js` — `fmtNum`, `fmtRse`, `fmtPVal`, `fmtShrinkage`, `fmtNsd`, `badge`, `terminationCodeLabel`
  - `media/fit-inspector/transforms.js` — `matrixIsDiagonal`, `buildDiagBaseValues`, `transformValue`, `collectEtaShrinkages`, `collectEpsShrinkages`
  
  All three files load via plain `<script src="…">` tags (no CSP gymnastics, no module loaders, no bundler change — same model as the lineage panel's IIFE output). Functions remain top-level globals; the WebView still sees them inline. `transforms.js` adds a dual-mode CJS export guard at the bottom (`typeof module !== 'undefined'`) so vitest can `require()` the pure functions for unit testing — browsers ignore via the guard. New `test/views/transforms.test.ts` covers the math we never had tests for: `transformValue` correlation formula, `buildDiagBaseValues` diagonal extraction, `matrixIsDiagonal` access-key parsing — 11 tests, including the off-diagonal-correlation edge case (zero / negative / missing diagonal). client.js shrunk 1083 → 1002 lines; net gain is testability of the math, not LOC.

### Added

- **feat: per-`$EST` termination codes rendered in diagnostics (v0.0.118).** `terminationCodes` (parsed from `.ext` row `-1000000007`) was being plumbed through to `InspectorDiagnostics.terminationCodes` since v0.0.97 but never rendered. Now shows below the termination-phrase line as e.g. `term codes: 2 (max evals), 0 (success)` for a SAEM→FOCE chain — each code with a Bauer-manual short label (success / rounding / max evals / near boundary / NaN-overflow / user interrupt / cov failure) and color-tiered (green = 0, yellow = 1-3, red = 4+). Supplements the verbatim-phrase line which only shows the LAST step's state — the per-step view tells you e.g. "SAEM warmup hit max-iter, IMP-EONLY succeeded" at a glance.

### Changed

- **chore: aux-file lookups consolidated — single `findExtFile` walk per active-editor change (v0.0.117).** `loadPrderr` and `loadFmsg` were each calling `findExtFile(lstPath)` independently, doing two filesystem walks for the same answer. Resolved once at the top of `resolveLstMode` and the `modelfitDir` shared with both readers via parameter. Modest perf win on slow / network-mounted filesystems; clearer call site.

- **chore: `lineage-panel.ts` `pickRunFromGraph` shared QuickPicker (v0.0.117).** `setParent` and `createRelation` had ~50 lines of near-identical "discover lineage → filter self → map to QuickPickItem → showQuickPick" boilerplate. Extracted into `pickRunFromGraph(log, opts)` taking `{ title, placeHolder, excludePath, noneOption? }`. Net −35 lines; future relation-edit actions ("compare with…", "promote across lineages") become 8-line additions.

### Fixed

- **fix: boundary detection now honours NONMEM's implicit ±1e+06 sentinels (v0.0.116).** A THETA written as `$THETA 4.79` (no bounds) implicitly has bounds at ±1e+06. The inspector renders these muted with a tooltip, but `computeBoundary` was using strict `===` against `null` lower/upper and never fired the orange `boundary` highlight when the estimator pegged at the sentinel. Now passes `lower ?? -1e+06` and `upper ?? 1e+06` for THETA so a final at the implicit bound gets the same orange treatment as an explicit one.

- **fix: parseExtFit multi-$EST asymmetry — earlier step's stdcorr could leak forward (v0.0.116).** Each `TABLE` header reset only `initRow` previously, leaving `finalRow` / `seRow` / stdcorr / fix-flag / term-code rows accumulating across TABLEs. If an earlier step (e.g. SAEM) emitted `-1000000004` (stdcorr finals) and a later step (e.g. IMP-EONLY) didn't, the earlier step's values leaked through as if they were the final-step's result. Now resets ALL captured rows on each TABLE so the last $EST step's values consistently win — matches the convention used everywhere else.

- **fix: SE/N parsing anchored to the ETABAR block (v0.0.116).** Reading `SE:` / `N:` globally was theoretically vulnerable to collision with NONMEM's matrix-block column headers (`SE` is generic — emitted in `STANDARD ERROR OF ESTIMATE` and other tabular contexts). Empirical .lst files in our probe set don't trigger this today, but the regex was a future-regression hazard. New `readEtabarBlock` finds the LAST `ETABAR:` line, then reads `SE` / `N` / `P VAL.` only within the next ~30 lines below — same positional-anchoring pattern `readEigenvalues` already uses.

### Changed

- **chore: parse-lst DRY — `lastMatch(re, text)` helper centralises the global-flag matchAll-then-take-last pattern (v0.0.116).** 4 call sites previously each spelled out `[...text.matchAll(re)]; matches[matches.length-1]`. Single helper now, ~12 lines net subtract.

- **chore: `covMatrixSingular` cast hardened with runtime guard (v0.0.116).** Cast was `as 'R' | 'S'` against the regex capture; if a future regex change widened the capture group the cast would silently produce out-of-union values. Replaced with explicit `letter === 'R' || letter === 'S'` check.

- **fix: phantom THETA / OMEGA / SIGMA rows filtered using .ext as authoritative (v0.0.115).** vscode-nmtran's parser was observed returning 4 phantom THETA entries for a minimal `$THETA 1` model (and same for OMEGA). The `.ext` is the authoritative source for parameter count in lst-mode — every real parameter has a `THETA<i>` / `OMEGA(i,j)` / `SIGMA(i,j)` column there. New `filterByExtColumns` drops decl entries whose access key isn't an `.ext` column. Mod-mode (no fit) passes through unchanged. Replaces the prior test "decl with no matching .ext column → final stays null" — which encoded the obsolete pre-lst-embedded-control-stream behaviour where the live `.mod` was the model source — with two new tests covering the filter and the mod-mode passthrough.

### Changed

- **chore: OFV display toned down (v0.0.115).** Earlier 1.6em bold value with blue accent + padded background read as a banner. Now a slim line above THETA at body-text size with a small uppercase `OFV` label and bold value — emphasised but not overpowering.

- **chore: deferred review-pass items addressed (v0.0.115).** (1) `read-prderr.ts` and `read-fmsg.ts` now thin wrappers around shared `read-archived-file.ts` (extract-from-NM_run1-or-7z logic deduplicated; new readers for other archived files take ~10 lines each). (2) `mockLst()` test fixture builder factored out (`test/__helpers__/mock-lst.ts`); collapsed 4 inline `LstSummary` literals across 2 test files. (3) `TERM_REASON_RE` end-of-file fallback tightened — old `\n\s*$` only matched at end-of-string (no `/m` flag) so a malformed truncated lst could capture the entire remainder; now uses `\n\s*\n` (blank line) as the third alternative. (4) `rseStdcorr` no longer computed for THETA — identity to the variance-form RSE there, never read by the client; explicit null saves a Map lookup per row.

### Changed

- **chore: COV-method consolidated into a single summary badge; OFV promoted above THETA (v0.0.114).** RSE column headers now read bare `RSE` everywhere — the matrix-derivation tag (sandwich `RSR`, `R`-only, `S`-only, `From Sample Variance`, `from $DESIGN`, `R singular`) was redundant across THETA / OMEGA / SIGMA. Pulled it into a single badge next to the estimation-method badge in the summary header (e.g. `[FOCE-INTER] [RSR]`), tooltipped with the full explanation. OFV moved out of the summary line into a prominent block right above the THETA table — large bold value, blue accent border — since it's the headline number a modeller checks first.

### Fixed

- **fix: SAEM / IMP termination phrases now recognised (v0.0.114).** Earlier code only matched `MINIMIZATION SUCCESSFUL` / `OPTIMIZATION (WAS) COMPLETED` / `MINIMIZATION TERMINATED` / `OPTIMIZATION TERMINATED` / `OPTIMIZATION WAS NOT TESTED FOR CONVERGENCE`. Empirical run004 (SAEM→IMP-EONLY) emits none of those — instead `STOCHASTIC PORTION WAS NOT COMPLETED` (SAEM step) and `EXPECTATION ONLY PROCESS WAS NOT COMPLETED` (IMP EONLY step). All three SAEM/IMP variants (`STOCHASTIC PORTION WAS (NOT) COMPLETED`, `REDUCED STOCHASTIC PORTION WAS (NOT) COMPLETED`, `EXPECTATION ONLY PROCESS WAS (NOT) COMPLETED`) now map to the `NOT_TESTED` bucket; verbatim phrase preserved as `terminationPhrase` for display.

- **fix: shrinkage-source fallback was dead — empty array fallthrough (v0.0.114).** `collectEtaShrinkages` / `collectEpsShrinkages` used `d.etaShrinkVr || d.etaShrinkSd` to fall back from variance-scale to SD-scale when VR was absent. Empty arrays are truthy in JS, so `[] || x` returns `[]` not `x` — the fallback never fired. Switched to `.length`-based selection so SD is actually used when VR is empty.

- **fix: `fmtNsd` collapses trailing `.0` for integer NUMSIGDIG values (v0.0.114).** `fmtNum(8.0)` returns `"8"` (parseFloat strips), but adjacent rows show `"9.2"` — inconsistent precision in the same column. NSD cells now use `toFixed(1)` for both bad and OK paths so values uniformly render to one decimal.

### Removed

- **chore: dead code cleanup (v0.0.114).** Removed `fixCell`, `fmtSigDig`, `wrapParens`, `wrapBrackets`, `wrapWith`, `rseMatrixSuffix` — defined but no longer called after the layout pass.

- **feat: stale-run auto-fail removed (v0.0.113).** The `positronNonmem.staleRunTimeoutMinutes` setting and the underlying timeout that auto-failed running entries after N minutes are gone. Realistic NONMEM runs can take a week or more (large simulation studies, BAYES with many iterations, big covariate models) and there's no good single threshold; better to never auto-fail than to false-positive on long-but-legitimate runs. Code: dropped `staleTimeoutMs` from `ActiveRunsWatcherDeps`, removed the per-run `staleCancellers` Map, deleted `scheduleStaleTimeout`, dropped the corresponding 3 unit tests.

### Changed

- **chore: settings renamed `positronNonmem.*` → `nonmem.*` (v0.0.113).** All 8 surviving user-facing configuration keys (shrinkageWarnPct, rseThetaWarnPct, rseOmegaWarnPct, rseWarnPct, pValWarnThreshold, pValBadThreshold, lineages, lineageOfvThreshold, lineageOverrides) now live under the shorter `nonmem.*` namespace. Internal command IDs and view IDs (e.g. `positronNonmem.runModel`, `positronNonmem.runs`) keep their existing names — those aren't user-facing settings, and renaming them would break keybindings without practical benefit. **Migration: workspaces with overrides under `positronNonmem.*` need to be migrated manually** — VS Code doesn't auto-translate setting keys.

- **chore: settings section renamed `Positron NONMEM` → `NONMEM` (v0.0.113).**

### Fixed

- **fix: suppress matrix tag in RSE header when COV matrix went singular (v0.0.113).** When `$COV MATRIX=R` / `MATRIX=S` is requested but the matrix goes singular, NONMEM still emits a tagged SE block with zero values (couldn't invert). The header used to render `RSE R` / `RSE S` then — misleadingly suggesting valid SEs from that matrix when there are none. Now the header drops the tag whenever `covMatrixSingular` is set; the diagnostics banner ("R/S matrix algorithmically singular — no SEs") carries the explanation. Empirically verified across run001 / run006 / run007.

### Changed

- **chore: settings section renamed `Positron NONMEM` → `NONMEM` (v0.0.113).**

- **chore: staleRunTimeoutMinutes default raised 24h → 14 days (v0.0.113).** Realistic NONMEM runs can take a week or more — large simulation studies, BAYES with many iterations, big covariate models. The 24-hour default would auto-fail legitimate long runs; 14 days gives ample headroom while still cleaning up truly-dead entries within a reasonable window. Set to 0 to disable entirely.

### Fixed

- **fix: matrix tag missing for FOCE-classical default `$COV` (v0.0.112).** When NONMEM emits the SE block without a parenthetical matrix tag — the canonical FOCE / FOCEI + default `$COV` case — we previously rendered bare `RSE` because no tag was captured. Per the $COV docs ("the covariance matrix will be different from the default (R⁻¹SR⁻¹)"), the bare header signals "default sandwich was used"; NONMEM only attaches the tag when it deviates (ITS S-only, BAYES sample-variance, explicit MATRIX=…). New `LstSummary.seBlockEmitted` boolean detects "any SE block printed regardless of parenthetical"; the client now infers `RSR` as the suffix when an SE block is present but no explicit tag — so a clean FOCE-INTER fit reads `RSE RSR` (the sandwich) instead of bare `RSE`. `$DESIGN` keeps its explicit `from $DESIGN` suffix; explicit `STANDARD ERROR OF ESTIMATE (X)` headers continue to use the captured X. Empirically verified against `~/positron-nonmem/probe-psn/slow/run001.lst`.

### Added

- **feat: ETA diagnostics table now shows SE and N columns (v0.0.111).** Matches the .lst format `ETABAR / SE / N / P VAL.` instead of just `ETABAR / P VAL.` Parses two new rows from the .lst's ETABAR block: `etabarSe` (between-subject SE of the eta means — denominator of the P-value test) and `etaN` (per-ETA subject count). Empirically confirmed only one `SE:` and one `N:` label appear in the lst (the matrix STANDARD ERROR / OMEGA blocks use different headers), so the readNumericRow last-occurrence rule is unambiguous.

### Changed

- **chore: scale-of-RSE explanation moved from inline `(SD)` to column-header tooltip (v0.0.111).** OMEGA / SIGMA RSE column header now reads bare `RSE <matrix>` (e.g. `RSE RSR`) — the kind-specific scale + source explanation lives on the header tooltip instead of inline. THETA also gets a tooltip explaining "RSE = SE / |θ| from .ext row -1000000001. No scale transform — θ is not a variance, so SD-vs-VAR distinction does not apply." Cleaner header, full context one hover away.

- **feat: capture and surface NMTRAN parse errors from FMSG (v0.0.110).** When the model fails to compile (e.g. `$THETA (a, , )` triggers NMTRAN error 93 "WITH NO INITIAL ESTIMATE, FINITE LOWER AND UPPER BOUNDS NEEDED"), no `.lst` is produced — the only diagnostic source is `FMSG` in `NM_run1/`. New `read-fmsg.ts` runtime module mirrors `read-prderr.ts` exactly (same dual-path: plain file under `NM_run1/` first, fall back to extracting from `NM_run1.7z` via runner). Wired into `VariablesContext.fmsg` → `InspectorDiagnostics.fmsg`. Inspector renders a prominent red banner ("NMTRAN parse error — model failed to compile") when `hasErrors=true`, with the foldable content auto-expanded. Empty FMSG → null → block hidden. Detection: `AN ERROR WAS FOUND` substring (matches NMTRAN's literal preamble for parse errors). Empirically verified by run013 — `$THETA (-1, , )` puts error 93 in FMSG; the inspector now shows the full parse-error context instead of an empty diagnostics block.

- **feat: parse `PARAMETER ESTIMATE IS NEAR ITS BOUNDARY` + boundary-test-omitted flags (v0.0.109).** NONMEM's default boundary test (`THETABOUNDTEST` / `OMEGABOUNDTEST` / `SIGMABOUNDTEST` $EST options, all default ON) emits a "PARAMETER ESTIMATE IS NEAR ITS BOUNDARY" warning when triggered. We now parse it directly into `LstSummary.parameterNearBoundary` and surface a yellow banner in the diagnostics block — sumo also flags this as a status row but the banner is more discoverable. Additionally parse the per-type "DEFAULT (THETA|OMEGA|SIGMA) BOUNDARY TEST OMITTED:" flags (NOTHETABOUNDTEST etc.) into `LstSummary.boundaryTestOmitted` — when any test is disabled, we add a "Default boundary test omitted for: …" note so the user knows sumo's "no parameter near boundary" status is unreliable for that variable type. Empirically verified across the probe set (run001/run006 hit "near its boundary" on FOCEI with sparse data; all probes show "DEFAULT … BOUNDARY TEST OMITTED: NO" since none disable the test).

- **feat: empty-init `$THETA` rendered as muted midpoint (v0.0.109).** When a model uses `$THETA (lower, , upper)` to ask NONMEM to compute the init, vscode-nmtran returns init as null/undefined/NaN. The IE column now renders `(lower + upper) / 2` in muted style with a tooltip ("Empty init slot in $THETA — NONMEM computes the midpoint of bounds at PRED initialization"). Doc-confirmed by `nmguides.vrognas.com/part-i/c-simple-regression #sec-c-3-4` ("if an initial estimate of some θ is not given, then the midpoint between the lower and upper bounds is used"). Empirically verified by run012 — `(-1, , 1)` runs with init=0 in the search trace.

### Changed

- **chore: implicit-bound display extended to OMEGA / SIGMA diagonals (v0.0.108).** OMEGA / SIGMA diagonals now show implicit bounds in muted style: lower = `0` (variance ≥ 0; positive-definiteness constraint, doc-confirmed by `nmhelp.tingjieguo.com/$omega` and `/$sigma`), upper = `1e+06` (NONMEM's no-bound sentinel by analogy with THETA). Both come with explanatory tooltips. Off-diagonals keep em-dash because their bound is the matrix-PD constraint `|cov| ≤ √(varᵢ·varⱼ)` — depends on the diagonals, not a scalar. Empirically grounded by run011 which confirmed NONMEM's `.lst` doesn't echo per-element OMEGA / SIGMA bounds and the `(a, b, c)` syntax that works for `$THETA` is parsed differently for these matrix records.

- **chore: surface NONMEM's implicit ±1e+06 no-bound sentinels (v0.0.107).** When a `$THETA` row omits a bound, vscode-nmtran returns null and we used to render em-dash. Now the LB/UB cell shows `-1e+06` / `1e+06` in muted style with a tooltip ("Implicit lower/upper bound — no bound given in $THETA, NONMEM uses ±1e+06 as its no-bound sentinel"). Empirically verified via `run010.mod` — bare `$THETA 5.0` yields `LOWER BOUND -0.1000E+07 / UPPER BOUND 0.1000E+07` in the .lst INITIAL ESTIMATE block. OMEGA / SIGMA continue to em-dash since vscode-nmtran doesn't expose their bounds today (different situation: parser limitation, not omitted in .mod).

### Fixed

- **fix: code-review pass on recent parser additions (v0.0.106).** Three small bugs caught: (1) `covMatrixSingular` regex used `match()` not `matchAll()` — first occurrence won, breaking the multi-`$EST` last-step convention used elsewhere. Now uses `matchAll` + last. (2) `$DESIGN` regex `/\$DES(?:IGN)?\b/` matched bare `$DES` too — but `$DES` is the differential-equations record (used inside `$SUBROUTINES` ADVAN/TRANS for ODE models, very common in pharmacometrics). Fixed to require the full `$DESIGN` keyword. (3) `fmtNsd` formatted bad cells with `toFixed(1)` while OK cells used `fmtNum` (parseFloat-toFixed-3) — same value rendered as `9.2` or `9.234` depending on highlight state. Unified on `fmtNum` for both.

### Added

- **feat: NSD column red-highlights below the user-requested NSIG target (v0.0.106).** Parse `NO. OF SIG. FIGURES REQUIRED:` from the .lst (echoed by NONMEM from `$EST NSIG=N` / alias `SIGDIGITS=N`, default 3) into `LstSummary.nsigRequired`. Threaded into `InspectorThresholds.nsigRequired`. Per-parameter NUMSIGDIG cells below this target render red (`bad` class) — that's NONMEM telling you which params didn't reach the user's bar. No threshold from .lst → no highlighting (graceful fallback for old NONMEM / mod-mode / aborted runs). Confirmed against `nmguides.vrognas.com/part-viii/iii-dd-ctl` ($ESTIMATION record options).

### Changed

- **chore: cleaner column-header labelling (v0.0.105).** OMEGA / SIGMA RSE column now reads `RSE (SD) <matrix>` (e.g. `RSE (SD) RSR`) so the user can see at a glance that RSE is reported on the SD / correlation scale regardless of the `√Ω/ρ` value-display toggle. THETA stays as `RSE <matrix>` (no scale ambiguity for fixed effects). `%` dropped from RSE and Shrinkage headers since cells already emit `12.34%`.

### Fixed

- **fix: RSE no longer changes with the `√Ω/ρ` toggle (v0.0.104).** Previously the toggle picked between two RSE sources: NONMEM's authoritative `-1000000005` row when ON, our `cvse/2` Taylor approximation when OFF. But RSE is a unit-free ratio — for OMEGA / SIGMA it's intrinsically on the SD / correlation scale and shouldn't depend on whether the *value* column displays variance or SD. Worse, the `cvse/2` approximation is mathematically wrong for off-diagonals (treats correlations like diagonals), giving values up to 2× off (e.g. OMEGA(2,1) `617%` cvse/2 vs `1263%` correct). Now we always use NONMEM's stdcorr-form RSE when present (the typical case post-NM72), falling back to `cvse/2` only when the row is absent (older NONMEM, or no $COV). The toggle is now purely a display choice for the FE column.

### Changed

- **fit-inspector layout pass (v0.0.103).** Five complaints addressed in one pass: (1) Label column dropped when no row has an inline `;<comment>` label (most models) — reclaims ~16% of pane width; class-based column widths so alignment between THETA / OMEGA / SIGMA stays intact when the column is conditionally absent. (2) Tables now fluid (`width: 100%`) instead of fixed `666px` — fill the pane like the ETA shrinkage table already did. (3) Added `NSD` (NUMSIGDIG) column — per-parameter significant-digit count from `.lst`'s `NUMSIGDIG:` row, was parsed but never displayed. (4) Dropped redundant `Shrinkage (SD)` column from the diagnostics ETA / EPS tables — same data is in OMEGA / SIGMA's `Shrinkage%` column; the EPS shrinkage table is gone entirely (it had no other content). The diagnostics ETA table is now `Name | ETABAR | P VAL.`. (5) Removed parens / brackets around RSE and Shrinkage values and headers (`(0.90%)` → `0.90%`, `[Shrinkage%]` → `Shrinkage%`) — secondary-stat visual weight preserved via cell-level dimming, threshold colors (warn / bad) still override.

### Added

- **feat: probe model run009 — confirms ITS→IMP-EONLY chain for proper sandwich SEs (v0.0.102).** ITS alone never builds the Hessian (R), so default `$COV` after ITS produces `STANDARD ERROR OF ESTIMATE (S)` — first-order approximation only. Chaining `METHOD=IMP EONLY=1 ISAMPLE=1000 NITER=5` after ITS makes IMP compute R numerically from importance samples, after which the default `$COV` produces the proper sandwich `(RSR)`. Mirrors the canonical SAEM→IMP idiom (run004). Empirically verified on the live host: `run009.lst` shows BOTH tags `(S)` then `(RSR)` (per-$EST), our parser's last-occurrence rule picks `(RSR)` and the `(RSE%)` column header reads `(RSE% RSR)`. Source docs: NM7 `$COVARIANCE` record (`nmguides.vrognas.com/part-viii/iii-dd-ctl#sec-dd-covariancecovr` — "the covariance matrix will be different from the default (R⁻¹SR⁻¹)") and EM methods (`/nm7/em-monte-carlo` — "the SAEM setting produces first order approximation standard errors, that is, MATRIX=S type"). No code change — parser already handled chained tags correctly.

- **feat: RSE-derivation method shown in (RSE%) column header (v0.0.101).** The .lst's `STANDARD ERROR OF ESTIMATE (X)` parenthetical (`R` / `S` / `RSR` / `From Sample Variance`) flows into `LstSummary.rseMatrix` and is appended to the (RSE%) column header — `(RSE% RSR)` / `(RSE% S)` / `(RSE% From Sample Variance)`. When `$DESIGN` is in the control stream (NM75+ optimal-design FIM), the suffix becomes `(RSE% from $DESIGN)`. Falls back to the EIGENVALUES tag when no SE-block header was emitted (BAYES). New probe models: `run006` ($COV MATRIX=R), `run007` ($COV MATRIX=S), `run008` ($DESIGN GROUPSIZE=5 FIMDIAG=1 — Bauer 2021 tutorial Example 1). Empirically verified across all 8 probes.

- **feat: separate R vs S singular-matrix banners (v0.0.101).** Generalized `rMatrixSingular: boolean` to `covMatrixSingular: 'R' | 'S' | null` — the COV step can fail with either matrix singular depending on `$COV MATRIX=` choice. The diagnostics banner names the specific matrix and the dump file (`.rmt` for R, `.smt` for S).

- **feat: empirically-validated estimation-method coverage (v0.0.100).** Ran the per-method probe set (`empirical-models/run001..run005`, FOCEI / ITS / IMP / SAEM / BAYES) on the live NONMEM 7.6 host and used the outputs to extend `parse-lst.ts`. Three findings surfaced: (1) `EBVSHRINKSD(%)` / `EBVSHRINKVR(%)` rows are emitted by **every method** directly into the `.lst` — no `.shk` parser needed for empirical Bayes Variance shrinkage. Added `ebvShrinkSd` / `ebvShrinkVr` to `LstSummary` + `InspectorDiagnostics`. (2) ITS and IMP emit `OPTIMIZATION WAS NOT TESTED FOR CONVERGENCE` — neither SUCCESSFUL nor TERMINATED. Added `'NOT_TESTED'` as a third termination state, rendered yellow (`fix` class) in the inspector. (3) When the COV step's R matrix is singular, NONMEM emits `R MATRIX ALGORITHMICALLY SINGULAR` and dumps R to a `.rmt` file instead of `.cov`/`.cor`/`.coi`. Added `rMatrixSingular` flag + an explicit banner in the diagnostics block so blank SE columns get an explanation. The empirical comparison matrix is captured in `docs/empirical-notes.md` under "Per-method output-file probe".

- **feat: Tier-2 .lst convergence-quality signals (v0.0.99).** Parse the four `.lst`-only signals that sumo doesn't surface: (1) `#CPUT:` total CPU seconds (≠ wall-clock for parallel runs), (2) `#PARA:` parallel node count, (3) the LAST iteration's `GRADIENT:` row from MONITORING OF SEARCH (`max |grad|` is the cheap "did we actually converge" check), (4) `RESET HESSIAN` count + `DIAGONAL SHIFT OF X WAS IMPOSED` magnitude (load-bearing Hessian-quality flags). All five surface in the Fit Inspector's diagnostics block as a single `' · '`-joined line: e.g. `max |grad| 1.2e-4 · Hessian reset 3× · diagonal shift 5e-4 · CPU 35.4s · 4 nodes`.

### Fixed

- **fix: column alignment regression — LB / IE / UB drifted apart between THETA and OMEGA / SIGMA tables (v0.0.98).** Two underlying causes: (1) `width: auto` defeats `table-layout: fixed` (per CSS spec — fixed layout requires a definite width to apply), so per-column widths were ignored and each table auto-sized to its own content; (2) THETA was emitting 7 columns while OMEGA / SIGMA emitted 8, so even with fixed layout the column count differed. Fixed by setting an explicit `width: 666px` (sum of column widths) on `.param-table` and always emitting the 8th `[Shrinkage%]` column for THETA too (em-dash placeholder).

### Added

- **feat: Tier-1 NONMEM .ext sentinel rows + `#OBJV:` machine-tag (v0.0.97).** Read the `-1000000004` (OMEGA/SIGMA in SD/correlation form), `-1000000005` (matched SE), `-1000000006` (FIX flags) and `-1000000007` (termination codes) rows authoritative-from-NONMEM. The Fit Inspector now displays NONMEM's own SD/correlation values under the `√Ω/ρ` toggle instead of computing `Math.sqrt(v)` / `cov / √(vᵢvⱼ)` itself — eliminates the derivation-bug class entirely (older builds without these rows fall back to the previous client-side math). RSE on the SD scale uses the `-1000000005` SE directly (no cvse/2 Taylor approximation when the row is present). FIX detection prefers the .ext flag over the .mod parse (covers BLOCK off-diagonals correctly). OFV preference order is now `.ext OBJ → .lst #OBJV: → null`; sumo's parsed OFV no longer enters the chain.

### Fixed

- **fix: Fit Inspector polish pass (v0.0.96).**
  - **Orange `.warn` color now uses `--vscode-editorWarning-foreground`**
    (squiggly-underline color, consistently saturated across themes).
    `--vscode-charts-orange` rendered too dim in some peach/amber
    palettes — borderline RSE/p-values were nearly invisible.
  - **Columns align across THETA / OMEGA / SIGMA tables.**
    `table-layout: fixed` + per-column widths so `LB / IE / UB / FE /
    (RSE%) / [Shrinkage%]` line up at the same x-positions across all
    three sections. Was visually inconsistent because each table
    auto-sized columns independently.
  - **`[Shrinkage%]` column now appears on SIGMA too**, sourcing from
    EPSSHRINKSD(%) / EPSSHRINKVR(%) — analogous to OMEGA's per-row
    shrinkage from ETA shrinkage. Off-diagonals em-dash.
  - **Shrinkage scale follows the `√Ω/ρ` toggle**: when off →
    variance-scale shrinkage (`ETASHRINKVR(%)` / `EPSSHRINKVR(%)`);
    when on → SD-scale (`ETASHRINKSD(%)` / `EPSSHRINKSD(%)`). Mirrors
    the value column's variance/SD switch. New `etaShrinkVr` /
    `epsShrinkVr` parsed from `.lst`.

- **fix: LB / IE / UB columns restored to Fit Inspector (v0.0.95).**
  v0.0.86's Pirana compact layout dropped the bound columns —
  regression. Restored:
    mod-mode:  `# | Label | LB | IE | UB`
    lst-mode:  `# | Label | LB | IE | UB | FE | (RSE%) | [Shrinkage%]?`
  FIXED rows still indicated by the global blue row-tint, so no
  separate `Fixed` column needed. Tooltips on each column header.

### Changed

- **feat: click-on-node activates Fit Inspector with NO editor open
  (v0.0.94).** Prior behaviour opened the .lst as a preview tab
  (italic) — focus stayed on the lineage view but the tab still
  appeared. New flow goes through a `showInInspector(lstPath)`
  callback that resolves the lst-mode context directly via
  `resolveContextForLstUri` (new public wrapper around the existing
  `resolveLstMode`) and pushes the InspectorPayload via the same
  `pushVariables` path the active-editor watcher uses. No
  `showTextDocument` call, no tab. When a node has no .lst yet
  (run hasn't completed), falls back to opening the .mod as a real
  tab — there's nothing to inspect, the user wants the source.

### Added

- **feat: dataset-grouped sections in "All Runs" lineage (v0.0.94).**
  Each `$DATA` source becomes its own section with a header banner
  (`data: <filename> · N runs`) and the runs that use it. Sections
  stack vertically, ordered by run count descending. Within each
  section, the existing layout applies — branchy trees first, then
  the singleton wrap-grid below. A child run that changes its `$DATA`
  inherits its parent's section so tree topology stays intact (the
  data change is still annotated on the node label as
  `data: <new-file>`). Curated lineages skip grouping — the user
  curated the set, further partitioning would split their narrative.

### Changed

- **feat: singleton wrap-grid + review-driven cleanups (v0.0.93).**
  - **Wrap-grid for singleton roots in "All Runs" view.** Without it,
    a workspace with 100+ unrelated runs renders as one giant
    horizontal row (d3.tree() spaces all top-level children evenly
    across width). Singletons (top-level roots with no descendants)
    now get a wrap-grid layout below the branchy trees — `GRID_COLS`
    per row, wrapping. Curated lineages skip this since the user
    explicitly chose the set.
  - **Excluded PsN-internal `modelfit_dir*/NM_run*/` from `.lst`
    discovery.** PsN's working `psn.lst` (NONMEM scratch) was
    appearing as phantom nodes in the lineage view.
  - **Shared `parentDirName` helper** in `fs-utils.ts` — three call
    sites collapsed onto it (lineage discovery + two QuickPick
    builders).
  - **`formatNumberCompact` for OFV in QuickPick descriptions.**
    Prior `n.ofv.toFixed(3)` rendered very small / very large OFV
    values lossily (e.g. `6.6e-5` → `0.000`).
  - **Shared `quickPickItemForRun` helper** in `lineage-panel.ts` —
    the `Set parent…` and `Create relation…` pickers now build run
    items via a single helper.

### Added

- **feat: named sub-lineages + dataFile on nodes (v0.0.92).** Two
  features in one ship — both serve the modeling-as-storytelling
  vision (sub-lineages = chapters; dataset visible per node).
  - **Header dropdown** in the lineage panel: `All Runs (workspace)`
    + each named lineage. New `+ New` button creates an empty
    lineage and switches to it.
  - **Curated sets**: a named lineage holds a list of `.mod` paths.
    The discovery layer filters to that set when one is selected;
    `All Runs` keeps the full workspace scan.
  - **Right-click → Add to lineage…** in `All Runs` → quickpick of
    existing names + `Create new lineage…`. Switches to the chosen
    lineage so the user sees the result immediately.
  - **Right-click → Remove from this lineage** in curated mode.
  - **Persistence** via `positronNonmem.lineages` workspace setting
    (`{ "<name>": ["/abs/run001.mod", ...] }`). Git-trackable.
    Parent overrides (`lineageOverrides`) apply across all lineages.
  - **`dataFile` on each node**: extracted from the .mod's `$DATA`
    record (basename only) and rendered as a 4-line label
    (`basename / data: file / OFV / Δ`). Surfaces the dataset choice
    inline — common disambiguator between candidate-equivalent runs.
    Bigger node size (150 × 76) to fit the extra line.

- **feat: tiered orange/red warnings on RSE% + p-value (v0.0.91).**
  Two-tier coloring: orange `.warn` for borderline values, red
  `.bad` for critical. All thresholds workspace-configurable.
  - **THETA RSE%**: orange when > `rseThetaWarnPct` (default 30),
    red when > `rseWarnPct` (default 100).
  - **OMEGA / SIGMA RSE%**: orange when > `rseOmegaWarnPct` (default
    50 — random-effect RSEs are inherently larger), red when >
    `rseWarnPct` (default 100).
  - **ETABAR P-value**: orange when < `pValWarnThreshold` (default
    0.1), red when < `pValBadThreshold` (default 0.05). Replaces the
    prior single-tier `< 0.05 = red` behaviour.
  - All five new settings live under `positronNonmem.*` and persist
    in workspace `settings.json`. New `.warn` CSS class uses
    `var(--vscode-charts-orange)` (theme-aware).

- **feat: ETABAR P-VAL pulled from .lst (v0.0.90).** Diagnostics block
  now surfaces NONMEM's `P VAL.:` row alongside ETABAR — the
  two-sided test that ETABAR ≠ 0. Small p (< 0.05) flags an ETA
  whose mean differs from zero (model mis-specification or omitted
  covariate); rendered in red so the user spots it without scanning
  the .lst manually. New `etaPVal: number[]` field on
  `LstSummary` + `InspectorDiagnostics`. Column tooltip explains the
  test. Empty when the method skips the row (some EM steps don't
  emit it).

### Changed

- **feat: Fit Inspector toggles co-located with their tables (v0.0.89).**
  `exp(θ)` moved inline with the **Theta** heading; `√Ω / ρ`
  (renamed from `√Ω`) moved inline with the **Omega** heading. The
  Omega toggle still drives both Omega and Sigma display. Renamed
  symbol clarifies the off-diagonal behaviour: diagonals → SD,
  off-diagonals → correlation `ρ = cov(i,j) / √(var_i · var_j)`
  (sumo / xpose convention). Tooltip rewritten to lead with that
  fact so users don't expect a literal `Math.sqrt` on covariances.

### Added

- **feat: lineage UX polish (v0.0.88).**
  - **Click on a node activates the Fit Inspector** for that run
    without leaving the lineage viz. The extension opens the run's
    `.lst` (Fit Inspector listens to the active editor) with
    `preserveFocus: true`, so the editor becomes "active" but
    keyboard focus stays on the webview. Falls back to the `.mod`
    when the run hasn't produced a `.lst` yet. Right-click → "Open
    .mod" still does a focused full-tab open.
  - **Parent folder in the node label.** `m.mod` in `verbatim/`
    renders as `verbatim/m`; same-name runs in different folders
    disambiguate at a glance (Improve / Pirana convention).
  - **Configurable ΔOFV significance threshold.** New workspace
    setting `positronNonmem.lineageOfvThreshold` (default 3.84 =
    χ²₁,0.05 per Keizer 2013). Drives the green/red boundary; legend
    interpolates the active value.
  - **Termination status surfaced in the hover tooltip** —
    `✓ minimization successful` / `✗ minimization terminated` /
    `· not run / status unknown`. Node border still shows the
    inbound-edge ΔOFV class (green/yellow/red/gray + blue for root)
    per the Keizer 2013 / Pirana convention.

### Changed

- **feat: branched lineages now anchor at the left of the canvas (v0.0.87).**
  Synthetic-root children sorted by descendant count descending, so a
  branched chain (e.g. run001 → m → m → m) lands at the leftmost
  layout slot rather than getting centred among many single-node
  "scratch" roots. Matches the Improve workbench convention. Internal
  child order at deeper levels is preserved (declaration order from
  `;; Based on:` / path overrides) — only the top-level reshuffles.

### Added

- **feat: drag-and-drop + "Create relation…" two-step picker (v0.0.86).**
  Two new ways to wire runs together, both writing to the same
  `lineageOverrides` workspace setting:
  - **Drag a node onto another** to set the source's parent. Past a
    5-px threshold a real drag begins: source dims, ghost dashed line
    follows the cursor, drop-target node gets a blue dashed outline.
    Release on a different node → parent set; release elsewhere or
    Escape → cancel. Click-without-drag still opens the .mod (the
    pending click is suppressed only when a drag actually happened).
  - **Right-click → "Create relation…"** for the keyboard-navigable
    path. Pick a partner run, then pick whether the starting node
    becomes that partner's parent or child. Same QuickPick UX as
    "Set parent…" so the discoverability scales.
  - Refactored `setParent` / `createRelation` / drag-drop onto a
    shared `writeOverride(child, parent, basename)` helper so all
    three entry points produce identical workspace-setting writes.

- **feat: right-click → "Set parent…" wires any two runs together (v0.0.85).**
  Right-click a node in the lineage view, pick `Set parent…`, choose
  any other run from the QuickPick (including non-`run<NNN>` names —
  Pirana `m.mod`, hand-rolled `colistin.mod`, Improve-style sibling
  `step1/run1.mod` vs `step2/run1.mod`). Path is the canonical identity
  so same-basename runs in different folders disambiguate via the dir
  name in the picker description.
  - Persisted in workspace setting `positronNonmem.lineageOverrides`
    (`{ "/abs/child.mod": "/abs/parent.mod" }`). Git-trackable
    alongside the models.
  - Picker offers a `(none — make this a root)` entry that writes
    `null`, forcing the child to be a root regardless of any
    `;; Based on:` marker in the file.
  - The `;; Based on:` runrecord marker still works — overrides take
    precedence when both are set, so the file remains PsN-compatible
    while the workspace setting is the visual lineage's source of truth.
  - Cycle detection follows path overrides too (A → B → A is caught
    and both nodes become roots, never crashes the renderer).

### Fixed

- **fix: shift + wheel now scrolls the lineage panel horizontally (v0.0.84).**
  Some browsers auto-translate `deltaY` to `deltaX` when shift is
  held; webview-embedded Chromium leaves the value in `deltaY` and
  uses shift purely as an intent signal. Detect `shiftKey` and route
  both deltas into the horizontal axis.

### Changed

- **feat: lineage view rewritten on d3-hierarchy + plain SVG (v0.0.83).**
  Dropped cytoscape, cytoscape-dagre, dagre. Replaced with `d3-hierarchy`
  (Reingold-Tilford tree layout — the canonical "branching tree" shape,
  matches the Pirana / Keizer 2013 reference image) + `d3-shape`
  (Bézier-curve link generator) + plain SVG rendering. Bundle dropped
  from **530 KB to 13.6 KB** (-97 %).
  - Native browser scrollbars work without any wheel-handler hacks —
    the SVG is sized to layout extent × zoom inside `overflow: scroll`.
  - Theme colours apply directly via SVG `fill` / `stroke` attributes
    + CSS class selectors (cytoscape's canvas couldn't read CSS vars
    at all; we had to resolve them at render time).
  - `<g>` per node + native `click` / `contextmenu` event handlers —
    no library-specific event dispatch.
  - Capture-phase wheel handler: ctrl/⌘ + wheel → zoom around cursor
    by scaling SVG `width`/`height` (viewBox stays constant); plain
    wheel → `wrap.scrollBy(...)`.
  - Bug-class barrier intact: still no template-literal HTML carrying
    user data; SVG construction via `createElementNS` + `setAttribute`.

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

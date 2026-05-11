# Empirical notes — positron-nonmem

Mirrors the `supplements/nonmem-tips.qmd` pattern from `nmguides`. When developing this
extension we hit corners of NONMEM / NMTRAN / SSH / Positron-API behaviour that the docs
underspecify or contradict. This file accumulates what we verified live.

Each entry: **Topic.** doc/expectation → probe → outcome.

---

## SSH server banner appears on every connection

**Expectation.** OpenSSH only shows a host-key fingerprint on the *first* connection
(unknown host); thereafter known_hosts suppresses it. So `ssh alias 'uname -a'` should
return uname output and nothing else.

**Probe.** Run via `SshTransport.run('uname -a')` against `primary`-class hosts on this
network. Captured stdout is clean. Captured stderr always includes:

```
Host key fingerprint is SHA256:<hash>
+--[ED25519 256]--+
| ... ASCII randomart ... |
+----[SHA256]-----+
```

i.e. the literal output of `ssh-keygen -lv -f /etc/ssh/ssh_host_*_key.pub`.

**Outcome.** This is **server-side config**, not an OpenSSH client default. The site has
either:

- a `Banner` directive in `sshd_config` pointing at a script that runs `ssh-keygen -lv`, or
- an `/etc/ssh/sshrc` / `/etc/profile.d/*.sh` that prints it on every shell start, or
- a wrapper in the user's login chain.

Client-side mitigations attempted: `-o LogLevel=ERROR`, `-o LogLevel=QUIET`,
`-o BatchMode=yes` — none silence it because the content reaches us as the remote shell's
stderr, after sshd has accepted us.

**How to apply.** The extension surfaces this banner in the Console pane as red stderr on
every command. We accept it for now as a cosmetic issue. If it becomes annoying:

1. Ask the host admin to drop the banner directive (cleanest).
2. Add an opt-in setting `positronNonmem.host.suppressBanner` that filters lines matching
   `^Host key fingerprint is SHA256:` … `^\+----\[SHA256\]-----\+\s*$` from stderr before
   forwarding to Stream messages. Hacky but local.
3. Use a remote helper script (M3+ tailmux already runs there) that re-execs the command
   without sourcing the offending `sshrc`. Requires more remote plumbing than this
   warrants today.

Verified 2026-05-02 against NONMEM 7.6.0 on Linux via `ssh primary uname -a`.

---

## SESSIONS pane accumulates entries across F5 reloads (dev-mode only)

**Expectation.** Reloading the Extension Development Host (F5 / Cmd-R) starts a fresh
extension instance, so previous-reload sessions should disappear from the SESSIONS pane.

**Probe.** F5 the dev host repeatedly while a NONMEM session is active. Observe the
SESSIONS pane lists every prior session as a separate dimmed entry. The same happens for
R 4.5.3 and Python sessions — i.e., it's not specific to positron-nonmem.

**Outcome.** Positron persists session-history entries across extension-host reloads (the
underlying Workspace-location semantics: "restored within the same Positron session").
The dimmed entries are exited sessions that Positron keeps in the picker for restart /
diagnostics purposes. End users won't hit this — only F5'ing-developers will.

**Mitigation:**
- Set `engines.positron` and let Positron clean up across full Positron restarts.
- For dev iteration, occasionally close/reopen Positron itself (not just F5) to clear
  the list.
- Future M-something: add `positronNonmem.clearSessionHistory` command if the noise
  becomes an actual problem (we don't think it will).

## "No session manager found" error during workspace open

**Expectation.** Our LanguageRuntimeManager registers on `onStartupFinished`, so by the
time Positron calls `validateRuntimeSession` on saved sessions our manager is available.

**Probe.** Reload the dev host with a saved session for a `positron-nonmem-*` runtime ID.
Errors appear:

```
ERR Error getting manager for runtime positron-nonmem-primary (...): No session
    manager found for runtime positron-nonmem-primary (...) (2 managers registered).
```

The "(2 managers registered)" reveals only R + Python managers are present at that
moment — ours isn't yet.

**Outcome.** Positron's `restoreWorkspaceSessions` runs during workbench startup,
**before** `onStartupFinished` fires for third-party extensions. Bundled extensions
(R, Python) avoid this because they're loaded eagerly with Positron itself.

**Partial fix.** Add `"*"` to `activationEvents` so positron-nonmem activates at
extension-host startup. This **stops the runaway accumulation of ghost sessions** in the
SESSIONS picker (verified) but **doesn't eliminate the "(2 managers registered)" error
itself** — `restoreWorkspaceSessions` runs in the sub-second window between the
extension host launching and our `activate()` completing. Bundled R / Python avoid this
because they're loaded *eagerly* by Positron itself, before workbench restoration scans.
There's no `activationEvent` earlier than `*` that a third-party extension can use.

**Working theory.** This is structural: third-party `LanguageRuntimeManager` registrants
will always lose the race against the first restoration scan after an extension-host
restart. The error log line is harmless — Positron just discards the un-restorable
session entry and the user starts a fresh one. If Positron ever adds an
`onLanguageRuntime:<id>` activation event or supports manager pre-registration, we'd
adopt it.

(Listed alongside `onStartupFinished` and `onLanguage:nmtran` as belt-and-braces.)

---

## "Error: Session is no longer available" after F5 reload of dev host

**Expectation.** Reloading the Extension Development Host should leave previously-active
sessions either functional or visibly closed.

**Probe.** Start a NONMEM (or R) session, send a command. F5 the dev host. The session
in the SESSIONS picker still appears, but typing in its Console immediately yields
`Error: Session is no longer available`.

**Outcome.** Expected. F5 kills the extension host process. Our `NonmemSession` object
(and its underlying SSH transport) is disposed. R's kernel process likewise dies. The
SESSIONS picker entry survives the reload as a UI artefact, but the underlying process
is gone. Behaviour is identical for R 4.5.3 and Python — not specific to us.

**How to apply.** Just start a fresh session after each F5. End users who never F5 won't
see this; only developers will. If we ever support session reattachment (M3+), we'd
need a Transport implementation that persists a remote helper process across reloads
and reconnects on activate().

---

## scp inherits the SSH banner *and* requires the local parent dir to exist

**Expectation.** scp is a thin wrapper around ssh, so it uses the same auth path —
but its local-write behaviour should be plain POSIX semantics (open(2) on the
destination), and its stderr should be diagnostic-only.

**Probe.** Live test 2026-05-03: `positronNonmem.runModel` against the canonical
minimal probe (`$PROBLEM/$INPUT/$DATA d.csv IGNORE=@/$PRED/.../$ESTIMATION MAXEVAL=0`)
on Windows-host Positron + Linux NONMEM host. Pipeline ran fine through `mkdir -p`,
both putFile uploads, and the remote `nmfe76` invocation. The final `scp <alias>:m.lst
<localDest>` failed with:

```
Host key fingerprint is SHA256:<hash>
+--[ED25519 256]--+
| ... ASCII randomart ... |
+----[SHA256]-----+
scp: open local "c:/.../.positron-nonmem/runs/pn-1777759878535/m.lst": No such file or directory
```

Two findings bundled here:

1. **scp emits the same SSH banner that `ssh` does.** Same root cause as the
   server-banner entry above (sshd `Banner` directive or `/etc/ssh/sshrc`
   sourcing on every login chain). scp's stderr therefore contains both the
   randomart noise *and* any real diagnostic. Our scrubber must keep applying.

2. **scp does NOT auto-create the local destination's parent directory.** Unlike
   `cp -r --parents` or rsync, plain scp calls `open(localPath, O_WRONLY|O_CREAT)`
   and the open fails if the parent directory is missing. `LocalTransport.getFile`
   already did `fs.mkdir(parent, { recursive: true })`; `SshTransport.getFile`
   originally did not. Inconsistency caused this failure.

**How to apply.**

- `SshTransport.getFile` now mkdir's the local parent before invoking scp
  (mirrors LocalTransport.getFile, gives both transports a uniform contract).
- Banner on scp stderr is acceptable noise for now; the scrubber is in place.
  When/if we add live-tail (M3+ in the design plan), tailmux already runs the
  command in a non-login bash that won't source `sshrc`, sidestepping the banner
  for streamed output.

Verified 2026-05-03 against NONMEM 7.6.0 on Linux via the runModel command path.

---

## `extensionHost` launch type doesn't bootstrap Remote-SSH

**Expectation.** A `launch.json` config of `type: extensionHost` whose `args` include
`--remote=ssh-remote+<alias>` and `--folder-uri=vscode-remote://...` would open a
Positron Remote-SSH window with the dev extension loaded against that remote — same
result as manually running `Remote-SSH: Connect to Host`.

**Probe.** Set the args as above, hit "Debug: Start Without Debugging".

**Outcome.** Positron opens a **local** Extension Development Host window. The
`--remote` and `--folder-uri` args are silently ignored (or shadowed by the
`extensionHost` debug type's local-only spawn path). VSCode docs confirm: for
remote-aware extension dev, the orthodox flow is to manually open the Remote-SSH
window first and *then* F5 inside it — and `--extensionDevelopmentPath` must
resolve on the remote, not on the developer's local machine. So a launch config
that combines a Windows `${workspaceFolder}` path with a `--remote` arg can't
work even in principle.

**Implication.** We dropped the Remote-SSH launch config in v0.0.23+. Two
practical loops:

1. **Local dev host** for UI / parser / view work — runtime probe warns
   "could not invoke nmfe76" but every non-runtime feature exercises fine.
2. **VSIX → install on the remote**: `npm run package` → copy `.vsix` to
   the host → "Extensions: Install from VSIX" in a Remote-SSH window. Slow
   loop, but the only end-to-end path until we have a synced-source flow.

Verified 2026-05-03.



---

## Per-method output-file probe (run001..run005)

**Expectation.** From the NM7 `$EST` docs and `em-monte-carlo` reference, each estimation method produces a different subset of files and `.lst` markers. We hand-built five tiny probe models in `empirical-models/run00{1..5}.mod` (FOCE-INTER, ITS, IMP, SAEM-then-IMP-OFV, BAYES-NWPRI) sharing `data/simple-pk.csv`, so the resulting output trees can be diffed directly.

**Probe.** Run on the host:

```bash
scp -r empirical-models primary:~/
ssh primary "cd ~/empirical-models && for f in run001 run002 run003 run004 run005; do execute --nm_version=7.6.0 \$f.mod; done"
mkdir -p empirical-models/outputs
for f in run001 run002 run003 run004 run005; do
  scp -r primary:~/empirical-models/$f.dir/NM_run1 empirical-models/outputs/$f
done
node empirical-models/compare.mjs empirical-models/outputs > empirical-models/outputs/comparison.md
```

`compare.mjs` emits three matrices:

1. **File-presence per run** — which artefacts each method actually wrote.
2. **.lst marker counts per run** — `#METH:`, `#OBJV:`, `#CPUT:`, `#PARA:`, `RESET HESSIAN`, `GRADIENT:`, `Mean Acceptance Rate`, `EBVSHRINKSD(

---

## Signal-file mechanism for live SAEM/IMP control

**Expectation.** nmguides ([running-nonmem](https://nmguides.vrognas.com/nm7/running-nonmem) + [vrognas.com/tools-of-the-trade/nm-tips-n-tricks](https://vrognas.com/docs/tools-of-the-trade/nonmem/nm-tips-n-tricks/)) describe `next.sig` / `stop.sig` / `print.sig` / `paraprint.sig` as empty files in NONMEM's working dir that trigger graceful mode advancement / termination. Docs underspecify: exact filenames, latency, what happens to subsequent `$EST` records, whether `$COV` still runs, cleanup behaviour, location semantics.

**Probe.** `~/positron-nonmem/probe-signals/` on NONMEM 7.6.0 host. SAEM (+IMP EONLY +$COV) on a 4-THETA cubic + diagonal OMEGA(4) + SIGMA model. 5 single-variable probes (`probe.sh` runner polls `run001.ext` line-count, touches signal at trigger): baseline (no sig), S1 (next.sig in burn-in), S2 (stop.sig in accumulation), S3 (stop.sig in burn-in), S4 (next.sig in *parent* dir). S5 cleanup-question answered by cumulative observation.

**Outcome — distinguishing stdout/lst messages.**

| Phase ended via         | `iteration N` line followed by | Final SAEM message                                                       | Reduced-stochastic message                                  |
|------------------------ |------------------------------- |------------------------------------------------------------------------- |------------------------------------------------------------ |
| Natural completion (no CTYPE) | (none — runs to NBURN/NITER)   | `STOCHASTIC PORTION WAS NOT TESTED FOR CONVERGENCE`                       | `REDUCED STOCHASTIC PORTION WAS COMPLETED`                  |
| CTYPE convergence       | `Convergence achieved: ending mode` | `STOCHASTIC PORTION WAS COMPLETED`                                        | `REDUCED STOCHASTIC PORTION WAS COMPLETED`                  |
| `next.sig` (in burn-in) | `Ending Mode`                  | `STOCHASTIC PORTION WAS NOT TESTED FOR CONVERGENCE, AND WAS USER INTERRUPTED` | `REDUCED STOCHASTIC PORTION WAS COMPLETED`                  |
| `stop.sig` (in burn-in) | `Ending Program`               | `STOCHASTIC PORTION WAS NOT TESTED FOR CONVERGENCE, AND WAS USER INTERRUPTED` | `REDUCED STOCHASTIC PORTION WAS NOT COMPLETED PRIOR TO USER INTERRUPT` |
| `stop.sig` (in accumulation) | `Ending Program`               | `STOCHASTIC PORTION WAS COMPLETED`                                        | `REDUCED STOCHASTIC PORTION WAS NOT COMPLETED PRIOR TO USER INTERRUPT` |

The empirical parsing handle is **`USER INTERRUPTED` / `PRIOR TO USER INTERRUPT`** in the SAEM summary lines, paired with `Ending Mode` (next.sig) vs `Ending Program` (stop.sig) in the iteration trace.

**Outcome — semantics.**

- **Filename + location**: lower-case `next.sig` and `stop.sig` literally, in nmfe76's cwd. Parent-directory placement is **silently ignored** (S4: `../next.sig` persisted on disk untouched while burn-in ran to completion).
- **Latency = exactly 1 `$EST PRINT` cycle.** Verified empirically across PRINT=1 / PRINT=10 / PRINT=50 (probes `p1`, `s1`, `p50` in `~/positron-nonmem/probe-signals/`). NONMEM polls its cwd for the signal at each print event:

  | PRINT | Touch iter | `Ending Mode` after | Latency |
  |---|---|---|---|
  | 1 | -198 | -197 | 1 iter |
  | 10 | -160 | -150 | 10 iter |
  | 50 | -350 | -300 | 50 iter |

  **nmguides does NOT document this** (`running-nonmem` page lists the signals but is silent on polling cadence). UI implication: a generic "next PRINT cycle" message is honest; promising "~N iterations" is wrong outside PRINT=N. The wallclock latency depends on per-iter cost — for slow models with PRINT=50, 50 iterations could be many minutes.
- **Cleanup**: NONMEM **deletes the consumed `.sig` file from cwd**. UI does not need to GC it. (Stale `.sig` from a prior run *would* be honoured by the next nmfe76 invocation in the same dir, however — so per-run subdirs are required.)
- **`next.sig` semantics**: ends the *current mode only* (burn-in → accumulation, or last accumulation → next $EST record). Subsequent $EST records and $COV all run normally.
- **`stop.sig` semantics**: ends *all remaining $EST records*, then runs $COV if defined. **Any subsequent $EST is skipped entirely** — this is the load-bearing UX caveat. If a user `stop.sig`s during SAEM, the IMP EONLY refinement step is skipped and the reported OFV is the stochastic SAEM OFV, not the refined one. UI must warn the user before sending stop.sig if a follow-up IMP EONLY is in the model.
- **`stop.sig` during burn-in**: skips remainder of burn-in *and* the entire accumulation phase, producing only the burn-in trace plus `$COV` outputs.

**.cnv structure (bonus finding).** Empirically confirmed in S1 and S2 with `CTYPE=3 CITER=10 CALPHA=0.05`:

```
TABLE NO.     1: Stochastic Approximation ...
 ITERATION    THETA1 ... OMEGA(4,4)   SAEMOBJ
  -2000000000  9.81E-01 ...   <means over last CITER iterations>   -37858.76    <- mean
  -2000000001  5.42E-03 ...   <SDs over last CITER iterations>     107.85       <- SD
  -2000000002  9.20E-01 ...   <slope-vs-zero p-values>             0.24         <- p-value
  -2000000003  5.68E-03 ...   <alpha thresholds, Bonferroni-corr>  5.0E-02      <- alpha
```

Per-parameter alpha is **Bonferroni-corrected** (here ≈ 0.05/8.8 ≈ 0.00568 across the 9 tested parameters); OFV column gets the **uncorrected α=0.05**. Convergence per parameter = `p ≥ α` element-wise. Off-diagonal OMEGAs that are structurally fixed at 0 in the model show p=1.000 (constant slope = 0).

**How to apply.**

- M13-A inspector verdict: parse `.cnv` row `-2000000002` (p-values) and `-2000000003` (alphas). Render `EM: converged (OFV p=0.24 ≥ α=0.05)` green / `NOT converged` red. Use SAEMOBJ column primarily; per-parameter detail on hover.
- M13-D signal-button UX: write the empty file via SFTP to nmfe76's cwd (= the per-run subdir under `~/positron-nonmem/<runId>/` per CLAUDE.md execution discipline). Two buttons: "End current mode" (next.sig) and "Stop run cleanly" (stop.sig). The latter must show a confirm dialog warning that *all subsequent $EST records will be skipped* if the model has more than one $EST.
- M13-E `.lst` post-mortem: parse `WAS USER INTERRUPTED` / `PRIOR TO USER INTERRUPT` → display "Run ended via user signal" badge in the inspector; differentiate from CTYPE-convergence (`WAS COMPLETED`).

Verified 2026-05-08 against NONMEM 7.6.0 on Linux via probes `~/positron-nonmem/probe-signals/{baseline,s1,s2,s3,s4}`.

---

## `$EST` option defaults per method — wire-format coverage limits

**Expectation.** The XML's `<nm:estimation_options nm:knob='value' .../>` is the
canonical structured surface for `$EST` configuration. We wanted "what does NONMEM
use if I write nothing?" per method, to power the inspector's
non-default highlighting (`xml-est-defaults.ts`).

**Probe set.** `~/positron-nonmem/probe-defaults/{zero,foce,foce_inter,hybrid,its,imp,imp_eonly,impmap,direct,saem}/run001.xml`
— minimal model with `$EST METHOD=X` plus the smallest extra options NONMEM accepts (e.g.
SAEM rejects without `NBURN`/`NITER`/`ISAMPLE`, so those values land in the dictionary
but get classified as user-driven via `USER_DRIVEN_KEYS`).

Plus follow-up probes with `CTYPE=3` set to capture conditionally-emitted attrs:
`~/positron-nonmem/probe-defaults/{saem,its,imp,impmap,direct}_ctype/run001.xml`.

**Outcomes.**

1. **Stable skeleton, conditional children.** Most attrs appear in every method with
   identical values (`analysis_type='pop'`, `nsig='3'`, `format='s1pe12.5'`, etc.).
   Method-specific attrs (`isample_m1*` / `ikappa` / `massreset` for SAEM only;
   `iaccept` / `iscale_*` / `mapiter*` for IMP / IMPMAP) appear only when their
   parent method emits them.

2. **`estimation_method` attr is method-only.** Classical methods (FOCE / FO /
   HYBRID / LAPLACE) emit no `estimation_method` attr at all — they're
   distinguishable only by `cond_estim` / `epseta_interaction` / `laplace` /
   `etas_fixed_to_zero`. Our matcher routes by `estimation_method` value when
   present, falls back to attr-presence inspection for classical methods.

3. **CTYPE-conditional emit family.** `calpha` / `citer` / `cinterval` only emit
   when `CTYPE>0`. Captured defaults: `calpha='5.000000000000000E-02'`,
   `citer='10'`, `cinterval` follows `PRINT` (defaults to `9999`).

4. **Option-dependent defaults.** `cinterval` defaults to whatever `PRINT` is set
   to. User dialing `PRINT=10` cascades to `cinterval=10` without typing it. Static
   baseline can't model — moved `cinterval` to `USER_DRIVEN_KEYS` (green tier)
   instead of comparing to a stale baseline.

5. **Options that never emit to XML.** `PRINT`, `NOSUB`, `OMITTED`, `NOABORT` /
   `ABORT` family, `NOCENTERING` / `CENTERING` etc. NM applies them but the XML
   wire-format doesn't surface them. **Fundamental limitation**: our diff system
   can't track user customization of these. No fix possible without a different
   data source (FCON intermediate or .lst-text parsing).

6. **IMPMAP / MAPINTER doc-vs-emit discrepancy.** [em-monte-carlo](https://nmguides.vrognas.com/nm7/em-monte-carlo)
   claims `IMPMAP ≡ IMP INTERACTION MAPITER=1 MAPINTER=1`, yet default
   `METHOD=IMPMAP` emits `mapinter='0'` in both XML and `.lst`. Resolved by
   binary-symbol-table inspection (`strings`/`nm` only — no disassembly): the
   `__nmbayes_int_MOD_*` namespace contains parallel `mapiter`/`mapinter`/`mapiters`
   (user-set) and `emapiter`/`emapinter`/`emapinterstart` (effective/internal)
   variables, plus a runtime string `"Mapinter turned on"`. NM dispatches on the
   `estimation_method` label and unconditionally sets `emapinter=1` for IMPMAP
   regardless of `mapinter='0'`. The surface XML attr keeps the user-set side
   only; the algorithmic effect matches the doc claim. **Don't "fix"** the
   IMPMAP baseline by setting `mapinter: '1'` — that would mis-flag default
   `METHOD=IMPMAP` runs as customised.

7. **Methods deferred.** BAYES / NUTS / CHAIN / SIR / MCMC not probed (BAYES
   needs `$PRIOR` plumbing; CHAIN is initial-value generator with different XML
   shape; SIR runs as post-processing). `findDefaultsForStep` returns `null` for
   these — the diff degrades gracefully (no false-positive blue, just no
   highlighting).

**How to apply.**

- `runtime/xml-est-defaults.ts` carries the per-method baselines + `USER_DRIVEN_KEYS` +
  `findNonDefaultKeys(step)` / `findUserDrivenKeys(step)` helpers. Inspector renders
  non-default attrs blue, user-driven attrs green.
- nmguides commit [`5aeb349`](https://github.com/vrognas/nmguides/commit/5aeb349) documents the
  per-method tables in `supplements/nonmem-tips.qmd` (the doc-facing version of this
  empirical-notes entry).
- Re-probe when host upgrades to NM 7.7+; defaults can shift silently between patches.
  Symptom of drift: false-positive blue on attrs whose true defaults moved.

Verified 2026-05-09 against NONMEM 7.6.0 on Linux via the probes above.
---


## `$COVARIANCE` options — `<nm:problem_options>` carries `cov_*`, no dedicated `<nm:covariance_options>`

**Expectation.** `$EST` options live in `<nm:estimation_options/>` per chained step. By
analogy, `$COV` options should live in a `<nm:covariance_options/>` element. Bauer's
NM7 docs don't explicitly say either way.

**Probe.** Set up 7 minimal-model probes at `~/positron-nonmem/probe-cov-*/` on the
NM 7.6.0 host: `bare`, `matrix_r`, `matrix_s`, `print_e`, `sir`, `uncond`, `no_cov`,
`cov_em`. Ran in parallel via `nmfe76`. Grepped resulting `m.xml` / `run001.xml` for
all `<nm:[a-z_]+>` tags + scanned the `<nm:problem_options/>` element's attrs.

**Outcome.**

1. **No `<nm:covariance_options>` element exists.** Confirmed across all 7 probes — the
   tag-list is identical to bare-`$EST` runs minus `<nm:covariance_step>` etc. NM does
   NOT emit a dedicated $COV-options element.
2. **`<nm:problem_options/>` carries `cov_*` prefixed attrs** alongside `data_*`,
   `nthetat`, `omega_diagdim`, etc. Self-closing element, one per problem (single
   $COV per problem in NONMEM by design — no chaining).
3. **`cov_*` attrs are entirely absent** when no `$COV` record at all (`no_cov` probe).
   Distinct from `cov_omitted='yes'` which signals explicit `$COV OMITTED` was written.
   Use `<nm:problem_options>` carrying any `cov_*` attr as the "has $COV" signal.
4. **Bare-`$COV` baseline (NM 7.6.0).** 22 attrs always emitted, regardless of method:
   ```
   atol='-1' cholroff='0' compressed='no' eigen_print='no' fposdef='0'
   knuthsumoff='-1' matrix='rsr' nofcov='no' omitted='no' pfcond='0'
   posdef='-1' precond='0' preconds='tos' pretype='0' resume='no'
   siglcov='-1' siglocov='-1' sirsample='BLANK' slow_gradient='noslow'
   special='no' thbnd='1' tol='-1'
   ```
   - `cov_thbnd='1'` resolves the doc contradiction. Bauer's `$COVARIANCE` reference
     has two paragraphs giving different defaults: one says "By default THBND=1, in
     keeping with the behavior of earlier NONMEM versions" and another (under
     SIRTHBND) says "Default is the value of THBND, which in turn is 0 by default."
     Empirical: THBND=1 is the actual emitted default for the deterministic step.
5. **`-1` is the propagation sentinel** for keys that inherit from `$EST` / `$SUBS`.
   Empirically these are: `atol`, `tol`, `siglcov`, `siglocov`, `knuthsumoff`,
   `posdef`. The inspector renders these as a fourth tier (yellow / propagated)
   distinct from blue (non-default), green (user-driven), and normal (default) —
   "the actual effective value isn't here, look at $EST" is an important user signal.
6. **`'BLANK'` is the not-requested sentinel** (e.g. `sirsample='BLANK'` = no SIR
   active). Different semantics from `-1`: `BLANK` is the actual default, not a
   propagation pointer.
7. **SIR-block attrs only emit when `SIRSAMPLE>0`.** 14 additional attrs appear in the
   `sir` probe (`capcorr`, `clockseed`, `df`, `file`, `format`, `iaccept`, `iacceptl`,
   `print`, `ranmethod`, `seed`, `sircenter`, `sirmaxwt`, `sirminwt`, `sirniter`,
   `sirthbnd`). These compose `SIR_BLOCK` in `xml-cov-defaults.ts`, layered on top
   of the bare baseline only when SIR is active.
8. **`MATRIX=R` suppresses `cov_atol`, `cov_cholroff`, `cov_special`** from XML
   emission. Defensive: missing attrs in input never false-flag as non-default
   (the diff only checks `defaults[k] !== opts[k]` for keys present in `opts`).
9. **EM methods do not change the bare baseline.** `cov_em` probe (with `METHOD=IMP`)
   produced identical 22-attr `cov_*` set as the bare-FOCE probe. The `posdef='-1'`
   propagation handles the method-dependent default (0 for classical, 3 for EM)
   internally — XML doesn't differentiate.

**How to apply.**

- `runtime/parse-xml-problem-options.ts` extracts `cov_*` attrs from the
  `<nm:problem_options/>` element. Returns `null` when no `cov_*` attrs (no $COV
  record) — distinct from `omitted='yes'` (explicit OMITTED).
- `runtime/xml-cov-defaults.ts` carries `BARE_COV` + `SIR_BLOCK` + `PROPAGATED_KEYS` +
  `USER_DRIVEN_KEYS` + the three classifier helpers
  (`findCovNonDefaultKeys` / `findCovPropagatedKeys` / `findCovUserDrivenKeys`).
- Re-probe when host upgrades to NM 7.7+; new attrs ship silently between patches.
  Symptom of drift: false-positive blue on attrs whose true defaults moved or were
  added without baseline updates.

Verified 2026-05-09 against NONMEM 7.6.0 on Linux via the probes above.

## `$COV` option propagation from `$EST` is real (NM 7.6.0)

**Expectation.** Per Bauer's `$COVARIANCE ATOL=n` doc: "If ATOL is coded on $ESTIMATION,
it overrides the default for that step. If ATOL is coded on $COVARIANCE, it overrides
$ESTIMATION and/or the default for that step." So `cov_atol='-1'` (user didn't set on
$COV) should mean the effective $COV ATOL = whatever $EST set.

But: like IMPMAP/MAPINTER (where XML `mapinter='0'` is a user-input sentinel and the
binary unconditionally sets the internal `emapinter=1`), the XML's `cov_atol='-1'`
might be a UI-only marker that NONMEM resolves to its own internal default (12) without
consulting $EST. We had to probe.

**Probe.** `~/positron-nonmem/probe-cov-propagation/run001.mod` — `$SUBROUTINES ADVAN13
TOL=6`, `$ESTIMATION ... ATOL=10`, bare `$COVARIANCE` (no ATOL). The .lst's tolerance
trace lines reveal the resolved per-step values:

```
INITIAL (BASE) TOLERANCE SETTINGS:
 NRD (RELATIVE)  VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  12   ← built-in default

TOLERANCES FOR ESTIMATION/EVALUATION STEP:
 NRD (RELATIVE)  VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  10   ← user's $EST ATOL=10

TOLERANCES FOR COVARIANCE STEP:
 NRD (RELATIVE)  VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  10   ← inherits from $EST!
```

XML side: `nm:atol='10'` on the `<nm:estimation_options/>`, `nm:cov_atol='-1'` on
`<nm:problem_options/>`.

**Outcome.** Propagation is **real** — the binary actually uses $EST's value for $COV
when `cov_atol='-1'`. This validates the v0.0.177 propagated-tier semantic:

- Yellow flag fires only when `cov_*='-1'` AND the $EST sibling is itself non-default.
  Justified — there is a real user-customised value being inherited that the user can
  go look at.
- Yellow flag does NOT fire when $EST is also at default. Correct — the effective $COV
  value is just the built-in default, not a propagated user choice.

**Subtle empirical**: NM emits `nm:atol='0'` on `<nm:estimation_options/>` for the
bare-$EST default. The actual base ANRD is 12 (per the BASE TOLERANCE SETTINGS line).
So `atol='0'` is itself a "user didn't set" sentinel at the $EST level, distinct from
"user wrote ATOL=0". Visually the inspector treats it as default; semantically it
means the built-in 12 is in effect. This matters only if a user really did write
`ATOL=0` on $EST — they'd see no highlight in the inspector even though they
customised. We'd need to read the .lst BASE/EST trace to disambiguate, which we don't
do today. Logging as a known limitation.

**How to apply.**

- `runtime/xml-cov-defaults.ts` cross-references the LAST `$EST` step's `findNonDefaultKeys`
  to gate the propagated tier.
- `tol`/`posdef` excluded from PROPAGATION_SOURCES (different inheritance chains —
  $SUBROUTINES-direct and method-determined respectively).
- Re-probe when host upgrades to NM 7.7+; inheritance behavior could shift.

Verified 2026-05-09 against NONMEM 7.6.0 on Linux via the probe above.

### Binary-symbol-table corroboration (NONMEM 7.6.0)

**Probe.** `nm /opt/nm760/run/nonmem | grep cmnm1_int_MOD_` to enumerate the
`cmnm1_int` Fortran module's variables.

**Outcome.** Paired `$EST`/`$COV` variables exist as separate Fortran storage:

```
__cmnm1_int_MOD_sigl       __cmnm1_int_MOD_siglcov
__cmnm1_int_MOD_siglo      __cmnm1_int_MOD_siglocov
__cmnm1_int_MOD_tol        __cmnm1_int_MOD_tolcov
__cmnm1_int_MOD_atol       __cmnm1_int_MOD_atolcov
```

The binary stores estimation-step and covariance-step tolerance/precision values
separately. The XML emits the user-input layer (`cov_atol='-1'` = "user didn't set on
$COV") and the binary internally computes `atolcov := atol` (i.e. inherits) when
`cov_atol` was not user-set. Same pattern as IMPMAP's `mapinter`/`emapinter` split
documented in the $EST defaults section above.

**Implication for our tiering.** Yellow propagated correctly captures "the runtime
$COV value comes from $EST" — when the user reads the inspector, they need to look
at $EST's value to know the effective $COV setting. The .lst trace
(`TOLERANCES FOR COVARIANCE STEP: ANRD: 10`) confirms this is what's actually
applied at runtime.

## $EST option propagation across chained steps (NM 7.6.0)

**Expectation.** Per Bauer's $EST doc: "Options specified in an $ESTIMATION record will
carry over to the next $ESTIMATION record unless a new option is specified." Per
`nm7/em-monte-carlo.qmd:1829`: "when using AUTO=1, the transfer of any options settings
explicitly set by the user from previous $EST statements may or may not occur for those
options set by the AUTO option, depending on the situation." Need to nail down exactly
what propagates.

**Probe.** `~/positron-nonmem/probe-chains-v2/` on the host. Six 2-step chains varying
whether step 1 sets options explicitly vs via AUTO=1, and whether step 2 cancels AUTO
or not. Inspect each step's `<nm:estimation_options>` block.

**Outcome.**

1. **Explicit options DO propagate** to the next step. SAEM with `CTYPE=3` → IMP (no
   CTYPE) yields IMP step with `ctype=3`.
2. **Explicit options survive AUTO cancellation** in next step. SAEM `CTYPE=3` → IMP
   `AUTO=0` still emits `ctype=3` for IMP.
3. **The AUTO setting itself propagates**. SAEM `AUTO=1` → IMP (no AUTO) yields IMP step
   with `auto=1` inherited.
4. **When inherited AUTO=1 re-fires in next step, it re-applies for that step's method**.
   So step 2's `ctype=3` may be from AUTO=1 re-applying (not propagation per se).
5. **AUTO-implicit values reset to bare-method defaults when AUTO is canceled in next
   step**. The smoking gun: SAEM `AUTO=1` (which implicitly sets `ctype=3, noprior=1`)
   → IMP `AUTO=0` yields `ctype=0, noprior=0` for IMP. AUTO-implicit values do NOT
   propagate as values; only the AUTO setting itself does.

**Implication for the inspector tier classifier.** Looking at step N's XML alone, we
cannot distinguish:
   - (a) value set explicitly on step N
   - (b) value propagated from step N-1's explicit setting
   - (c) value set implicitly by AUTO=N on step N
   - (d) value set implicitly by AUTO=N on step N-1 (via AUTO-setting propagation +
         re-application)

Disambiguating (a) from (b)/(c)/(d) requires parsing the `.lst $ESTIMATION` echo
(proposal B in the inspector design — pending). Without it, the blue tier's
"non-default" label is accurate but loses the "you-typed-it-here" vs
"propagated-or-AUTO-set" nuance.

**Practical workflow caveat.** Modelers should be aware: in `SAEM → IMP EONLY` chains,
explicit options on SAEM (e.g. INTERACTION, NOPRIOR=1) carry over to the IMP EONLY
step. AUTO=1's implicit settings (NITER=1000, NBURN=4000, etc.) do NOT carry as values,
but if AUTO=1 is left on for the IMP step, AUTO=1's IMP-specific overrides apply
(NITER=500, ISAMPLE=300, etc.). Cancel with `AUTO=0` on the IMP step to get bare-IMP
behavior + only the explicit options that were carried over.

### Exhaustive matrix verification (NM 7.6.0)

Second probe round at `~/positron-nonmem/probe-chains-exhaustive/` (18 probes across
seven layers, varying option type, AUTO state, method transition, chain depth).

**Layer 1 — explicit propagation across many attrs.** SAEM(option=X) → IMP(no option)
with AUTO=0 in step 2. All tested attrs propagated step 1 → step 2:
`ctype=3`, `iaccept=0.5`, `mceta=5`, `noprior=1`, `seed=42`, `calpha=0.01`,
`citer=5`, `constrain=2`. Rule confirmed across ~8 different option types.

**Layer 2 — AUTO=1 cancellation behavior.** Three sub-probes:

- `L2_auto1_to_auto0`: SAEM AUTO=1 → IMP AUTO=0 — step 2 has `auto=0 ctype=0
  noprior=0` (AUTO-implicit values FROM step 1 reset).
- `L2_auto1_inherit`: SAEM AUTO=1 → IMP (no AUTO) — step 2 has `auto=1` inherited
  AND the IMP-method AUTO=1 override-set re-fires (`mceta=3`, `iaccept=0.0`,
  `cinterval=1`).
- `L2_auto1_explicit`: explicitly written AUTO=1 in step 2 produces same result as
  inheriting it.

**Layer 3 — AUTO=2 propagation.** `L3_auto2_imp_to_auto0_saem`: IMP AUTO=2 (sets
`ctype=3 noprior=1 mceta=3 iaccept=0`) → SAEM AUTO=0 — all those values reset to
bare-SAEM defaults (`ctype=0 noprior=0 mceta=0 iaccept=0.4`). Same rule as AUTO=1.

**Layer 4 — three-step chain.** `L4_three_step_cancel_then_check`: SAEM AUTO=1 → IMP
AUTO=0 → IMP (no AUTO). Step 3 has `auto=0 ctype=0 noprior=0` — once AUTO is
canceled, cancellation propagates forward.

**Layer 5 — explicit override of AUTO-set value.**
- `L5_auto1_explicit_override_ctype`: SAEM AUTO=1 CTYPE=1 (overrides AUTO's
  CTYPE=3) → IMP AUTO=0. Step 2 has `ctype=1` (the user's explicit, NOT 3 from
  AUTO, NOT 0 from bare default). NM tracks "user-explicit vs AUTO-implicit"
  internally and propagates only the explicit.
- `L5_auto1_explicit_override_noprior`: same story for NOPRIOR=0.

**Layer 6 — cross-method-class propagation.**
- `L6_foce_explicit_to_imp`: FOCE NOPRIOR=1 → IMP AUTO=0 — step 2 has noprior=1.
- `L6_foce_explicit_to_saem`: FOCE CTYPE=3 → SAEM AUTO=0 — step 2 has ctype=3.

**Layer 7 — same-method propagation.** `L7_saem_to_saem`: SAEM CTYPE=3 → SAEM (no
CTYPE) — step 2 has ctype=3.

**Final consolidated rule set.**

1. **Explicit values propagate** (verified across ~8 attrs and 3 method-class transitions).
2. **AUTO setting itself propagates** forward through the chain.
3. **AUTO=N re-fires for each step's method** when active.
4. **AUTO-implicit values RESET to bare-method defaults** when AUTO is canceled in
   next step. Verified for both AUTO=1 and AUTO=2.
5. **Once cancelled, AUTO=0 propagates forward** — subsequent steps stay at bare
   defaults.
6. **Explicit user overrides of AUTO-set values are tracked separately** — they
   propagate as explicit values even when AUTO is canceled. NM internally
   distinguishes "user typed it" from "AUTO chose it".

Verified 2026-05-10 against NONMEM 7.6.0 on Linux via probes at
`~/positron-nonmem/probe-chains-v2/` (auto1_then_auto0 is the canonical case)
and `~/positron-nonmem/probe-chains-exhaustive/` (18-probe matrix).

## `$COV` quirks — MATRIX=R suppresses SPECIAL only (NM 7.6.0)

**Expectation.** Bauer's `$COVARIANCE ATOL` doc says "ATOL is changed for the $COV
step only if SIGL and/or SIGLO are also specified at the $COV record." So
`$COV ATOL=5` without SIGL/SIGLO should leave ANRD at the default (12).
Separately Bauer's `MATRIX=R` doc warns "MATRIX=R should not be used with option
SPECIAL" without saying what NM does when both are present.

**Probes.** `~/positron-nonmem/probe-cov-quirks/` (4 probes) and
`~/positron-nonmem/probe-matrix-r-atol/` (1 probe). Each combines $COV options
that the docs flag as interaction-sensitive and inspects (a) the resulting
`cov_*` XML attrs and (b) the `.lst` "TOLERANCES FOR COVARIANCE STEP" block.

**Outcomes.**

1. **`$COV ATOL=5` alone (no SIGL/SIGLO) DOES take effect.** Probe `atol_alone`:
   XML emits `cov_atol='5'` AND `.lst` shows `ANRD=5`. The doc claim is wrong (or
   outdated). No quirk to flag; ATOL works as written regardless of SIGL/SIGLO.
2. **`$COV MATRIX=R` suppresses `cov_special` from XML** (only). Probe `matrix_r`:
   `cov_special` is absent from the XML attr set. The other attrs (`cov_atol`,
   `cov_cholroff`, `cov_siglcov`, `cov_siglocov`, etc.) are still emitted.
3. **`$COV MATRIX=R + ATOL=5 + CHOLROFF=1`** still emits `cov_atol='5'` AND
   `cov_cholroff='1'`, AND the `.lst` trace confirms `ANRD=5`. So ATOL/CHOLROFF
   take effect even with MATRIX=R.
4. **`$COV MATRIX=R + SPECIAL`** silently ignores SPECIAL. NM doesn't raise an
   error or warn; `cov_special` is simply absent from XML, and the runtime
   behaves as if SPECIAL weren't typed.

**Implication for the Fit Inspector.**

- ATOL "only with SIGL" rule isn't really a rule. No tooltip / quirk annotation
  needed.
- `cov_special` synthesis (v0.0.186+): added to the invisible-options overlay
  in `client.js`. When the `.lst` $COV echo shows the user typed SPECIAL but
  MATRIX=R suppressed cov_special, the synthesized row flags the user's intent
  + appends a tooltip warning: "NM silently ignores SPECIAL when MATRIX=R is
  used."

Verified 2026-05-11 against NONMEM 7.6.0 on Linux via the probes above.

## POSTHOC/NOPOSTHOC effect across $EST methods (NM 7.6.0)

**Expectation.** Bauer's $EST POSTHOC doc (line 3082): "This option may be used when
the FO method is used." And NOPOSTHOC (line 3088): "Etas are not estimated. This is
the default with METHOD=0. May not be used with METHOD=1." So:
- FO: NOPOSTHOC default; POSTHOC opt-in
- METHOD=1 (FOCE): NOPOSTHOC rejected; posthoc is implicit

**Probe.** 16-probe matrix at `~/positron-nonmem/probe-posthoc/` — for each method
(FO, FOCE, FOCEI, Laplace, IMP, ITS, SAEM, MAXEVAL=0), a bare run and a POSTHOC-explicit
run. Plus separate `~/positron-nonmem/probe-noposthoc/` testing NOPOSTHOC with FOCE /
IMP / SAEM (Bauer says these should be rejected).

**Outcomes.**

1. **All methods generate `.phi` regardless of POSTHOC/NOPOSTHOC**. Including FO bare
   (file size 150168 bytes, content all-zero etas for the trivial model).
2. **POSTHOC + bare have BYTE-IDENTICAL `.phi`** across every method probed. .ext final
   estimates also identical. The numerical output doesn't change.
3. **NM accepts NOPOSTHOC for FOCE / IMP / SAEM** without error (Bauer claims "May not
   be used with METHOD=1" — empirically false at 7.6.0). The .phi is still generated.
4. **`.lst` echoes "POP. ETAS OBTAINED POST HOC: YES"** when POSTHOC is explicit — so
   NM recognises the option, just doesn't change behavior.

**Implication.** POSTHOC/NOPOSTHOC are **silently ignored for non-FO methods** at
NM 7.6.0 — posthoc eta computation is always implicit for FOCE/Laplace/EM. For FO they
ARE meaningful (toggle posthoc on/off), though for trivial models the eta values may
all converge to zero either way.

**How to apply.** The Fit Inspector's `INVISIBLE_ATTR_DEFS.posthoc.applicable = 'fo'`
(v0.0.187+) is correct. WARNING tooltip wording updated v0.0.189: when user types
POSTHOC on non-FO, the inspector annotates "POSTHOC/NOPOSTHOC only meaningfully apply
to METHOD=ZERO (FO). Other methods compute posthoc etas implicitly regardless of the
option."

Verified 2026-05-11 against NONMEM 7.6.0 on Linux via the probes above.

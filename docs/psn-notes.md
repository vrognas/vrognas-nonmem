# PsN notes — positron-nonmem

Reference for the PsN toolbelt that backs positron-nonmem's commands.
Mirrors `docs/empirical-notes.md`: each claim is tagged **DOC** (from the v5.3.1
userguide / source) or **PROBE-NEEDED** (still to be verified on primary).

PsN is a toolbelt of ~30 CLI tools, not a single command. We integrate them
incrementally; for now this doc is execute-deep, sumo/update_inits/vpc as
stubs, the rest as a TOC.

## Scope: which PsN tools we wire up

| Milestone | Tool(s) | Surfaces as |
|---|---|---|
| M2 | `execute` | `positronNonmem.runModel` command |
| M3 | `sumo` | Hover / status-bar / tree-tooltip showing OFV, condition number, termination message for any `.lst` |
| M3 | `update_inits` | Right-click a run → "Promote estimates to new .mod" |
| M4+ | `vpc` / `npc` | "Run VPC" command; output to Positron Plot pane |
| M5+ | `bootstrap` / `sir` | "Bootstrap CI" workflow; results back into Variables/Data Explorer |
| M6+ | `runrecord` | Backs the Runs tree's columns (replaces our hand-rolled discovery) |
| Out of scope ≤M5 | `scm`, `scmplus`, `linearize`, `transform`, `qa`, `frem`, `simeval`, `cdd`, `sse`, `lasso`, `mimp`, `mcmp`, `gls`, `precond`, `nca`, `nmoutput2so` | Future commands; capture per-tool stubs in this doc as we get to them |

Rule of thumb: **never reimplement a workflow PsN already provides.** If we
catch ourselves writing logic to summarize a `.lst`, parse a `.ext`, or
update initial estimates from a `.lst` — stop and shell out to the matching
PsN tool instead.

---

## execute

Reference for `execute` as the runner backing `positronNonmem.runModel`.

> Verified empirically 2026-05-03 against PsN 5.3.1 + NONMEM 7.6.0 on primary.

## Version pinning

The host (primary) runs **PsN 5.3.1**. The latest PsN is 5.7.x; 5.4+ added
features (e.g. `$PSNCONFPATH` env override) that we **cannot rely on**. All
references below are pinned to v5.3.1 unless explicitly noted.

Authoritative sources (download once, treat as read-only):

- `bin/execute` Perl source @ v5.3.1:
  https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/bin/execute
- `lib/PsN.pm` (nm_version resolution) @ v5.3.1:
  https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/lib/PsN.pm
- `lib/common_options.pm` (shared CLI flags) @ v5.3.1:
  https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/lib/common_options.pm
- `lib/tool/modelfit.pm` (the workhorse `execute` delegates to) @ v5.3.1:
  https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/lib/tool/modelfit.pm
- v5.3.1 release assets (PDF userguides):
  https://github.com/UUPharmacometrics/PsN/releases/tag/v5.3.1
  - Most relevant: `execute_userguide.pdf`, `common_options.pdf`,
    `psn_configuration.pdf`, `known_bugs_and_workarounds.pdf`.

WebFetch can't parse PDFs; the inline help in `bin/execute` is the same
content as `execute_userguide.pdf` and is grep-able in plain text. Use that
unless you need a screenshot for a doc/PR.

---

## Invocation

**VERIFIED.** Each PsN tool is a standalone binary (`/usr/local/bin/execute`,
`/usr/local/bin/sumo`, `/usr/local/bin/update_inits`, …). Invocation:

```
execute run001.mod
```

⚠ **NOT** `psn execute run001.mod` — `psn` is a separate tool (purpose:
likely metadata / install info; symlink target `psn-5.3.1`). Running
`psn execute run001.mod` exits 0 silently and does **nothing** — no error,
no output, no filesystem effect. Easy footgun. Confirmed empirically.

Multi-model + retries (DOC, not yet probed):

```
execute -threads=2 -retries=5 phenobarbital.mod pheno_alternate.mod
```

A model file is **required**; `bin/execute` croaks with
`At least one model file must be specified` if not passed.

---

## Output directory layout

**DOC** (`bin/execute` Description, verbatim):

> The execute program creates subdirectories where it puts NONMEMs input and
> output files, to make sure that parallel NONMEM runs do not interfere with
> each other. The top directory is by default named 'modelfit_dirX' where 'X'
> is a number that starts at 1 and is increased by one each time you run the
> execute program. When the NONMEM runs are finished, the output and table
> files will be copied to the directory where execute started in which means
> that you can normaly ignore the 'modelfit_dirX' directory. Inside the
> 'modelfit_dirX' you find a few subdirectories named 'NM_runY'. For each
> model file you specified on the command line there will be one 'NM_runY'
> directory in which the actual NONMEM execution takes place.

**VERIFIED.** Vanilla `execute run001.mod` in CWD `~/work/` produces:

```
~/work/
├── run001.mod                 ← unchanged
├── run001.lst                 ← copied back, renamed from psn.lst
├── d.csv                      ← unchanged (data file)
└── modelfit_dir1/             ← X auto-increments
    ├── audit_trails_log.txt
    ├── command.txt            ← exact CLI invocation
    ├── meta.yaml              ← run metadata (config snapshot)
    ├── model_NMrun_translation.txt   ← maps "run001.mod" ↔ "NM_run1"
    ├── version_and_option_info.txt
    └── NM_run1/
        ├── psn.mod            ← rewritten copy of model with local data path
        ├── psn.lst            ← raw NONMEM stdout/output (renamed when copied)
        ├── psn.ext .phi .cov .cor .coi  ← stay here unless -nm_output set
        ├── FCON / FDATA / FSUBS.f90     ← NONMEM internals
        ├── FILE07 .. FILE31             ← NONMEM internals (DDE, condor adapters, etc.)
        ├── d.csv              ← copied dataset (default -copy_data)
        └── psn_nonmem_error_messages.txt
```

⚠ **Only `model.lst` is copied back to CWD by default.** `.ext`, `.phi`,
`.cov`, `.cor`, `.coi` stay inside `modelfit_dir1/NM_run1/psn.<ext>`.

**With `-nm_output=ext,phi,cov,cor,coi`:** PsN moves the listed extensions
into `modelfit_dir1/` (the parent of `NM_run1/`, **not** CWD), renames them
from `psn.<ext>` → `model.<ext>`, and **archives `NM_run1/` into
`NM_run1.7z`** (a 7-zip — readable but needs a 7z/p7zip tool to extract).
Verified: `model.lst` still appears in CWD; `model.ext`, `model.phi` end
up in `modelfit_dir1/`.

This means: to access `.ext` / `.phi` / `.cov` programmatically, the
extension should look in **`modelfit_dir1/`** (post `-nm_output`) or
**`modelfit_dir1/NM_run1/psn.<ext>`** (default, no `-nm_output`).
Reading inside the `.7z` is impractical — always pass `-nm_output`.

Naming knobs (DOC, all in `bin/execute` help):

- `-directory=<path>` — explicit run dir (overrides auto-naming).
- `-model_dir_name` — basename `<modelfile>.dir` instead of `modelfit_dir`.
- `-timestamp` — basename `<modelfile>-PsN-<YYYY-MM-DD-HHMMSS>`.
- `-model_subdir` — wraps the run dir inside a `<model>/` subdir.

---

## Exit codes

**VERIFIED 2026-05-03.**

| Scenario | RC | Console |
|---|---|---|
| Vanilla success (NMtran ok, NONMEM converged) | 0 | full PsN narrative + "execute done" |
| Convergence-failed NONMEM (R MATRIX SINGULAR etc.) | 0 (assumed; not probed yet) | NONMEM termination message in `.lst` |
| **NMtran failed** (e.g. `GARBAGE_KEYWORD`) | **0** | "AN ERROR WAS FOUND IN THE CONTROL STATEMENTS" + "NMtran failed. There is no output for model 1." + "Not restarting this model." + still prints "execute done"! |
| `-nm_version=<bad-label>` | **2** | `No NONMEM version with name "<label>" defined in psn.conf. Format should be: name=directory,version at /usr/local/share/perl/5.38.2/PsN_5_3_1/common_options.pm line 216.` |
| Missing model file argument | (not probed; PsN croaks) | `At least one model file must be specified.` |

**Critical implication for our error path.** RC=0 does **not** mean
"the run produced a usable .lst". NMtran failures still exit 0. We must:

1. Check whether `<model>.lst` exists in CWD after `execute` returns.
2. If it doesn't exist, parse the run log for `NMtran failed.` /
   `Not restarting this model.` to surface the NMtran error to the user.
3. If it does exist, parse the lst for the NONMEM termination message
   (TERMINATED BY OBJ, etc.) to detect convergence failures.

What we parse for run-status:

1. `<model>.lst` in CWD — primary, NONMEM termination + OFV.
2. `modelfit_dir1/NM_run1/psn_nonmem_error_messages.txt` — PsN's collected
   NONMEM/NMtran errors.
3. `modelfit_dir1/meta.yaml` — config snapshot.
4. `modelfit_dir1/raw_results_<model>.csv` — present when `-nm_output`
   used; structured per-run summary (PROBE: confirm column set).

We do **not** rely on `execute`'s exit code for run-success detection.

---

## NONMEM binary resolution via `psn.conf`

**DOC** (`lib/PsN.pm` v5.3.1, `set_nonmem_info` + `get_nmversion_info`):

PsN does **not** take an nmfe path on the CLI. It resolves a label via
`psn.conf` `[nm_versions]`:

```ini
[nm_versions]
default=/opt/nm760/run,7.6.0
nm760=/opt/nm760/run,7.6.0
nm751=/opt/nm751/run,7.5.1
nm743=/opt/nm743/run,7.4.3
```

Format: `name=directory,version`. The directory is the NONMEM install root
(the parent of `run/`); PsN locates `nmfe<NN>` itself based on `version`.

**Special case** — if `directory` has no slashes, PsN runs `which`/`where` to
resolve it on `$PATH` (`find_nmfe_from_system_path` in `PsN.pm`). So you can
write `default=nmfe76,7.6.0` if `nmfe76` is on `$PATH`.

**psn.conf lookup** (v5.3.1, simpler than 5.4+):

1. `~/psn.conf` (if exists)
2. `<PsN-install>/lib/psn.conf` (the bundled default)

5.3.1 does **NOT** honour `$PSNCONFPATH` (added in 5.4) and does **NOT**
check `~/Desktop/psn.conf`.

CLI override: `-nm_version=<label>`. With no flag, PsN uses the `default`
label from `[nm_versions]`.

---

## Key options for our extension

From `lib/common_options.pm` v5.3.1:

| Flag | What it does | When we'd use it |
|---|---|---|
| `-nm_version=<label>` | Pick `[nm_versions]` entry from psn.conf | Wire to session-picker selection |
| `-threads=N` | Parallel NONMEM runs (when ≥2 models) | M3+; not M2 |
| `-retries=N` | Retry failing fits with perturbed inits | Off by default; user opt-in |
| `-clean=<0..5>` | Cleanup intensity for `modelfit_dir` | Probably 1 (keep .lst, drop intermediates) |
| `-directory=<path>` | Explicit run dir | Optional power-user feature |
| `-model_dir_name` | `<model>.dir` basename instead of `modelfit_dir` | Maybe — nicer per-model history |
| `-prepend_model_file_name` | Rename outputs to `<model>.<ext>` | Investigate (see PROBE) |
| `-tweak_inits` | Perturb initials between retries (with `-retries`) | If we surface retries |
| `-nmfe_options="..."` | Pass-through to nmfe | Escape hatch |
| `-html / -pdf / -rmarkdown` | Auto-generate report | Out of scope |
| `-rplots=N` | Run R plotting script | Out of scope |
| `-run_on_slurm / -run_on_sge / ...` | Grid submission | Out of scope |

For M2 we surface only what's needed for "run this one model":

```
psn execute -nm_version=<label> <model.mod>
```

Everything else is default. We can layer flags incrementally.

---

## Dataset path semantics

**DOC** (`-copy_data` help text in `bin/execute`):

> Default set. By default PsN will copy the data file into NM_run1 and set a
> local path in psn.mod, the actual model file run with NONMEM. Disable with
> -no-copy_data. If -no-copy_data is set, PsN will not copy the data to NM_run1
> but instead set a global path to the data file in psn.mod. However, NONMEM
> will not accept a path longer than 80 characters.

So the dataset path in `$DATA` is interpreted **relative to the model file's
directory**, copied into `NM_run1/` by default, and rewritten to a local
relative path in `psn.mod`. NONMEM's 80-char `$DATA` limit only matters with
`-no-copy_data`.

**Implication for us.** When we call `psn execute /path/to/model.mod`,
relative `$DATA filename.csv` resolves against `/path/to/`, not against CWD.
This matches how `nmfe76` itself behaves; no surprise.

---

## Implications for positron-nonmem architecture

### nmfe-detect's role changes

Pre-pivot (v0.0.27): we scan `$PATH` + `/opt/nm*/run/` for `nmfe<NN>`
binaries and present them in the runtime picker.

With PsN-as-runner the source of truth shifts to `psn.conf [nm_versions]`.
The runtime picker should list **psn.conf labels**, not nmfe binaries.

Two options:

1. **Replace nmfe-detect with a psn.conf parser.** Read
   `~/psn.conf` (else `<psn-install>/lib/psn.conf`), enumerate
   `[nm_versions]` entries, present each as a runtime. Pass
   `-nm_version=<label>` to `psn execute`.
2. **Hybrid.** Keep nmfe-detect as a sanity-check ("does the directory in
   the psn.conf entry actually exist?"), but list-of-truth comes from
   psn.conf. Fail loudly if a label points at a missing dir.

Recommend **option 2**: the cross-check catches the common case where a
psn.conf alias is stale (NONMEM was uninstalled but the psn.conf entry
remained). Gives a useful "label X points at missing /opt/nmYYY" toast.

### Hard PsN dependency

Confirmed by user 2026-05-03. If `psn` not on `$PATH`, fail registration
loudly with a clear message. No fallback to direct `nmfe`.

```
[positron-nonmem] PsN not found on PATH; runtime not registered.
Install PsN (https://uupharmacometrics.github.io/PsN/) or connect via
Positron Remote SSH to a host that has it.
```

### Probing PsN

Like nmfe-detect, we need to verify PsN is reachable at activation. Probe
candidates:

- `psn -version` (or `execute -version`?) — quick exit, prints PsN version.
- `psn execute -h` — prints help, exits 0; heavy but proves dispatch works.

**PROBE-NEEDED.** Confirm `psn -version` works on 5.3.1. (Older PsN may use
`-V` or different flag.)

### Run discovery (M7 tree view)

Currently we glob `**/*.lst` to discover any run anywhere in the workspace.
That stays correct under PsN — `model.lst` still appears next to `model.mod`
after `psn execute`. The `modelfit_dirN/` clutter is *additional* but not a
problem; if we want, we can add an exclude pattern for `**/modelfit_dir*/**`
in the runs glob to avoid double-counting `psn.lst` inside intermediates.

**PROBE-NEEDED.** Verify the copied-back `.lst` next to the model is the
*final* lst (post-retries) and not an intermediate.

---

## Probe results 2026-05-03 (wider probe)

Six probes ran in `~/positron-nonmem/probe-psn/<probe>/` on primary + the
direct binary lookup. Outcomes:

| # | Probe | Status | Key finding |
|---|---|---|---|
| 1 | `psn -version`, `psn --version`, `execute -version` | ✅ | All print `PsN version: 5.3.1`. |
| 2 | Locate binaries | ✅ | `/usr/local/bin/{psn,execute,sumo,update_inits}`; `nmfe76` at `/opt/nm760/run/nmfe76` (NOT on `$PATH`). |
| 3 | Locate psn.conf | ✅ | Bundled config: `/usr/local/share/perl/5.38.2/PsN_5_3_1/psn.conf`. User config (`~/psn.conf`) presence not yet confirmed (sandbox blocks `cat`). |
| 4 | Vanilla `execute m.mod` (minimal NMTRAN, MAXEVAL=100) | ✅ | RC=0. `m.lst` (8080 B) in CWD; `modelfit_dir1/NM_run1/` with full NONMEM artefacts (FCON, FDATA, FILE07–31, psn.mod, psn.ext, psn.phi, etc.). |
| 5 | Bad `-nm_version=bogus` | ✅ | RC=2. Clean error: `No NONMEM version with name "bogus" defined in psn.conf`. |
| 6 | Broken NMTRAN (`GARBAGE_KEYWORD`) | ⚠ | **RC=0** despite NMtran failure! `m.lst` not produced. Run log contains `NMtran failed.` / `Not restarting this model.` We cannot trust RC for run success. |
| 7 | `-nm_output=ext,phi,cov,cor,coi` | ✅ | RC=0. Extensions land in `modelfit_dir1/` (NOT CWD); `NM_run1/` is archived to `NM_run1.7z`; R post-processing kicks in (`autographs.r.Rout`, `PsN_execute_plots.R`, `raw_results_<model>.csv`). |
| 8 | `sumo m.lst` | ✅ | RC=0. Plain-text formatted summary; OFV / termination / parameter table in deterministic-to-parse layout. See sumo section. |
| 9 | `update_inits m.mod -output_model=m_plus.mod` | ✅ | RC=0. Writes new `.mod` with `$THETA 1` → `$THETA  2.5` (the converged estimate). FIX preserved. See update_inits section. |

(Probe `psn execute m.mod` was the trap that exposed the dispatcher
misconception — RC=0, zero output, zero filesystem effect. See Invocation
section for the corrected understanding.)

## Clean-level effects on file persistence (verified 2026-05-04)

PsN's `-clean=N` flag controls how aggressively the run dir is cleaned
up post-run. Empirical observation on primary with our default
`-nm_output=ext,phi,cov,cor,coi`:

| `-clean=` | `NM_run1/` post-run | `<basename>.lst` in cwd | `<basename>.lst` in modelfit_dir | `model_NMrun_translation.txt` | `command.txt` |
|---|---|---|---|---|---|
| 0 | 7z archive | ✅ | ✅ | ✅ | ✅ |
| 1 (default) | 7z archive | ✅ | ✅ | ✅ | ✅ |
| 2 | 7z archive | ✅ | ✅ | ❌ | ✅ |
| 3 | **GONE** (modelfit_dir kept) | ✅ | ✅ | ❌ | ✅ |
| 5 | **GONE** (modelfit_dir GONE too) | ✅ | ❌ | ❌ | ❌ |

**Key invariants the watcher relies on:**

1. **`NM_run1/psn.mod` exists during setup** (PsN creates it before
   NONMEM starts). FS-watcher onCreate fires at this moment, well
   before any cleanup.

2. **`<basename>.lst` in calling cwd is present at every clean level
   0–5** — the universal completion signal.

3. **`model_NMrun_translation.txt` and `command.txt` exist during the
   run** at every clean level. Our watcher reads them timely on
   psn.mod creation, before cleanup deletes them.

4. **`-nm_output` (which we always pass) triggers automatic archival
   of NM_run1 to NM_run1.7z** post-run, at clean ≤ 2. This is
   independent of -clean. So `NM_run1/psn.mod` is gone post-run at
   ALL clean levels — but again, doesn't matter because the onCreate
   event fired during setup.

**Edge case: startup scan to recover in-flight runs**. At clean ≤ 2,
completed runs leave NM_run1.7z behind, so a naive scan for
`**/NM_run1/...` would false-positive register completed runs as
"running". Discriminator: check for absence of sibling
`<basename>.lst` in the calling cwd — present means run completed.
At clean ≥ 3, no NM_run1 artefact survives → no false positive.

---

## Bundled psn.conf path (verified)

`/usr/local/share/perl/5.38.2/PsN_5_3_1/psn.conf` — the bundled default
that ships with PsN 5.3.1 on this host. PsN reads this if `~/psn.conf`
isn't present.

## Privacy hazard in NONMEM stdout

NONMEM prints lines like:

```
Manager Location <hostname>//home/<user-email>/<path>/...
License Registered to: <organization>
```

Both the **full user email** and the **organization** appear verbatim in
the run log we'd otherwise stream into the Console pane. Per CLAUDE.md
privacy rules, the extension **must scrub these before surfacing in any
UI / log channel / telemetry**.

Implemented in `src/scrub.ts` (`scrubPrivate(text)`), wired through
`NonmemSession.dispatch` (Console streams), `runModel`'s diagnoseFailure
path, and `runCurrentModel`'s catch (toast). Patterns redacted:

- `Manager Location <…>` line — value replaced with `<redacted>`,
  marker preserved. The hostname inside this line is therefore hidden,
  even though we don't have a separate "bare hostname" pattern.
- `License Registered to: <…>` line — same treatment.
- `/home/[^/\s]+/` path components → `/home/<user>/` (catches
  user-named workdir paths anywhere in the output).
- `<user>@<domain>` email tokens → `<redacted-email>`.

Pattern ordering: path-redaction runs **before** email-redaction so an
email-shaped path component (e.g. `/home/jane@example.com/...`) gets
path-redacted to `/home/<user>/...` rather than leaving
`/home/<redacted-email>/...` for the path rule to mangle further.

**Not yet covered (open questions):**

- Bare hostnames outside the `Manager Location` line — not seen
  empirically yet; if NONMEM's MPI / clustering output emits hostnames
  separately, add a pattern then. Aliases (e.g. `primary`) chosen by
  the user are deliberately not scrubbed.
- License expiration date and other license-block fields — currently
  pass through; revisit if they prove sensitive.

---

## Known PsN 5.3.1 caveats

To be filled from `known_bugs_and_workarounds.pdf` v5.3.1 once we have a way
to extract its text, and from issues we hit empirically.

- TODO: list `known_bugs_and_workarounds.pdf` items relevant to `execute`.

---

## Open questions (execute)

1. Does `psn execute` on the host need `R` available for any default code
   path (`-rplots` defaults to ?)? Source shows `-rplots:i` exists; default
   may be 0/off. Verify with a probe — if R is required even for vanilla
   runs, we add another dep.
2. `-clean` default — which intermediates are kept by default? We want at
   least `psn.mod`, `psn.lst`, `stats-runs.csv` for diagnostics.
3. Best way to surface PsN version + nm_versions in the Output channel at
   activation. Probably one shell call: `psn -version && psn execute -h |
   head -1`.

---

## sumo (M3-ready)

PsN's "Summary of Output from NONMEM". One-shot summary that parses a `.lst`
into OFV, condition number, termination status, parameter table.

- Source: https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/bin/sumo
- Userguide: https://github.com/UUPharmacometrics/PsN/releases/download/v5.3.1/sumo_userguide.pdf

**VERIFIED 2026-05-03.** Invocation:

```
sumo run001.lst
```

Takes the `.lst` (not the `.mod`). RC=0 on success. Output is plain-text
formatted, ~25 lines. Sample output verbatim:

```
-----------------------------------------------------------------------

m.lst

Termination problems                                              [  ERROR  ]
No rounding errors                                                [    OK   ]
Zero gradients found 1 times                                      [ WARNING ]
Final zero gradients                                              [  ERROR  ]
Hessian not reset                                                 [    OK   ]
No parameter near boundary                                        [    OK   ]
No covariance step run.

Total run time for model (hours:min:sec):                  0:00:01
Estimation time for subproblem, sum over $EST (seconds):   0.12

Objective function value: 4.5310

Number of observation records: 4
Number of individuals: 2

           THETA                OMEGA      SIGMA
THETA1 ()    2.5  (........)

The relative standard errors for omega and sigma are reported on the approximate
standard deviation scale (SE/variance estimate)/2.
-----------------------------------------------------------------------
```

Useful flags (see `sumo -h` v5.3.1):

- `-csv` — CSV output (PROBE: format).
- `-confidence_interval` — add CIs to parameters.
- `-correlation_limit=<n>` / `-condition_number_limit=<n>` — gate the warnings.
- `-near_zero_boundary_limit=<n>` — boundary detection threshold.
- `-precision=<n>` — display precision.

Parsing strategy for our extension:

- The `[ STATUS ]` lines are deterministic; regex for `^(.+?)\s+\[\s*(OK|WARNING|ERROR)\s*\]$`.
- `Objective function value: <num>` → OFV.
- `Total run time for model (hours:min:sec): <h:m:s>` → wall time.
- `Number of observation records: <n>` / `Number of individuals: <n>`.
- Parameter table — start after `THETA  OMEGA  SIGMA` header line, parse
  rows like `THETA1 () 2.5 (........)`.

UX in our extension (**implemented v0.0.54**, M3):

- Fit Inspector summary line in lst-mode shows `runtime · cond · obs ·
  subj` plus colour-coded status badges (OK green / WARNING yellow /
  ERROR red) for each `[ STATUS ]` row sumo emits. Source of truth:
  `src/runtime/parse-sumo.ts` + `src/runtime/run-sumo.ts`, wired
  through `src/views/variables-context.ts` (parallel with the .ext
  fit load).
- Future: hover-over-`.lst` Markdown tooltip, Runs-tree row
  decorations — straightforward extensions of the same parser.

---

## update_inits (M3-ready)

PsN's "update a model file with parameter estimates from NONMEM output".
Reads a `.lst`, writes a new `.mod` with thetas/omegas/sigmas swapped to
the converged estimates.

- Source: https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/bin/update_inits
- Userguide: https://github.com/UUPharmacometrics/PsN/releases/download/v5.3.1/update_inits_userguide.pdf

**VERIFIED 2026-05-03.** Invocation:

```
update_inits run001.mod -output_model=run002.mod
```

Reads `run001.mod` and its sibling `run001.lst` (auto-discovered). Writes
`run002.mod` with `$THETA` rewritten from initial-estimate values to
the converged final estimates. RC=0 on success. Stdout: single line
`Updating initial estimates`.

Behaviour confirmed:

- `$THETA 1` → `$THETA  2.5` (estimate substituted; reformatting adds
  one extra space, all on one line).
- `$OMEGA 1 FIX` → `$OMEGA  1  FIX` (preserved with reformatting).
- `$SIGMA 1 FIX` → `$SIGMA  1  FIX` (preserved with reformatting).
- `$PROBLEM`, `$INPUT`, `$DATA`, `$PRED`, `$ESTIMATION` blocks preserved
  verbatim modulo whitespace normalization (`$INPUT      ID TIME DV`).

PROBE-NEEDED for edge cases (file when M3 starts):

- Bounds: does `$THETA (0, 1, 100)` get rewritten to `$THETA (0, <est>, 100)`?
- Multiple `$PROBLEM` blocks (single `-output_model=` for all?).
- `$OMEGA BLOCK(2)` non-FIX matrices (BLOCK syntax preserved?).
- `$SIM` / `$TABLE` — passed through?

UX in our extension (**implemented v0.0.45**, M10):

- Right-click a `done` entry in the Active Runs tree → "Promote
  Estimates to New Model".
- Default output name: numeric-bumped (`run001.mod` → `run002.mod`,
  width-preserving) when the stem ends in digits; falls back to
  Pirana's `+N` (`m.mod` → `m+1.mod`) otherwise.
- Input box pre-selects the stem so renaming is one keystroke;
  cancelling aborts.
- New file opens in an editor with `preview: false`; Runs tree
  refreshes.
- Hidden from the command palette — right-click-only.

Wired through `src/runtime/promote-estimates.ts` (pure
`computeNextModelName` + `buildUpdateInitsCommand` helpers + thin
`promoteEstimates` runner wrapper) and `extension.ts`'s
`promoteEstimatesCommand`. Failure path scrubs PsN output via
`scrubPrivate` before toasting.

---

## vpc / npc (stub — fill when M4 starts)

`vpc` (Visual Predictive Check) and `npc` (Numerical Predictive Check)
generate simulation-based diagnostic outputs.

- Source: https://github.com/UUPharmacometrics/PsN/blob/v5.3.1/bin/vpc and `bin/npc`
- Userguide: https://github.com/UUPharmacometrics/PsN/releases/download/v5.3.1/vpc_npc_userguide.pdf

Bigger commitment than execute/sumo: VPC generates a directory of
simulations + R-rendered plots. Surface as a "Run VPC" command that
streams progress, then renders the result PDF/PNG into a Positron Plot
pane.

PROBE-NEEDED. (Out of scope ≤M3.)

---

## Other tools — capture as we go

For each PsN tool we eventually surface, add a section above with this
template:

```
## <toolname>

Brief one-paragraph purpose.

- Source: link to bin/<tool> at v5.3.1
- Userguide: link to <tool>_userguide.pdf at v5.3.1

Invocation surface (DOC).
Output we care about (DOC + PROBE).
UX in our extension.
Open questions / probes needed.
```

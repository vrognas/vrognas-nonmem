# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely.

## [Unreleased]

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

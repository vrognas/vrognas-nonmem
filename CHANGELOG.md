# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely.

## [Unreleased]

### Changed

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

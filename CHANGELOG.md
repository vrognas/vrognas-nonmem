# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely.

## [Unreleased]

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

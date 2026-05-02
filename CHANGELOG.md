# Changelog

All notable changes documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/) loosely.

## [Unreleased]

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

# vrognas-nonmem — Claude Code Working Rules

In all interactions and commit messages, be extremely concise; sacrifice grammar for the
sake of concision.

## Implementation discipline (mirrors sven / redmyne / vscode-nmtran)

- TDD-first: write tests *before* implementation. Three general end-to-end tests per
  implementation is enough — do not gold-plate.
- Before writing tests, write a concise implementation plan with numbered steps. End with
  a list of unresolved questions if any (extremely concise; grammar optional).
- After implementation:
  - Run all tests; nothing should be broken.
  - Update CHANGELOG.md (single line, conventional-commit prefix).
  - Bump the version per semver.
  - Update README / docs only if user-facing surface changed.
  - Commit with a small, focused message.
- Review `docs/empirical-notes.md` and the design plan
  (`~/.claude/plans/so-im-thinking-to-fuzzy-waffle.md`) before each milestone; update
  empirical-notes after each milestone if you learned something the docs missed.
- Tool-call budget: under 5 calls for simple queries; up to 15 for complex ones.
- STOP and ask the user if you find unexpected issues during implementation (breaking
  changes, missing dependencies, test failures).
- When creating PRs, write your own title and body — don't use templates. Use explicit
  `--title` and `--body` flags on `gh pr create`.

## Empirical-validation discipline (from nmguides)

This project's runtime is a real, remote NONMEM. Mocked NONMEM is wrong by definition.
Mirror the discipline from `nonmem-ssh-probe` and the nmguides supplements:

- **Consult the docs first.** State the doc claim, then design the test to confirm or
  refute it. The plan + nmguides + the NONMEM 7 user guide are the references.
- **One change per test.** Never bundle multiple variants. A test that drops `$MODEL`
  must not also simplify `$ERROR` — separate tests, separately documented.
- **Per-run subdirectory** under `~/vrognas-nonmem/<runId>/` on the host (mirrors the
  `nonmem-ssh-probe` skill's `~/nm_validate/<probe>/` pattern). Fixed-name NONMEM
  artefacts (`FCON`, `FDATA`, `FSUBS.f90`, `nonmem` binary) collide otherwise.
- **Isolate the signal.** Strip everything else to the minimum so a PASS/FAIL maps
  cleanly back to the construct under test.
- **Verify, don't trust the docs.** Behavioural assertions that end up in
  `docs/empirical-notes.md` need their own probe on the live 7.6.0 host.

## Privacy hygiene (load-bearing)

- The NONMEM host's name / IP / credentials live in private memory only. They must
  **not** appear in committed source, configs, README, error messages, log lines, test
  fixtures, screenshots, telemetry, or commit messages.
- Read the host setting through `host-profiles.ts` only; the resolved hostname is passed
  directly to ssh2 and is never logged. The Output channel and toasts display the
  configured `alias` (default: `primary`).
- An eslint custom rule should fail builds that introduce string literals matching common
  hostname patterns. (TODO post-M0.)

## Architecture quick reference

- Companion to `vrognas.nmtran` (vscode-nmtran). Share NMTRAN parsing through a future
  shared package; do not duplicate it here.
- Positron-only via `engines.positron`. No `tryAcquirePositronApi()` adapter, no
  vanilla-VSCode fallback path.
- SSH-only execution; per-run remote subdir; outputs sftp'd back to
  `<workspace>/.vrognas-nonmem/runs/<runId>/` plus a `manifest.json` (datasetHash,
  modelHash, nmfeBinary, nonmemVersion, hostAlias, parentRunId).
- Live tail via a small remote bash helper (`tailmux.sh`, M3+) that multiplexes
  `m.ext` / `OFV.TXT` / `m.nmfe.log` / `FMSG` over a single SSH stdout channel.

## Commit-message format

```
<type>: <one-line summary>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Reference
milestone in body when applicable: `milestone: M1`.

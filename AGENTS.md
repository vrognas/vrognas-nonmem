# vrognas-nonmem — Agent guidelines

These rules apply to AI coding agents (Claude, Copilot, Codex, etc.) working in this
repository. They mirror `CLAUDE.md` but in a tool-neutral form.

## Discipline

- TDD-first. Write three minimalist end-to-end tests per feature before implementation.
- Numbered implementation plan with unresolved-questions list before code.
- One change per test against the live NONMEM host. Per-run remote subdirectory.
- Verify, don't trust docs. The live 7.6.0 host is ground truth.
- After implementation: run tests, update CHANGELOG, bump version, commit small.

## Constraints

- **Positron-only** target. No `tryAcquirePositronApi` hedging.
- **Remote NONMEM** via SSH. The hostname must never appear in committed artefacts —
  read from `host-profiles.ts`, log only the alias.
- **Companion** to `vrognas.nmtran`. Share parsers via future shared package; don't
  duplicate NMTRAN tokenisation.
- **Tool budget**: under 5 calls for simple queries; up to 15 for complex ones.

## Style

- Concise communication and commit messages; sacrifice grammar for concision.
- TypeScript strict mode. Prettier + ESLint enforced.
- Empirical findings about NONMEM behaviour go in `docs/empirical-notes.md` with the
  shape: doc claim → probe → outcome.

## Halt and notify when

- Tests fail in unexpected ways.
- A planned change requires a hostname-bearing literal (this is always wrong; redesign).
- The Positron API surface needed for a milestone has changed shape between releases.
- The remote NONMEM host is unreachable for an end-to-end verification.

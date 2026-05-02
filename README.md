# Positron NONMEM

> Status: M0 + M1 (dev environment + Hello SSH). Active development.

`positron-nonmem` turns the NONMEM model–compile–run–result loop into a first-class
[Positron](https://github.com/posit-dev/positron) experience: SSH-based remote execution,
live iteration streaming, run history with ΔOFV-coloured lineage, and Pirana / Improve-style
workbench affordances. Companion to the existing
[vscode-nmtran](https://github.com/vrognas/vscode-nmtran) language extension (syntax /
hover / diagnostics) — they pair cleanly: language services in `vscode-nmtran`, runtime +
workbench here.

**Positron-only.** This extension hard-requires Positron via `engines.positron`. Use
`vscode-nmtran` alone if you only need NMTRAN linting in plain VSCode.

## Status / milestones

The full design lives in
[`docs/design.md`](docs/design.md) (mirrored from the project plan). Current milestone:

- ✅ **M0** — Repo scaffold, build pipeline, lint/test/format toolchain.
- 🟡 **M1** — `Positron NONMEM: Test Connection` command. SSH transport reads the
  configured host profile, runs `uname -a`, displays output. No NONMEM yet.
- ⏳ **M2** — Run a minimal control stream remotely, parse OFV.
- ⏳ **M3** — Live OFV in status bar (multiplexed remote-tail helper).
- … and so on (M4–M11 in the plan).

## Configure

1. Copy `.vscode/settings.example.json` to `.vscode/settings.json`. The latter is
   gitignored.
2. Set `$env:POSITRON_NONMEM_HOST` in your shell (recommended; keeps the hostname out of
   committed configs). On Windows: `setx POSITRON_NONMEM_HOST "yourhost.example.com"`
   then restart Positron.
3. Confirm SSH key auth works locally:
   `ssh -o BatchMode=yes $env:POSITRON_NONMEM_HOST uname -a`.

## Develop

```powershell
npm install
npm run dev          # esbuild watch
npm test             # vitest
npm run lint         # eslint
npm run validate     # parallel: compile + lint + style-check + test
```

In Positron:

1. Open this folder.
2. Press F5 → Extension Development Host launches.
3. Cmd/Ctrl+Shift+P → `Positron NONMEM: Test Connection`.
4. The "Positron NONMEM" Output channel shows
   `[primary] connected. uname: Linux …`.

## Privacy hygiene

- The hostname is read from `${env:POSITRON_NONMEM_HOST}` and **never** logged.
- The Output channel only ever displays the configured `alias` (default: `primary`).
- `.vscode/settings.json` is gitignored; only `settings.example.json` is committed.
- Run output mirrors live in `<workspace>/.positron-nonmem/` which is also gitignored.

## License

MIT — see [`LICENSE`](LICENSE).

## Inspirations

- [vscode-nmtran](https://github.com/vrognas/vscode-nmtran) — companion language extension.
- [Pirana modelling workbench](https://www.certara.com/software/pirana-modeling-workbench/).
- [Scinteco Improve](https://www.scinteco.com/) — provenance metadata + event-driven completion.
- [Stan VSCode extension](https://github.com/wardbrian/vscode-stan-extension) — LSP pattern for
  compiled-DSL tooling.
- [Positron R extension](https://github.com/posit-dev/positron/tree/main/extensions/positron-r) —
  reference `LanguageRuntimeManager` / `LanguageRuntimeSession` implementation.

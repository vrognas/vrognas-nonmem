# Positron NONMEM

`positron-nonmem` makes NONMEM a first-class language runtime in
[Positron](https://github.com/posit-dev/positron): pick a NONMEM version from
the runtime picker, hit run, watch live iterations stream, click through a
runs tree, and read a Fit Inspector that surfaces OFV, SE, shrinkage, $EST /
$COV options, and a ΔOFV-coloured lineage graph. Companion to the
[vscode-nmtran](https://github.com/vrognas/vscode-nmtran) language extension
— language services (syntax / hover / diagnostics) live there; runtime and
workbench live here.

**Positron-only, Remote-SSH-only.** This extension hard-requires Positron
via `engines.positron`. Production deployments run Positron in
[Remote SSH](https://github.com/posit-dev/positron/wiki/Remote-SSH) mode
against the NONMEM host so the extension host (and the NONMEM run) execute
on the same machine; no in-extension SSH layer.

## Configure

The extension reads `[nm_versions]` entries from PsN's own `psn.conf` via a
Perl introspection probe — no per-extension setting points at NONMEM. Each
entry becomes its own Positron runtime ("NONMEM 7.6", "NONMEM 7.5 (75)",
etc.); the picker selects which one a session uses.

User-configurable settings (`nonmem.*` namespace in workspace / user
settings) tune the Fit Inspector thresholds and the lineage view:

- Shrinkage red / warn thresholds (`shrinkageWarnPct`, `shrinkageBorderlineWarnPct`)
- RSE thresholds per parameter kind (`rseWarnPct`, `rseThetaWarnPct`, `rseOmegaWarnPct`)
- P-value thresholds (`pValWarnThreshold`, `pValBadThreshold`)
- Correlation flag thresholds (`corrRedFlagThreshold`, `corrWarnThreshold`)
- Condition-number thresholds (`condNumberBadThreshold`, `condNumberWarnThreshold`)
- Lineage ΔOFV threshold (`lineageOfvThreshold`)
- Named sub-lineages + parent overrides (`lineages`, `lineageOverrides` —
  edited via the Run Lineage panel, not by hand)

Defaults match pharmacometric convention (30% shrinkage, 100% RSE,
α=0.05, |r|≥0.95, cond>1000, ΔOFV=3.84). Search "nonmem" in the Settings UI
for descriptions.

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
3. Open an `.mod` file; pick a NONMEM runtime from the session picker;
   `Positron NONMEM: Run Current Model` from the command palette.

## Privacy hygiene

- The NONMEM host's name / IP / credentials never appear in committed
  source, configs, README, error messages, log lines, test fixtures,
  screenshots, telemetry, or commit messages. PsN's `nm_versions` entries
  are read at runtime; the resolved `installDir` is kept in-process.
- PsN / NONMEM stdout often embeds `Manager Hostname`, `Compiled by`,
  `working directory`, email-shaped tokens, and `/home/<user>/…` paths;
  `src/scrub.ts` redacts all of these before any Console / Output channel
  emission.
- WebView `renderError` messages route through `sanitizeWebviewMessage`
  (`src/views/webview-shell.ts`) which strips `vscode-resource://`,
  Windows `[A-Z]:\…`, and `/home/<user>/…` paths plus caps at 500 chars.
- Run artefacts mirror into `<workspace>/.positron-nonmem/` — gitignored.
- Lineage settings (`lineageOverrides`, `lineages`) store
  workspace-relative paths when inside a workspace folder so
  `settings.json` is shareable without leaking absolute paths.

## License

MIT — see the `LICENSE` file in the repo root.

## Inspirations

- [vscode-nmtran](https://github.com/vrognas/vscode-nmtran) — companion language extension.
- [Pirana modelling workbench](https://www.certara.com/software/pirana-modeling-workbench/).
- [Scinteco Improve](https://www.scinteco.com/) — provenance metadata + event-driven completion.
- [Positron R extension](https://github.com/posit-dev/positron/tree/main/extensions/positron-r) —
  reference `LanguageRuntimeManager` / `LanguageRuntimeSession` implementation.

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

**Probe.** Run via `SshTransport.run('uname -a')` against `qphcmp03`-class hosts on this
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
ERR Error getting manager for runtime positron-nonmem-qphcmp03 (...): No session
    manager found for runtime positron-nonmem-qphcmp03 (...) (2 managers registered).
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


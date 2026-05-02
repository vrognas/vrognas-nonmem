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

**Fix.** Add `"*"` to `activationEvents` so positron-nonmem activates at extension-host
startup, the same time as bundled extensions do. The cost is the extension always loads
(rather than lazily on first .mod open), but our `activate()` is tiny — registers a
command, an OutputChannel, and a runtime manager — so the cost is negligible.

(Listed alongside `onStartupFinished` and `onLanguage:nmtran` for completeness; `*`
should always win, those are belt-and-braces.)


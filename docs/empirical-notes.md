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

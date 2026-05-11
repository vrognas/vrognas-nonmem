// Shared shell-quoting helper. Used by every place that builds a
// command for `Runner.run` from path-typed arguments.
//
// On POSIX shells (`/bin/sh -c`), single-quote is safe for any byte
// except a literal apostrophe, which we escape via the `'\''` idiom
// (close quote, escape, reopen). On Windows `cmd.exe /d /s /c`, single
// quotes are NOT a quoting mechanism — cmd treats them as literals.
// Use double quotes and escape embedded `"` by doubling (cmd's internal
// escape rule). Filenames containing `"` are extraordinarily rare so
// the doubled-quote idiom is overkill but harmless.
//
// The supported production deployment is Positron Remote SSH where the
// extension host runs on a Linux NONMEM box (POSIX branch). The cmd.exe
// branch is reachable only when someone runs the extension directly on
// Windows without Remote SSH, which CLAUDE.md flags as out of scope —
// but a wrong-shell quoting bug would be silent and confusing, so we
// branch correctly anyway.

/** Quote `s` for safe interpolation into the platform shell command run by LocalRunner. */
export function quote(s: string): string {
  if (process.platform === 'win32') {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

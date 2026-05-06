// Shared shell-quoting helper. Used by every place that builds a
// command for `Runner.run` from path-typed arguments. Single-quote is
// safe for any byte except a literal apostrophe, which we escape via
// the `'\''` idiom (closes the quote, escapes the apostrophe, reopens).

/** Quote `s` for safe interpolation into a `/bin/sh -c` (or cmd.exe) command. */
export function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

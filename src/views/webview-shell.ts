// Shared HTML shell + CSP builder for the extension's WebViews.
//
// The Fit Inspector and the Lineage panel both produce a DOCTYPE +
// CSP-meta + linked styles + body + script-tags scaffold. Construction
// of the CSP header in particular is where security regressions hide:
// a typo in `default-src 'none'` or a missing `'unsafe-inline'` flag
// would either break rendering or open an XSS hole. One helper, one
// place to audit.
//
// The two callers differ in three real ways:
//   - bodies are very different shapes (inspector: `<div id="root">`;
//     lineage: legend / context menu / canvas wrap / iofv panel),
//   - the lineage panel needs `'unsafe-inline'` for style-src
//     (Cytoscape applies inline styles at runtime),
//   - script counts differ (inspector loads three, lineage loads one).
// We expose each as a parameter rather than hard-coding either path.

import * as vscode from 'vscode';

export interface WebviewShellOptions {
  /** Stylesheet URIs to link in `<head>`, in order. */
  styles: readonly vscode.Uri[];
  /** Script URIs to load just before `</body>`, in order. Order matters: earlier scripts define globals used by later ones. */
  scripts: readonly vscode.Uri[];
  /** Raw body HTML inserted between `<body>` and the script tags. Trusted — callers control it. */
  body: string;
  /**
   * Allow inline `style="..."` attributes (adds `'unsafe-inline'` to
   * `style-src`). Required for Cytoscape (it paints inline styles on
   * its canvas container). Default false.
   */
  allowInlineStyle?: boolean;
}

/**
 * Sanitise a `renderError` message coming back from a WebView before
 * logging it. Both `fit-inspector-provider.ts` and `lineage-panel.ts`
 * need this — Chromium's `e.stack` (and occasionally `e.message`) can
 * embed `vscode-resource://` URIs and absolute paths (POSIX
 * `/home/<user>/…` or Windows `C:\Users\…`). The webview SHOULD send
 * `e.message` only (defense-in-depth), but the receiver scrubs anyway.
 * Caps to 500 chars so a runaway stack can't flood the Output channel.
 */
export function sanitizeWebviewMessage(raw: string): string {
  return raw
    .replace(/vscode-resource:\/\/\S+/g, '<resource>')
    .replace(/[A-Za-z]:\\[^\s,;:]*/g, '<path>')
    .replace(/\/home\/[^/\s]+\/\S*/g, '/home/<user>/<path>')
    .replace(/\/Users\/[^/\s]+\/\S*/g, '/Users/<user>/<path>')
    .slice(0, 500);
}

/**
 * Build the WebView HTML shell with a strict CSP. Locks script + style
 * sources to `webview.cspSource` (so only extension-bundled assets
 * load); no remote sources, no inline scripts. Inline styles allowed
 * only when `allowInlineStyle` is set.
 */
export function buildWebviewShell(webview: vscode.Webview, opts: WebviewShellOptions): string {
  const styleSrc = opts.allowInlineStyle
    ? `${webview.cspSource} 'unsafe-inline'`
    : webview.cspSource;
  const csp = `default-src 'none'; style-src ${styleSrc}; script-src ${webview.cspSource};`;
  const styleLinks = opts.styles.map((u) => `<link rel="stylesheet" href="${u}">`).join('\n');
  const scriptTags = opts.scripts.map((u) => `<script src="${u}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${styleLinks}
</head>
<body>
${opts.body}
${scriptTags}
</body>
</html>`;
}

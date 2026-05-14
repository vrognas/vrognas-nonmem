// FitInspectorProvider — WebView in the NONMEM activity bar that
// renders converged estimates alongside their initials in a multi-
// column table (Name | LB | IE | UB | FE | SE | Fixed for thetas;
// Name | Init | Final | SE | Fixed for omegas/sigmas), plus a
// diagnostics block (termination, ETABAR, shrinkages, eigenvalues,
// PRDERR) and a Run Notes block from the .mod's `;;` runrecord.
//
// We use a WebView rather than Positron's Variables comm because the
// comm format gives one display_value per row, hard-codes group
// names, and caches has_viewer / display_type metadata in ways that
// don't survive live reshaping between mod-mode and lst-mode pushes.
// The WebView side-steps all of that with full HTML/CSS control.
//
// The HTML/CSS/JS assets live in `media/fit-inspector/` and are
// loaded via `webview.asWebviewUri`. They're plain `.js`/`.css`
// files so editor tooling (highlighting, format, lint) works on
// them directly — and template-literal escape pitfalls (the
// `\r?\n` regex bug we fixed in v0.0.62) can't recur.
//
// Wire format (extension ↔ webview, both directions are JSON):
//   ext → web: { type: 'update', payload: InspectorPayload | null }
//   web → ext: { type: 'ready' }                       (initial handshake)
//              { type: 'gotoLine', line: number }      (click on a row)
//              { type: 'renderError', message: string } (caught render failure)
//
// `ready` handles the case where the webview opens AFTER an editor
// switch already produced a payload — the extension caches the last
// payload and re-pushes on `ready`.

import * as vscode from 'vscode';
import type { InspectorPayload } from './fit-inspector-payload';
import { buildWebviewShell, sanitizeWebviewMessage } from './webview-shell';

export class FitInspectorProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nonmem.fitInspector';

  private view: vscode.WebviewView | undefined;
  /** Most-recent payload we've been asked to render; replayed on view re-mount + on `ready`. */
  private lastPayload: InspectorPayload | null = null;
  /** URI of the .mod backing `lastPayload` — used to resolve gotoLine clicks. */
  private modUri: vscode.Uri | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Fired on row click; receives (uri, line). Wired in extension.ts to vscode.window.showTextDocument. */
    private readonly navigator: (uri: vscode.Uri, line: number) => void,
    /** Optional logger for WebView-side errors so they surface in the Output channel. */
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.renderHtml(view.webview);
    // Wire listener disposables to view.onDidDispose so they don't accumulate
    // across reload cycles (VS Code re-resolves on window reload).
    const msgSub = view.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg));
    // postMessage on a hidden WebView is silently dropped, so we have
    // to replay the last payload whenever visibility flips back on.
    const visSub = view.onDidChangeVisibility(() => {
      this.log(`fit-inspector: visibility=${view.visible}`);
      if (view.visible) this.post({ type: 'update', payload: this.lastPayload });
    });
    view.onDidDispose(() => {
      msgSub.dispose();
      visSub.dispose();
    });
    this.log(`fit-inspector: resolveWebviewView fired (visible=${view.visible})`);
    this.post({ type: 'update', payload: this.lastPayload });
  }

  /** Push a fresh payload (or null to clear) to the view. Cached so re-mounts replay. */
  update(payload: InspectorPayload | null, modUri: vscode.Uri | undefined): void {
    this.lastPayload = payload;
    this.modUri = modUri;
    this.post({ type: 'update', payload });
  }

  private post(message: object): void {
    if (!this.view) return;
    void this.view.webview.postMessage(message);
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown; line?: unknown; message?: unknown };
    if (m.type === 'ready') {
      this.post({ type: 'update', payload: this.lastPayload });
      return;
    }
    if (m.type === 'gotoLine' && typeof m.line === 'number' && this.modUri) {
      this.navigator(this.modUri, m.line);
      return;
    }
    if (m.type === 'renderError') {
      this.log(
        `fit-inspector: webview render error: ${sanitizeWebviewMessage(String(m.message ?? '<no message>'))}`,
      );
    }
  }

  /**
   * Build the WebView HTML via the shared `buildWebviewShell` helper.
   * Order matters: `formatters.js`, `transforms.js`, and
   * `xml-invisible-attrs.js` define helper functions + global constants
   * that `client.js` calls at top level, so they load first.
   */
  private renderHtml(webview: vscode.Webview): string {
    const asset = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));
    return buildWebviewShell(webview, {
      styles: [asset('media', 'fit-inspector', 'style.css')],
      scripts: [
        asset('media', 'fit-inspector', 'formatters.js'),
        asset('media', 'fit-inspector', 'transforms.js'),
        asset('media', 'fit-inspector', 'xml-invisible-attrs.js'),
        asset('media', 'fit-inspector', 'trajectory-plot.js'),
        asset('media', 'fit-inspector', 'client.js'),
      ],
      body: '<div id="root"></div>',
    });
  }
}

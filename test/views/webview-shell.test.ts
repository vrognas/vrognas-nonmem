import { describe, it, expect } from 'vitest';
import { sanitizeWebviewMessage, buildWebviewShell } from '../../src/views/webview-shell';
import { Uri } from '../__mocks__/vscode';

describe('sanitizeWebviewMessage', () => {
  it('strips vscode-resource:// URIs', () => {
    const raw = 'TypeError at vscode-resource://file///c:/Users/x/ext/out/client.js:42:7';
    expect(sanitizeWebviewMessage(raw)).toContain('<resource>');
    expect(sanitizeWebviewMessage(raw)).not.toContain('vscode-resource://');
  });

  it('strips Windows-style absolute paths', () => {
    const raw = 'ENOENT: C:\\Users\\jane.doe\\projects\\m1.lst';
    const out = sanitizeWebviewMessage(raw);
    expect(out).toContain('<path>');
    expect(out).not.toContain('jane.doe');
    expect(out).not.toContain('C:\\');
  });

  it('strips POSIX /home/<user>/ paths', () => {
    const raw = 'failed: /home/jane.doe/work/run001.lst not readable';
    const out = sanitizeWebviewMessage(raw);
    expect(out).toContain('/home/<user>/<path>');
    expect(out).not.toContain('jane.doe');
  });

  it('caps output to 500 chars (runaway stack)', () => {
    const raw = 'x'.repeat(1000);
    expect(sanitizeWebviewMessage(raw).length).toBe(500);
  });

  it('leaves short non-leaky messages unchanged', () => {
    const raw = 'TypeError: cannot read property "foo" of undefined';
    expect(sanitizeWebviewMessage(raw)).toBe(raw);
  });

  it('handles multiple leak types in one string', () => {
    const raw = 'fail at vscode-resource://x C:\\path\\1 /home/u/y end';
    const out = sanitizeWebviewMessage(raw);
    expect(out).not.toContain('vscode-resource://');
    expect(out).not.toContain('C:\\path');
    expect(out).not.toContain('/home/u/');
  });
});

describe('buildWebviewShell', () => {
  const fakeWebview = {
    cspSource: 'vscode-webview://abc',
    asWebviewUri: (uri: Uri): Uri => uri,
  } as unknown as Parameters<typeof buildWebviewShell>[0];

  it('embeds strict CSP — no inline style by default', () => {
    const out = buildWebviewShell(fakeWebview, {
      styles: [],
      scripts: [],
      body: '<div></div>',
    });
    expect(out).toContain("default-src 'none'");
    expect(out).toContain('style-src vscode-webview://abc;');
    expect(out).not.toContain("'unsafe-inline'");
  });

  it('opts into inline style when allowInlineStyle is true', () => {
    const out = buildWebviewShell(fakeWebview, {
      styles: [],
      scripts: [],
      body: '<div></div>',
      allowInlineStyle: true,
    });
    expect(out).toContain("style-src vscode-webview://abc 'unsafe-inline'");
  });

  it('renders linked styles + scripts in supplied order', () => {
    // Cast through `unknown` — mock Uri is a structural duck-type that
    // satisfies the runtime surface used by `buildWebviewShell` (only
    // `toString()` via template-literal coercion) but not the full
    // `vscode.Uri` type (missing query / fragment / with / toJSON).
    type AnyUri = Parameters<typeof buildWebviewShell>[1]['styles'][number];
    const a = Uri.file('/x/a.css') as unknown as AnyUri;
    const b = Uri.file('/x/b.css') as unknown as AnyUri;
    const j1 = Uri.file('/x/1.js') as unknown as AnyUri;
    const j2 = Uri.file('/x/2.js') as unknown as AnyUri;
    const out = buildWebviewShell(fakeWebview, {
      styles: [a, b],
      scripts: [j1, j2],
      body: '<div id="root"></div>',
    });
    const aIdx = out.indexOf('a.css');
    const bIdx = out.indexOf('b.css');
    const j1Idx = out.indexOf('1.js');
    const j2Idx = out.indexOf('2.js');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(j1Idx).toBeGreaterThan(bIdx);
    expect(j2Idx).toBeGreaterThan(j1Idx);
    expect(out).toContain('<div id="root"></div>');
  });
});

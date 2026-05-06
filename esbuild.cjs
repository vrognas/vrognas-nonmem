/* eslint-disable @typescript-eslint/no-var-requires, no-console */
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const EXTENSION_CONFIG = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  target: "node20",
  outfile: "out/extension.js",
  external: ["vscode"],
  logLevel: "silent",
};

// WebView bundles. Browser-targeted IIFE with cytoscape inlined. The
// extension serves the bundled output via `webview.asWebviewUri`. Each
// entry must be a self-contained <script> body (no external module
// loader available in a sandboxed webview).
const LINEAGE_WEBVIEW_CONFIG = {
  entryPoints: ["webview-src/lineage/client.ts"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  target: "es2020",
  outfile: "media/lineage/client.js",
  logLevel: "silent",
};

async function main() {
  const ctxs = await Promise.all(
    [EXTENSION_CONFIG, LINEAGE_WEBVIEW_CONFIG].map((cfg) =>
      esbuild.context({ ...cfg, plugins: [problemMatcher(cfg.outfile)] }),
    ),
  );

  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
}

const problemMatcher = (label) => ({
  name: "problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log(`[build:${label}] started`);
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`[error:${label}] ${text}`);
        if (location) {
          console.error(`  ${location.file}:${location.line}:${location.column}`);
        }
      });
      console.log(`[build:${label}] finished${result.errors.length ? " with errors" : ""}`);
    });
  },
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

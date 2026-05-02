/* eslint-disable @typescript-eslint/no-var-requires, no-console */
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
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
    plugins: [problemMatcher],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

const problemMatcher = {
  name: "problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[build] started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`[error] ${text}`);
        if (location) {
          console.error(`  ${location.file}:${location.line}:${location.column}`);
        }
      });
      console.log(`[build] finished${result.errors.length ? " with errors" : ""}`);
    });
  },
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

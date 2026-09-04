import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "node",
  target: "node24",
  sourcemap: true,
  outfile: "dist/main.js",
});

// The installed-runtime smoke entry (issue #197) ships as a self-contained
// ESM executable so the registered-runtime run needs no build orchestration
// beyond `npm run build`.
await esbuild.build({
  entryPoints: ["src/installed-runtime/smoke.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  outfile: "dist/installed-runtime-smoke.mjs",
});

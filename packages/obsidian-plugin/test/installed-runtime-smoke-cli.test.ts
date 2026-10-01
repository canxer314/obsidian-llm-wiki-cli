import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps each command's candidate separate without overwriting prior workdir artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-cli-candidates-"));
  try {
    const packageRoot = join(root, "plugin");
    const dist = join(packageRoot, "dist");
    const workdir = join(root, "work");
    await mkdir(dist, { recursive: true });
    await mkdir(join(workdir, "candidate-bundle"), { recursive: true });
    await writeFile(join(workdir, "candidate-bundle", "main.js"), "prior candidate");
    await writeFile(join(workdir, "candidate-bundle.attestation.json"), "prior attestation");
    await writeFile(join(packageRoot, "manifest.json"), await readFile("manifest.json"));
    await writeFile(join(packageRoot, "package.json"), await readFile("package.json"));
    await writeFile(join(dist, "main.js"), "// command fixture, never executed\n");
    const entry = join(dist, "smoke.mjs");
    await build({
      entryPoints: [resolve("src/installed-runtime/smoke.ts")], outfile: entry,
      bundle: true, platform: "node", format: "esm", target: "node24",
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
    const registration = join(root, "registration.json");
    await writeFile(registration, JSON.stringify({
      obsidianExecutable: process.execPath, obsidianVersion: "unverified",
      electronVersion: "unverified", nodeVersion: "unverified",
    }));
    // Unknown profile fails before launching any runtime. Only packaging is under test.
    for (let index = 0; index < 2; index += 1) {
      await promisify(execFile)(process.execPath, [entry, "--registration", registration,
        "--workdir", workdir, "--profile", "UNKNOWN-PACKAGING-TEST"])
        .catch((error: { code: number }) => { expect(error.code).toBe(1); });
    }
    expect(await readFile(join(workdir, "candidate-bundle", "main.js"), "utf8")).toBe("prior candidate");
    expect(await readFile(join(workdir, "candidate-bundle.attestation.json"), "utf8")).toBe("prior attestation");
    const candidates = (await readdir(workdir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith("candidate-bundle-"));
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(await readFile(join(workdir, candidate.name, "main.js"), "utf8"))
        .toBe("// command fixture, never executed\n");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

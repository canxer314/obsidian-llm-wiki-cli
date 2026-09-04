# Installed-runtime harness (issue #197)

Reusable verification substrate for proving a candidate Vault Operation
Bridge bundle inside a dedicated, real Obsidian runtime (spec §9/§12). Later
install, upgrade, uninstall, and purge tickets add scenario cases on top of
these seams instead of building parallel harnesses.

## What one run does

`runInstalledRuntimeHarness(options)` (`harness.ts`):

1. **Preflight** — looks up the specifically registered runtime profile and
   compares it against probed host facts (OS platform/build, Obsidian,
   Electron and Node versions, required capabilities). Any mismatch or
   unverifiable fact refuses passing evidence.
2. **Provision** — creates one dedicated generated test Vault plus a sibling
   dedicated Obsidian profile directory, refusing to overwrite any existing
   root (spec §12.2/§12.6).
3. **Candidate** — verifies the candidate bundle (`manifest.json`, `main.js`,
   optional `styles.css`, `checksums.sha256`), installs it into the test
   Vault as the only enabled community plugin, and re-verifies written bytes.
4. **Observe** — starts real Obsidian through the process-control seam, waits
   for the plugin-persisted Bridge identity, then initializes a real loopback
   Streamable HTTP MCP client with the expected Vault ID and obtains a
   schema-valid `vault_health` result.
5. **Restart** — repeats the observation across a controlled Obsidian stop
   (verified: the loopback listener is gone) and restart, requiring the
   persisted Vault ID and port to remain stable.
6. **Cleanup + evidence** — snapshots before/after inventories (paths, sizes,
   SHA-256 only), removes the generated roots, reports residual paths, and
   atomically writes one closed evidence record. Existing evidence files are
   never overwritten.

## Verdicts — never a skipped green

Every run ends with exactly one verdict in its evidence record:

- `passed` — matched profile, candidate installed, both health observations
  schema-valid with the expected identity, and cleanup left no residue.
- `failed` — the candidate or its runtime behavior failed: process/startup
  failure, readiness timeout, identity mismatch, schema-invalid or
  incompatible health, listener divergence, unclosed listener.
- `invalid` — the run cannot register candidate evidence at all: unregistered
  or mismatched profile, probe failure, pre-existing Vault root, candidate
  integrity failure, inventory failure, cleanup failure, or residual test
  content.

## Evidence and privacy

`evidence.ts` defines the closed zod schema: registered profile plus probed
facts, candidate/plugin/protocol identities, input hashes (candidate bundle,
seed manifest), before/after inventories and their comparison, per-phase
health summaries (digests only — the raw payload and absolute Vault path are
never recorded), verdict, failure stage/code, and the residual-cleanup
report. Serialization scans for registered private markers (seeded note
bodies, absolute Vault/profile roots) and refuses to write on any leak;
unknown fields reject fail closed.

## Scenario seams

Later lifecycle tickets inject behavior through `InstalledRuntimeHarnessOptions`
without forking the harness:

- `probe` (`RuntimeEnvironmentProbe`) — host fact collection.
- `processControl` (`ObsidianProcessControl`) — Obsidian start/stop; the real
  Windows implementation lives in `obsidian-process.ts`.
- `client` (`LoopbackMcpClient`) — loopback MCP access; defaults to the real
  client in `loopback-client.ts`.
- `snapshotVaultInventory` / `cleanupVault` — inventory and cleanup seams.
- `profiles` — the registered-profile registry (defaults to the built-in
  registry containing `MVP-PERF-REF-1`).

## Registered real-runtime smoke run

On a registered Windows machine matching `MVP-PERF-REF-1`:

```sh
cd packages/obsidian-plugin
npm run smoke:installed-runtime -- \
  --registration registration.json --workdir <scratch-dir> \
  [--candidate <bundle-dir>] [--evidence <path>]
```

The registration file pins the observed installation facts:

```json
{
  "obsidianExecutable": "C:/Program Files/Obsidian/Obsidian.exe",
  "obsidianVersion": "1.13.4",
  "electronVersion": "39.6.0",
  "nodeVersion": "24.14.0"
}
```

Without `--candidate`, the smoke run assembles the locally built plugin
(`manifest.json` + `dist/main.js`) as the candidate. The process exits zero
only when the evidence verdict is `passed`; every other outcome writes
failed/invalid evidence and exits non-zero.

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
   optional `styles.css`, `checksums.sha256`) through the release verifier
   (issue #196), installs only the verifier's branded result into the test
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

The public-wire corpus evidence (issue #174) extends the same envelope with a
deterministic read-side corpus identity (`corpusId`, seed-inventory and
scenario-program digests), wire-observed before/after inventories from
deterministic discovery, and a retained-byte cleanup report proving every
continuation chain the corpus issued was consumed to completion and rejected
on replay. A passing run requires the observed inventory digest to be
unchanged and every issued chain consumed and single-use proven.

The change-set submission corpus (issue #175) proves the write side of the
same six-tool contract through the same real loopback transport and the real
file-system Change Set engine. It registers a closed
`change-set-submission-proof` corpus identity, then exercises one deterministic
ordered scenario program over `vault_change_set_submit` /
`vault_change_set_status` (plus `vault_discover`/`vault_health` for inventory
and idle-state evidence): a valid submit performs validation, complete
preflight, registration, queueing, and execution-or-recovery advancement with
no validate/apply handshake; every lease-time preflight rejection class
returns only its stable evidence and mutates nothing; concurrent submissions
prove exactly-once admission and single-writer contended-target exclusion;
lost/truncated/schema-invalid/representation-mismatched submit responses are
recovered only through the original Submission Key; and preview, final result,
status, and replay preserve immutable effect IDs, causation, ordering, and
typed path evidence. The harness runs the admission phase in the initial
Obsidian window and replays every established Submission Key over a fresh
connection after the controlled stop/restart boundary, so the durable identity
evidence is proven across a real process restart. Only digest-only per-key
proof records, digests of the wire-observed seed inventories, and the idle
recovery/queue/write-gate report reach the evidence envelope.

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

## Lifecycle scenario (issue #198)

`lifecycle-scenario.ts` exposes `runLifecycleInstallScenario(options)` — one
dedicated scenario composed over these same seams (`processControl`,
`client`, `provisionVault`, `cleanupVault`) rather than a parallel harness.
It proves per-Managed-Vault release lifecycle end to end in a generated test
Vault: first install (files only) → explicit operator enablement → Bridge
start and persisted identity → registration command generation (never
execution) → `ready` → same-version `unchanged` → damage-and-repair with
byte-exact state preservation → the identity-mismatch projection → cleanup
with no residue. #44 composes this scenario into larger corpora; the harness
corpus above is unchanged.

## Purge scenario (issue #201)

`purge-scenario.ts` exposes `runManagedVaultPurgeScenario(options)` on the
same seams, proving the spec §9.3 backup-backed interactive purge end to end:
real per-Vault state is created through install, enablement, Bridge start,
and real work through the MCP surface; the purge is refused while work is
queued (live and offline persisted evidence), on an unresolved Recovery
Journal frame, without a confirmation seam, and on operator cancellation;
then an ordinary uninstall and a backup-backed confirmed purge tied to the
Vault identity run, the lifecycle projects `not_installed` with the
enumerated operational state gone and Vault content intact, the backup
re-verifies independently, a rerun reports `already_purged`, and cleanup
leaves no residue (scenario backups included). It is a composable input to
#44, alongside the install, upgrade, and uninstall scenarios.

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

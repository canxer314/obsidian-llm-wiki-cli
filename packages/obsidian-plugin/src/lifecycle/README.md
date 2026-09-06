# Lifecycle install, repair, and verification (issue #198)

Per-Managed-Vault deployment of an explicitly verified Release (spec §9.1).
The installer consumes only the branded `VerifiedReleaseBundle` produced by
`src/release/verify-release-bundle.ts` (issue #196) — there is no
verification bypass, no raw-directory or URL input, and no skip flag.

## Pieces

- `release-managed-files.ts` — the strict release-managed allowlist
  (`manifest.json`, `main.js`, optional `styles.css`, `checksums.sha256`)
  that alone decides which files lifecycle operations may stage, verify,
  replace, repair, or remove. Also the installed-set inspections used by
  repair classification and lifecycle projection (hash verification against
  the bundle identity, or against the deployed checksum manifest when no
  bundle is at hand).
- `install-release.ts` — `installReleaseToManagedVaults(bundle, targets)`:
  preflights **every** target (Vault/config destination, path safety and
  containment, supported Obsidian runtime vs `minAppVersion`, required
  capacity) before any target is modified — a failed batch preflight changes
  no target. Afterwards each target is installed independently and reported
  `success` / `unchanged` / `failed`; the batch is per-Vault atomic and never
  claims cross-Vault atomicity.
  - **Atomic per Vault**: the complete staging directory (verified managed
    files plus a byte copy of all preserved operational state) is hash-checked
    before a two-rename directory swap. At every on-disk point the Vault holds
    either its complete previous bundle or its complete verified replacement;
    ordinary filesystem faults roll back to the previous bundle, and an
    interrupted swap leaves deterministic `.<id>.staging-*` / `.<id>.backup-*`
    leftovers that `recoverInterruptedInstall` (run automatically before
    every install) reconciles to the boundary.
  - **First install deploys files only**: it never writes
    `community-plugins.json`, never creates a Vault ID or port, never
    initializes queue or Recovery Journal state, and never reads or modifies
    Claude Code configuration. A successful first install reports
    `artifacts_installed` with `plugin_enablement_required` and
    `mcp_registration_required` as the Primary Operator's remaining steps.
  - **Same-version reinstall**: `unchanged` when every managed file verifies;
    otherwise only damaged or missing managed files are restored from the
    bundle and stale allowlisted files are dropped, while Vault identity,
    persistent port, FIFO/Submission Key state, settings, and every Recovery
    Journal survive byte-for-byte.
  - **Removal**: `removeReleaseManagedFiles` deletes only allowlisted files
    and retains all operational state; the §9.3 refusal orchestration
    (executing work, unresolved recovery) belongs to the uninstall ticket.
- `lifecycle-status.ts` — `verifyManagedVaultLifecycle(target, probes)`
  projects `not_installed` / `installed_not_enabled` / `bridge_offline` /
  `mcp_not_registered` / `identity_mismatch` / `ready`. Each state requires
  positive evidence from the previous one; a managed set that fails integrity
  projects `not_installed` with the defective files listed. The module never
  reads Claude Code configuration — registration readiness needs the
  operator-supplied probe, and defaults to `mcp_not_registered`.
- `upgrade-release.ts` — `upgradeManagedVaultRelease(options)` (issue #199,
  spec §9.2) upgrades one drained Managed Vault from a verified staged
  Release, composing the boundaries above without adding a second download,
  provenance, file-ownership, or maintenance implementation:
  - The loaded runtime's `runOperatorMaintenance` enters
    `maintenance_pending`, drains the current Change Set to a trustworthy
    terminal state, retains the FIFO queue, stops dequeueing, and rejects new
    submissions while reads/health stay available; inside that drained window
    the installer atomically swaps in the verified bundle (operational state
    carried byte-for-byte) and revalidates persisted state.
  - The host `reloadRuntime` seam then performs the real plugin reload or
    Obsidian restart; the fresh runtime's `load()` migrates the versioned
    persistent state and replays Recovery Journals fail-closed. A second
    drained maintenance pass on the reloaded runtime proves the running files
    hash-equal the verified bundle identity.
  - Post-upgrade health evidence must confirm the expected plugin/protocol
    versions, Vault identity, persistent-state and journal schema versions,
    queue preservation (length, head, Submission Keys, enqueue sequence),
    recovery trust, and Search Snapshot/index readiness — then the Vault
    stays `maintenance_paused` until the Primary Operator explicitly calls
    `resumeWrites()`. Copying files alone never reports success: `upgraded`
    is returned only after the health phase validates.
  - Every phase boundary is mirrored into the versioned evidence journal
    `upgrade-state.json` (preserved operational state, atomically published),
    so verification, staging, replacement, reload, migration, recovery, or
    health failure never reports success, loses queued or idempotency state,
    or reopens writes — the maintenance machine's persisted
    `maintenance_failed` plus the journal are the machine-actionable
    fail-closed evidence. `readManagedVaultUpgradeEvidence` reads it back;
    a malformed record throws instead of being treated as a clean slate.
  - Rollback restores the verified previous bundle only while the on-disk
    persistent state stays readable by the old runtime (schema versions at or
    below the ceilings the old runtime observed before the upgrade). The
    drain barrier guarantees no Change Set executes inside the upgrade
    window, so no new Recovery Journal frames can appear there. A migration
    that crossed the readability boundary forbids blind downgrade
    (`upgrade_downgrade_forbidden`): the new bundle, the new state, and the
    diagnostic evidence are retained and the Vault remains blocked.

## Installed-runtime scenario

`src/installed-runtime/lifecycle-scenario.ts` composes these operations over
the installed-runtime harness seams (issue #197): first install → explicit
operator enablement → Bridge start → registration command generation (never
execution) → `ready` → same-version `unchanged` → damage-and-repair with
state preservation → identity-mismatch projection → cleanup. It is exposed
for later composition by #44 and does not replace the harness corpus.

`src/installed-runtime/upgrade-scenario.ts` (issue #199) proves the drained
upgrade end to end on the same seams: previous Release installed and enabled
→ Bridge started → work queued through the real MCP surface → orchestrated
upgrade through a real Obsidian stop/start (the plugin reloads from the
replaced bundle) → Vault identity, port, FIFO queue, and Submission Keys
preserved → post-upgrade maintenance pause held with submissions rejected
without key binding → the Primary Operator's explicit resume reopens writes
and the refused key retries successfully → cleanup with no residue. It is a
composable input to #44, not a harness-corpus replacement.

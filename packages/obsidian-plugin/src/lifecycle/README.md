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
    and retains all operational state; the §9.3 refusal orchestration lives in
    `uninstall-release.ts`.
- `uninstall-release.ts` — `uninstallManagedVaultRelease(options)` (issue
  #200, spec §9.3) uninstalls the Release from one Managed Vault by removing
  only release-managed files while retaining all operational state for a
  lossless same-version reinstall. It composes the boundaries above and adds
  no second file-ownership implementation:
  - **Fail-closed safety gate**: uninstall refuses with a machine-actionable
    failure code whenever a Change Set is executing (live
    `queue.currentExecutionId` or a persisted registry entry in the
    `executing` phase), work is queued (a non-empty FIFO, live or persisted),
    recovery is in progress, unresolved, or blocked (live recovery state, a
    pending/failed Recovery Journal frame, a `result_unproven` Change Set
    record, a maintenance write mode or failed lifecycle in the persisted
    registry, or interrupted/failed `upgrade-state.json` evidence read through
    `readManagedVaultUpgradeEvidence`), or live and persisted evidence cannot
    positively prove the target safe — unavailable or contradictory evidence
    is a refusal, never a pass. A Vault whose plugin never loaded (no
    `data.json`, no Recovery Journal, no upgrade evidence, no answering
    Bridge) is provably free of queued work and recovery state, so its
    managed files may be removed.
  - **Managed-file-only deletion**: on success the removal is delegated to
    the installer's `removeReleaseManagedFiles`, which deletes only the
    allowlisted `manifest.json`, `main.js`, optional `styles.css`, and
    `checksums.sha256`; `data.json` (Vault identity, persistent port, FIFO
    queue, Submission Keys, Change Set records, settings), Recovery Journals,
    other plugins' storage, and Vault content survive byte-for-byte. A
    post-removal verification re-inspects the directory: any surviving
    allowlisted file fails the uninstall — partial filesystem failures are
    never reported as success.
  - **Deterministic reruns**: the typed outcome (`uninstalled` /
    `already_uninstalled` / `refused` / `failed` with failure codes) is
    machine-actionable; removal is idempotent, so rerunning after a failed or
    interrupted attempt completes it, and rerunning a completed uninstall
    reports `already_uninstalled`. Failure-injection hooks mirror the
    installer's interruption seams.
  - **Operator-controlled configuration**: Claude Code configuration is never
    read or modified. The result prints — but never executes — the exact
    operator command removing this Managed Vault's MCP registration
    (`createRegistrationRemovalCommand`, the `claude mcp remove` counterpart
    of `createRegistrationCommand` in `src/registration-command.ts`). No
    purge, force-removal, recovery-bypass, or state-deletion path is exposed.
  - **Lossless reinstall**: because all operational state is retained,
    reinstalling the same version through `installReleaseToManagedVaults`
    restores the same Vault identity, endpoint/port, retained
    queue/idempotency records, settings, and recovery state — never a fresh
    Managed Vault.
- `purge-release.ts` — `purgeManagedVaultState(options)` (issue #201, spec
  §9.3) is the **separate local interactive purge**: it intentionally removes
  one Managed Vault's operational state — Vault identity and persistent
  endpoint/port, FIFO queue and Change Set records, Submission Key records,
  settings (`data.json`), and every Recovery Journal — and is neither an
  uninstall flag nor a variant of `uninstallManagedVaultRelease`. It composes
  the boundaries above and adds no second file-ownership or evidence
  implementation:
  - **Enumeration before anything is written**: the operator-facing inventory
    names the Vault identity, persistent port, pending/retained FIFO and
    Change Set records, Submission Key records, the settings file, and every
    Recovery Journal file, each with byte count and SHA-256 digest, and spells
    out which capabilities are permanently lost (Vault identity,
    idempotency/Submission Key replay, queued work, recovery baselines).
  - **Verifiable backup before confirmation**: every byte slated for removal
    is copied into a fresh `purge-backup-<nonce>` directory under an
    operator-chosen backup root that must be absolute and outside the Vault
    (an unsafe location is a contract violation), with an `inventory.json`
    and a `checksums.sha256` manifest; the backup is then re-verified against
    the source state — a corrupt or incomplete backup fails the purge and
    nothing is deleted. There is no skip-backup path.
  - **Fail-closed recovery gate**: the same evidence standards as the
    uninstall safety gate — an executing or queued Change Set (live or
    persisted), live recovery state, a pending/failed Recovery Journal frame,
    a `result_unproven` record, a maintenance write mode or failed lifecycle
    in the persisted registry, interrupted/failed `upgrade-state.json`, or
    unavailable/contradictory evidence refuses the purge before any backup is
    written. No force or skip-recovery bypass exists.
  - **Explicit per-Vault confirmation**: deletion runs only after the
    operator's confirmation seam positively affirms the specific Vault
    identity/path carried in the confirmation request. A missing seam
    (`purge_confirmation_required`) or a declined/failed interaction
    (`purge_confirmation_declined`) changes none of the enumerated state; the
    retained verified backup is reported for a later confirmed run.
  - **Deletion and verification**: only the enumerated state is deleted —
    release-managed files, Vault content, and Claude Code local configuration
    are never touched. Post-deletion verification re-inspects the target; any
    surviving enumerated state fails the purge with the precise remainder and
    the backup disposition, so backup, verification, confirmation, or
    deletion failure never masquerades as a complete purge. Typed outcomes
    (`purged` / `already_purged` / `refused` / `failed`) make reruns
    deterministic and idempotent, and failure-injection hooks mirror the
    installer's interruption seams.
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

`src/installed-runtime/uninstall-scenario.ts` (issue #200) proves ordinary
uninstall end to end on the same seams: install → operator enablement →
Bridge start → registration command generation (never execution) → real work
through the MCP surface drained to terminal → offline uninstall removing only
release-managed files → lifecycle verification after removal (`not_installed`
with state retained byte-for-byte) → lossless same-version reinstall → the
restarted Bridge answers with the same Vault identity and endpoint, replays
the retained Submission Key to the drained Change Set instead of registering
fresh work, and projects `ready` after the operator's re-registration →
cleanup with no residue. It is likewise a composable input to #44.

`src/installed-runtime/purge-scenario.ts` (issue #201) proves the
backup-backed interactive purge end to end on the same seams: install →
operator enablement → Bridge start → registration command generation (never
execution) → work queued through the real MCP surface → purge refused while
work is queued (live and offline persisted evidence) → drained restart →
purge refused on an unresolved Recovery Journal frame → refused without a
confirmation seam and on operator cancellation with the state byte-identical
afterwards → ordinary uninstall → backup-backed confirmed purge tied to the
Vault identity → `not_installed` with the operational state gone, Vault
content intact, the backup independently re-verifiable, and a rerun reporting
`already_purged` → cleanup with no residue (the scenario's backups included).
It is likewise a composable input to #44.

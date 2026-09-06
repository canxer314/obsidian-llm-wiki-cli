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

## Installed-runtime scenario

`src/installed-runtime/lifecycle-scenario.ts` composes these operations over
the installed-runtime harness seams (issue #197): first install → explicit
operator enablement → Bridge start → registration command generation (never
execution) → `ready` → same-version `unchanged` → damage-and-repair with
state preservation → identity-mismatch projection → cleanup. It is exposed
for later composition by #44 and does not replace the harness corpus.

# Runtime durability probe — latest run

> PROTOTYPE evidence. Do not treat injected or manual checks as observed durability.

- Vault: `C:\Obsidian\ThinkFlywheelVault`
- Obsidian: 1.13.4 (installer 1.12.4)
- Node: v24.14.0
- Volume: NTFS
- Summary: {"pass":44,"native-seam-required":1,"not-run":1,"required-for-strong-claim":1}

## Checks

- **process-kill:create-markdown:before-prepared** — pass (observed)
- **process-kill:create-markdown:after-prepared** — pass (observed)
- **process-kill:create-markdown:after-mutation** — pass (observed)
- **process-kill:create-markdown:after-raw-verify** — pass (observed)
- **process-kill:create-markdown:after-committed** — pass (observed)
- **process-kill:modify-markdown:before-prepared** — pass (observed)
- **process-kill:modify-markdown:after-prepared** — pass (observed)
- **process-kill:modify-markdown:after-mutation** — pass (observed)
- **process-kill:modify-markdown:after-raw-verify** — pass (observed)
- **process-kill:modify-markdown:after-committed** — pass (observed)
- **process-kill:frontmatter-rewrite:before-prepared** — pass (observed)
- **process-kill:frontmatter-rewrite:after-prepared** — pass (observed)
- **process-kill:frontmatter-rewrite:after-mutation** — pass (observed)
- **process-kill:frontmatter-rewrite:after-raw-verify** — pass (observed)
- **process-kill:frontmatter-rewrite:after-committed** — pass (observed)
- **process-kill:derived-link-rewrite:before-prepared** — pass (observed)
- **process-kill:derived-link-rewrite:after-prepared** — pass (observed)
- **process-kill:derived-link-rewrite:after-mutation** — pass (observed)
- **process-kill:derived-link-rewrite:after-raw-verify** — pass (observed)
- **process-kill:derived-link-rewrite:after-committed** — pass (observed)
- **process-kill:attachment-write:before-prepared** — pass (observed)
- **process-kill:attachment-write:after-prepared** — pass (observed)
- **process-kill:attachment-write:after-mutation** — pass (observed)
- **process-kill:attachment-write:after-raw-verify** — pass (observed)
- **process-kill:attachment-write:after-committed** — pass (observed)
- **process-kill:same-volume-move:before-prepared** — pass (observed)
- **process-kill:same-volume-move:after-prepared** — pass (observed)
- **process-kill:same-volume-move:after-mutation** — pass (observed)
- **process-kill:same-volume-move:after-raw-verify** — pass (observed)
- **process-kill:same-volume-move:after-committed** — pass (observed)
- **process-kill:managed-trash:before-prepared** — pass (observed)
- **process-kill:managed-trash:after-prepared** — pass (observed)
- **process-kill:managed-trash:after-mutation** — pass (observed)
- **process-kill:managed-trash:after-raw-verify** — pass (observed)
- **process-kill:managed-trash:after-committed** — pass (observed)
- **journal:directory-sync** — native-seam-required (unsupported)
- **journal:truncation** — pass (observed)
- **journal:wrong-vault** — pass (observed)
- **journal:disk-full** — pass (injected)
- **plugin:reload-active-prepared** — pass (observed)
- **events:create-modify** — pass (observed)
- **events:rename-cache** — pass (observed)
- **events:managed-trash-rename** — pass (observed)
- **content:cjk-newlines** — pass (observed)
- **cache:targeted-link-probe** — pass (observed)
- **durability:hard-power-loss** — not-run (manual)
- **durability:native-write-through** — required-for-strong-claim (unsupported)

## Boundary verdict

Observed evidence supports process-termination recovery and evidence-gated cache readiness on this installed stack. It does not establish hard-power-loss durability. Use the ordering below as the candidate MVP gate:

1. Sync a complete, checksummed PREPARED frame in a preallocated journal slot before the first mutation.
2. Apply each mutation; for move/trash, preserve both source and destination footprints and do not rely on hidden paths remaining indexed.
3. Raw-reread every touched path and compare existence plus SHA-256 with expected-after.
4. Wait for operation-specific evidence: metadataCache.changed for create/modify; vault.rename for normal rename; path existence plus targeted cache/link probes for hidden managed-trash and restore.
5. Sync COMMITTED only after all raw and cache probes pass; only then acknowledge succeeded.
6. On rollback, compare-before-restore every footprint, raw-reread/hash the before state, repeat targeted cache probes, sync ROLLED_BACK, then acknowledge rolled_back.
7. Timeout or third-party state means failed/restoration_incomplete and keeps the write gate closed.

The observed cache convergence times in this run are in the machine-readable report. They are samples, not a production timeout budget. A stronger physical durability claim requires the VM matrix and potentially a native Windows write-through seam.

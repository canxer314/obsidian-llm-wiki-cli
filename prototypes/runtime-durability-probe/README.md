# Runtime Durability Probe (THROWAWAY)

## Question

Against the Primary Operator's installed Obsidian/Electron/Node runtime and the ThinkFlywheel Vault's NTFS volume, which Recovery Journal and cache-readiness evidence can safely gate acknowledgment of a Change Set or completed rollback, and which hard-power-loss claims remain unproved?

This is a Wayfinder logic prototype, not product code. It installs a temporary development plugin only while a run is active and writes test data only under `__llm_cli_runtime_probe__` in the ThinkFlywheel Vault. The plugin is removed after the run. The data directory is intentionally retained so evidence can be inspected. Every later run creates a unique, append-only `run-*` namespace and never deletes evidence from an earlier run.

## Run

Obsidian must be open with its CLI enabled:

```powershell
npm run prototype:runtime
```

Press `r` to execute the suite, `j`/`k` to select a check, `d` for its evidence, and `q` to quit.

For a non-interactive evidence capture:

```powershell
npm run prototype:runtime -- --run
```

The latest machine-readable and concise reports are written to `output/latest-report.json` and `output/latest-report.md`.

## Evidence vocabulary

- `observed`: this run exercised the installed runtime or NTFS volume and captured the result.
- `injected`: the harness exercised a failure path, but did not reproduce the corresponding physical condition.
- `manual`: a trustworthy run requires an external action, such as hard-powering off an isolated VM.
- `unsupported`: the installed public API does not expose the control needed to test or make the claim.

A passing injected check is not an observed durability result. A host process-kill is not a hard-power-loss result.

## VM hard-power-loss matrix

Use a disposable Windows VM whose virtual disk resides on storage representative of the target. Install the same Obsidian and Node versions, copy a synthetic Vault, and run each crash point at least 20 times:

1. before and after `PREPARED` slot `sync()`;
2. before and after each create, modify, rename, managed-trash rename, and derived-link rewrite;
3. after raw reread/hash and before cache readiness;
4. before and after `COMMITTED` slot `sync()`;
5. before and after each rollback mutation and `ROLLED_BACK` slot `sync()`.

At the selected point, power off the VM from the hypervisor without a guest shutdown. On boot, preserve the virtual disk before opening Obsidian, inspect both journal slots and all touched paths, then open Obsidian and run recovery/cache probes. Record whether the physical state is exact before, exact expected-after with durable `COMMITTED`, or neither.

Do not convert this matrix to `observed` evidence unless the VM was actually powered off at the hypervisor boundary. Do not run physical disk-full tests against the Primary Operator's real Vault volume; use a quota-limited disposable VHDX.

# PROTOTYPE — Vault read/search contract

This throwaway logic prototype asks whether a compact Claude Code-facing contract can represent deterministic discovery, bounded search context, heading-hierarchy sections, Exact Reads, ordered batches, Content Versions, and opaque continuation without hidden partial success. It uses an in-memory corpus shaped by the observed ThinkFlywheel Vault; it does not read or change the Vault.

Run from the repository root:

```powershell
python .scratch/reliable-vault-operations/prototypes/read-search-contract/prototype.py
```

The terminal redraws the complete request, response, snapshot, and continuation state after every action. Use the numbered scenarios to push the proposed contract through its hard cases.

The normative contract candidate and observations are in [`contract.md`](contract.md). The prototype is disposable and must not be used as production code.

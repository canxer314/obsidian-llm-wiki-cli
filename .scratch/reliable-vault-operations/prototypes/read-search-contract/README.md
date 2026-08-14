# PROTOTYPE — Vault read/search contract

This throwaway logic prototype asks whether a compact Claude Code-facing contract can represent deterministic composable discovery, bounded search context, heading-hierarchy sections, Exact Reads, ordered batches with duplicate paths, Content Versions, opaque single-use continuation, and transport pages that use their available envelope capacity without splitting UTF-8. It uses only an in-memory corpus shaped by the observed ThinkFlywheel Vault; it does not read or change the Vault.

## Run

From the repository root:

```powershell
python .scratch/reliable-vault-operations/prototypes/read-search-contract/prototype.py
```

The terminal redraws the complete request, response, revision, Content Versions, and active/consumed/snapshot-unavailable continuation state after every action. Long Exact Read text is folded only in the terminal display; the in-memory response retains the real content.

Run the independent automatic check with:

```powershell
python .scratch/reliable-vault-operations/prototypes/read-search-contract/prototype.py --check
```

A successful check ends with:

```text
all round-3 prototype scenarios passed
```

The check proves that every compact JSON response stays within its requested transport limit; the first page contains request indices `0`, `1`, and the first partial chunk of `2`; each chunk starts at the previous byte offset; repeated paths remain distinct by request index; all chunks reconstruct the original UTF-8 bytes including CRLF; logical over-limit batches return no content; unknown, consumed, and snapshot-unavailable tokens receive distinct errors; and running the check for display does not reset the interactive revision, Content Versions, or continuation lifecycle state.

## Round-3 manual review

Drive these short sequences separately. Use `r` before a sequence when specified so its preconditions are visible rather than inherited from an earlier scenario.

### 1. Discovery and heading addressing: `1`, then `2`

After `1`, expect one matching `Tasks/` note from an `all(path + text)` query. The result includes bounded context, outline hierarchy and occurrence, Content Version, UTF-8 offsets, and deterministic path ordering.

After `2`, expect `ambiguous_heading` with occurrence candidates `1` and `2`; the prototype never silently chooses a repeated complete hierarchy.

### 2. Filled first Exact Read page: `r`, then `3`

Scenario `3` requests the same small path twice, followed by a large CRLF note, under an 8,000-byte response ceiling.

Expect:

- `Actual compact JSON response bytes` is `7998 / 8000` for the current corpus and compact envelope;
- `result.items` contains indices `0`, `1`, and `2` in that order;
- indices `0` and `1` are complete and remain separate despite sharing a path;
- index `2` is a nonempty partial chunk beginning at byte offset `0`;
- an opaque active continuation records the next byte offset for index `2`.

This is the round-three pagination correction: a page with complete earlier items uses its remaining capacity for the next item's longest legal UTF-8 prefix instead of stopping early.

### 3. Consumed versus unknown tokens: continue with `4`, then `5`, then `6`

After `4`, the original active token has been consumed exactly once, appears in `Consumed tokens`, and a new active token carries the next page.

After `5`, expect `continuation_consumed` for the most recently consumed token. The still-active replacement token remains available.

After `6`, expect `invalid_continuation` for the explicit `opaque:never-issued` token. This action cannot silently substitute an unavailable or placeholder token.

You may press `4` repeatedly afterward. Every page must remain at or below 8,000 bytes, offsets must advance contiguously, and the final page must report `continuation: null` and `complete: true`.

### 4. Logical batch rejection: `7`

Expect `exact_read_batch_too_large`. Two duplicate-path requests remain distinct as indices `0` and `1`; the whole batch is rejected, no content is returned, and suggested groups preserve input order. This remains separate from successful transport continuation.

### 5. Snapshot loss and sanity isolation: `r`, `3`, `8`, `9`, then `s`

After `3`, note revision `0`, the large note's Content Version, and the active token. `8` simulates an external edit entirely in memory. Expect revision `1`, a changed Content Version, and the old token under `Snapshot-unavailable tokens`.

After `9`, expect `continuation_snapshot_unavailable`; delivery never restarts against the edited bytes.

Before pressing `s`, note revision `1`, the changed large-note Content Version, and the lifecycle lists. After `s`, expect the automatic summary while all of those values remain unchanged. The check runs against its own fresh corpus and only replaces the displayed last request/response.

Expected automatic evidence includes:

- 11 bounded Exact Read pages and 13 chunks for the current corpus;
- 75,578 reconstructed Exact Read bytes;
- a 7,998-byte first page containing indices `0`, `1`, and `2`;
- whole-batch logical rejection;
- distinct unknown, consumed, and snapshot-unavailable continuation classifications;
- preserved interactive revision, versions, and token state.

Use `r` at any time to deliberately restore the original in-memory corpus and state. Use `q` to quit.

## Scope

The normative contract candidate and corpus observations are in [`contract.md`](contract.md). This prototype is disposable, is not production code, and intentionally does not access the real Vault. It does not simulate time or claim evidence for `continuation_expired`; that code remains a required installed-runtime error classification. The decision ticket remains `claimed` until the Primary Operator reviews this third round.

# Reliable Claude Code Vault Operations — development-ready MVP specification

> **Status:** Development-ready. This specification incorporates every product and technical decision resolved by the Wayfinder map through [Finalize the development-ready MVP specification](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/27). Development planning may decompose and sequence the implementation, but it must not reopen or silently weaken the public contract, safety invariants, acceptance matrix, benchmark corpus, exclusions, or release gates fixed here.

## 1. Destination and precedence

The MVP provides a reliable, efficient Windows operation channel through which Claude Code can discover, read, change, and verify one or more independently managed Obsidian Vaults. Every Agent Session, request, Change Set, queue, identity, and recovery action belongs to exactly one Managed Vault.

This document uses the following precedence rules when an earlier decision was explicitly refined later:

1. [Define installation, trust, and operations](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/9) replaces the earlier single-Vault, single-endpoint, and mandatory-bearer requirements with per-Managed-Vault Bridge Instances and a no-credential single-user loopback default.
2. [Define the cross-tool error and retry taxonomy](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12) replaces earlier public Change Set lifecycle and generic error envelopes with four proof states and narrow closed failures. Internal executor and journal phases remain implementation state and are not public Change Set states.
3. [Define operational gate result semantics](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/23) keeps operational gates separate from request and Change Set failures and fixes their per-tool projections, Submission Key consequences, precedence, and MCP `isError` mappings.
4. [Specify Change Set success reporting and single-file policy](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/24) requires every Bridge mutation to use a Change Set and fixes canonical Content Versions, immutable previews, requested and derived effect evidence, and authoritative final-path evidence.
5. [Prototype the complete public wire schema](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/25) fixes a versioned contract package as the single source of truth, the six-tool inventory, strict closed structural validation, the diagnostics/recovery authority boundary, and the internal Search Snapshot boundary.
6. [Fix measurable MVP performance release gates](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/26) fixes deterministic fixtures, timing boundaries, the `MVP-PERF-REF-1` environment, the 3 × 30 nearest-rank p95 procedure, thresholds, evidence manifests, and rebaseline policy.
7. Installed-runtime validation fixes operating constants and supported runtime profiles without broadening the product boundary.

## 2. Domain language

- **Primary Operator:** the sole MVP user, operating one or more Managed Vaults through Claude Code. A general plugin-market audience is not the design target.
- **Open Vault:** an Obsidian Vault loaded by an Obsidian app instance. An Open Vault is not necessarily managed.
- **Managed Vault:** an Open Vault in which the Primary Operator enabled and initialized the Vault Operation Bridge. It is an independent operation and recovery boundary.
- **Vault Operation Bridge:** the agent-first interface through which Claude Code discovers, reads, changes, and verifies one Managed Vault.
- **Bridge Instance:** one running Vault Operation Bridge belonging to exactly one Managed Vault.
- **Multi-Vault Coexistence:** multiple Managed Vaults may be independently operable at once. It never permits one operation to span Vaults.
- **Change Set:** related mutations within one Managed Vault, validated and previewed as one unit, which either satisfy the complete intent or restore the pre-execution state.
- **Exact Read:** a single-note or ordered multi-note read returning complete, untrimmed content without silent excerpting or normalization. Transport pages do not alter this semantic.
- **Content Version:** the identity of one Markdown note's exact raw bytes, encoded on the wire only as `sha256:<64 lowercase hexadecimal digits>`. Bare digests, uppercase hexadecimal, whitespace, wrong lengths, and non-hexadecimal characters are rejected rather than normalized. Binary attachments use their separate SHA-256 evidence and never a Content Version.
- **Agent Session:** one Claude Code session bound to one Bridge Instance for its lifetime.
- **Submission Key:** an Agent Session-generated idempotency identity for one canonical Change Set request.
- **Read Dependency:** an observed note and Content Version that informed a Change Set without being directly modified.
- **Recovery Journal:** short-lived durable state used to restore an interrupted Change Set; it is not audit history or version history.
- **Search Snapshot:** a Bridge-owned immutable, Content-Versioned search/index view published atomically by a Bridge Instance.

## 3. Product boundary

### 3.1 In scope

- Multiple independent Managed Vaults on one private, single-user Windows machine.
- Multiple concurrent Agent Sessions against the same or different Managed Vaults.
- Deterministic discovery over canonical paths, names, literal or regular-expression text, typed Frontmatter, tags, registered references, backlinks, unresolved links, and graph predicates.
- Metadata, outline, heading-section, and Exact Read observations.
- Atomic-intent Change Sets containing directory/note creation, body and Frontmatter edits, same-volume moves, attachment copies/moves, derived registered-reference rewrites, and reversible managed trash.
- Idempotent submission, FIFO execution per Vault, process-crash recovery, read-after-success visibility, health, maintenance, pause/resume, recovery diagnosis, and privacy-preserving diagnostics.

### 3.2 Explicit exclusions

- Semantic/vector search, embeddings, or RAG.
- Encoding `llm-wiki` methodology, naming policy, or knowledge-workflow policy in the operation layer.
- Any cross-Vault discovery, read, Change Set, transaction, reference resolution, recovery, or atomicity.
- A machine-level broker, launcher, watchdog, or background daemon.
- Offline operation when Obsidian or the target Vault is closed.
- A general-purpose Obsidian control UI beyond focused operation and recovery controls.
- Permanent deletion, persistent audit history, Git staging/committing, or Git-backed rollback.
- Editing or semantically parsing non-Markdown attachment contents.
- Dedicated block-ID reads.
- Silent truncation, lossy Unicode/newline normalization, or fallback to shell/direct-filesystem mutation.
- Any seventh public MCP tool, public recovery-mutation endpoint, public Search Snapshot handle, or independently callable Search Snapshot capability.
- Agent Session authority to accept a recovery baseline, clear or release recovery state, or resume writes.
- Treating JSON Schema validation as proof of raw-byte fidelity, continuation ownership/lifetime, Submission Key persistence, recovery ordering, semantic cache/graph convergence, diagnostic privacy, or performance.
- A claim of Obsidian-native multi-file transactions, globally atomic metadata/link graphs, external-writer exclusion, unconditional ACID, or hard-power-loss durability.
- Automatic diagnostics upload, telemetry, or content-inclusive diagnostics initiated by an Agent Session.

## 4. Runtime architecture and trust boundary

### 4.1 Bridge topology

- Each enabled Open Vault runs one plugin-hosted Bridge Instance.
- The plugin is the only semantic authority for Obsidian `App`, `Vault`, `MetadataCache`, reference interpretation, Search Snapshots, Content Versions, Change Set execution, and Recovery Journal state.
- The primary transport is Streamable HTTP MCP at `127.0.0.1:<persistent-port>/mcp`.
- A companion process is only a contingency if the supported installed Obsidian runtime cannot host the listener. A companion may transport requests but may not directly read or write Vault content or own Vault semantics.
- The Bridge exists only while its Vault is open and the plugin is loaded. Unavailability fails clearly; no shell fallback is permitted.

### 4.2 Vault and session identity

- Initialization generates a random persistent Vault ID and selects a persistent port per Managed Vault.
- The Claude Code MCP definition is stored at `local` scope and includes the expected Vault ID.
- MCP initialization and every tool entry compare expected and actual Vault IDs. Missing or mismatched identity rejects the whole connection without read-only degradation.
- Content tools do not accept `vault_id`; the endpoint already determines the Vault.
- An Agent Session starts from the target Vault directory, binds one Bridge Instance, and cannot switch Vaults.
- Port conflict fails closed; the Bridge does not silently select a different port.
- A detected Vault path change pauses operation until the Primary Operator classifies it as:
  - `move`: retain Vault ID and update the diagnostic path;
  - `copy`: generate a new Vault ID, port, and local MCP registration.

### 4.3 Local trust

- The private, single-user loopback MVP has no application-layer credential by default.
- The Bridge must bind and runtime-verify `127.0.0.1`, validate `Host` and `Origin`, and disable permissive CORS.
- Vault ID is an identity assertion, not a secret.
- An authentication seam is mandatory. Authentication becomes required for any non-loopback exposure, container forwarding, multi-user isolation, or client revocation requirement.

## 5. Safety invariants

The following invariants are release-blocking:

1. A request, Change Set, queue record, Submission Key, Search Snapshot, Recovery Journal, and recovery action belongs to one Vault.
2. Exact Read and mutation preimages come from raw binary reads. `Vault.read()` cannot be used because it removes a UTF-8 BOM.
3. Content Versions hash exact bytes, not text normalized by Obsidian or JavaScript.
4. A stale direct target, Read Dependency, attachment hash, derived target, or absence precondition rejects the complete Change Set before its first Vault mutation.
5. All requested and derived mutations execute under one per-Vault serial write lease.
6. A durable complete `PREPARED` Recovery Journal frame precedes the first mutation.
7. `intent_applied` is reported only after expected final bytes, required runtime semantic evidence, Search Snapshot publication, and durable `COMMITTED` are complete.
8. `intent_not_applied` is reported only after the Bridge proves no partial effect remains.
9. If neither complete application nor absence of partial effects can be proved, the state is `result_unproven` and the Vault-wide write gate is blocked.
10. Recovery never overwrites third-party state: every restore is compare-before-restore.
11. Managed trash is reversible and Bridge-owned; permanent deletion is unavailable.
12. Symlinks or junctions may never escape the Vault. `.git/`, `.obsidian/`, Bridge private state, and managed trash are protected.
13. Staging and half-written Markdown must never be visible inside the Vault: mutations either avoid staging files or stage only in plugin-private, non-Vault-indexed storage so other enabled plugins cannot observe intermediate paths/content.
14. Unrecognized reference grammar, ambiguous target/span, invalid UTF-8, unsupported runtime behavior, and cache/graph timeout fail closed.
15. A successful or fully restored Change Set is visible to subsequent Bridge discovery and reads.

## 6. MCP and operator surface

The complete public MCP inventory contains exactly six tools:

- `vault_health`
- `vault_discover`
- `vault_read`
- `vault_continue`
- `vault_change_set_submit`
- `vault_change_set_status`

The authoritative public contract is one versioned package containing strict per-tool input/output roots, shared `$defs`, valid and invalid fixtures, and a cross-call scenario manifest. Every object root rejects unknown fields. JSON Schema owns closed structural validation and examples; the contract/runtime corpora own continuation identity and lifetime, Submission Key ordering and persistence, raw-byte fidelity, WAL/recovery ordering, cache/graph proof, MCP dual-representation identity, privacy, and performance gates.

Within public MCP, the privacy-preserving diagnostic summary is exactly the `vault_health` observed branch's `overall`, closed machine `reasonCodes`, and prescribed `operatorAction`; it does not add a health input mode, result branch, free-form text, stack, timeline, path, or identifier field. The richer standard diagnostic bundle is generated only through the local interactive management entry point described in §9.4 and is not an Agent Session request or a seventh MCP tool. Accepting a trusted recovery baseline and resuming writes are also separate Primary Operator actions at that local entry point, never public MCP mutations. Search Snapshot is an internal success-proof barrier, not a public MCP operation.

### 6.1 `vault_health`

Every Agent Session calls health after connection/reconnection and before content tools, and again after plugin upgrade, Vault move/copy handling, endpoint change, recovery, or maintenance resume. The server independently rechecks identity and gates at every tool entry; health is observational, not a client-side security boundary or an implicit second gate.

Health has two trusted branches:

```text
HealthResult =
  | { outcome: "observed"; effectiveGate: OperationalGateWithoutIncompatible | null; ...normalHealthState }
  | { outcome: "incompatible"; gate: { code: "incompatible_protocol" }; compatibility: ClosedCompatibilitySummary }
```

Both use `isError: false`. On the observed branch, `overall`, machine-readable `reasonCodes`, and `operatorAction` are the complete privacy-preserving diagnostic summary available to an Agent Session; they contain no free-form detail and prescribe, but never authorize, a local action. The observed branch reports at least:

- actual Vault ID plus diagnostic name/path;
- Bridge, plugin, protocol, persistent-state, and Recovery Journal schema versions;
- actual listener address and port;
- Search Snapshot, cache, and index readiness;
- recovery state;
- write state and pause/maintenance source;
- current execution identity, queue length, and queue head;
- last startup, upgrade, migration, and recovery outcome;
- overall `healthy | degraded | blocked`, machine reason codes, and prescribed operator action.

Endpoint connection failure means `offline`; it is distinct from a connected Bridge reporting `blocked`.

Protocol compatibility uses an explicit supported major/minor range rather than exact plugin-version equality. Compatible plugin versions may operate while health reports an upgrade notice. Compatibility has two boundaries:

1. If caller and Bridge cannot safely share the MCP tool schema, initialization fails and no product tool result or product-level `isError` mapping exists.
2. If the MCP tool schema is shared but the connected plugin, protocol participant, persistent-state schema, or Recovery Journal is incompatible, the restricted connection retains only the minimal incompatible health branch. Every other public tool returns `OperationallyBlocked` with `incompatible_protocol`; this is not read-only content degradation.

The incompatible health branch contains only closed local/peer version and supported-range facts. It must not read incompatible persistent/Journal state or claim recovery, queue, or Change Set knowledge.

### 6.2 `vault_discover`

- The request supports recursive Boolean composition of path, filename, literal/regular-expression text, typed Frontmatter, tag, reference, backlink, unresolved-link, and graph predicates.
- A projection may combine identity, bounded match context, outline, Frontmatter, and registered-reference evidence in one call.
- Sorting is declared and deterministic.
- Every evidence-bearing note includes canonical `path`, exact-byte `contentVersion`, and `sizeBytes`.
- No match is a successful empty collection (`isError: false`).
- Discovery observes one immutable Search Snapshot. It does not imply one cross-note filesystem instant shared with a later call.
- Pagination/continuation may transport a frozen result but must not alter query, projection, order, Content Versions, or evidence.

### 6.3 `vault_read`

A request is an ordered heterogeneous list of metadata, outline, section, and Exact Read items. Duplicate paths remain distinct by request index.

Section selectors are `path + heading hierarchy + mandatory one-based occurrence`. An unsatisfied selector does not fall back to another occurrence, adjacent section, combined content, or the whole note.

The fixed outer result is:

```text
ReadResult =
  | { outcome: "items"; items: ReadItemResult[] }
  | { outcome: "grouping_required"; suggestedGroups: Group[] }

ReadItemResult =
  | { outcome: "satisfied"; result: TypedReadResult }
  | { outcome: "not_satisfied" }
  | { outcome: "note_exceeds_exact_read_limit" }
```

Rules:

- `items` has exactly one item per request index and uses `isError: false`, even if none is satisfied.
- Each satisfied item is an independent valid observation whose content and Content Version come from one frozen raw-byte snapshot.
- `not_satisfied` is not empty content and cannot become a Read Dependency.
- An Exact Read preserves raw UTF-8 bytes, BOM, and newline spelling without excerpt or normalization.
- A single note over 1 MiB yields `note_exceeds_exact_read_limit`; grouping and continuation cannot bypass it.
- A multi-note Exact Read whose logical total exceeds 1 MiB returns no content and `grouping_required` with deterministic, complete, ordered, contiguous request-index groups, each at most 1 MiB. It uses `isError: true`.
- A heterogeneous result may satisfy some items and not others; later Change Sets guard each used observation independently.

### 6.4 `vault_continue`

- Continuation only transports an already accepted frozen result.
- Tokens are opaque, client-bound, single-use, and have a 15-minute sliding lifetime from issuance or replacement.
- A page identifies request index, path, Content Version, inclusive start and exclusive end UTF-8 byte offsets, exact content, and item completion.
- Pages use contiguous ranges; concatenation reconstructs the exact original bytes.
- Each response is no larger than 256 KiB compact JSON and fills the next legal UTF-8 prefix as fully as possible.
- Consumption, expiry, client/session teardown, or snapshot loss immediately releases retained bytes.
- Each client is limited to 8 active continuation chains and 8 MiB retained frozen bytes. Quota exhaustion rejects new issuance and never silently evicts a live token.
- When no effective operational gate blocks content, the only trusted request-level continuation failure is `{ code: "continuation_unavailable" }` with `isError: true`. The client discards all pages from the old chain and repeats the original `vault_read`.
- When an effective gate blocks content, continuation returns `OperationallyBlocked` with `isError: true`; it never masquerades as `continuation_unavailable`.
- If a continuation call produces no trustworthy result, retry once with the same token because consumption is unknown.

### 6.5 `vault_change_set_submit`

One call performs validation, non-interactive preflight, registration, queueing, execution/recovery advancement, and current-result reporting. There is no separate validate/preview/apply approval protocol.

The request contains:

- non-empty Agent Session-generated `submissionKey`;
- non-empty ordered `operations`, each with a request-unique `operationId`;
- optional deduplicated `readDependencies: [{ path, contentVersion }]`.

All paths are canonical Vault-relative `/` paths. Absolute paths, case folding, and Unicode/newline normalization are forbidden.

Operation kinds are closed:

- `create_directory`
- `create_note`
- `edit_body`
- `edit_frontmatter`
- `move`
- `copy_attachment`
- `move_attachment`
- `trash`

Fixed preconditions:

- Creates carry exact content when applicable and `ifExists: "reject"`.
- `edit_body` carries `targetVersion` and either:
  - `replace_exact` with exact old/new bytes and `expectedOccurrences: 1`; or
  - `replace_whole`.
- `edit_frontmatter` carries `targetVersion` and ordered typed `set`/`remove` changes while preserving untouched bytes and formatting.
- Move/trash carries source `targetVersion`.
- Note move uses `linkEffect: "update_resolved_references"`; the caller does not enumerate backlinks.
- Existing attachment sources carry `expectedSha256`; destination collision rejects.
- Multiple operations that touch one path are allowed only when a later operation references an earlier `operationId` and preflight derives one unambiguous version chain.
- A direct target cannot also appear as a Read Dependency.

Preflight runs before queue admission and again under the serial lease immediately before the first mutation. It validates every version, dependency, path, containment rule, protected location, collision, anchor cardinality, Frontmatter representation, parent-directory effect, derived reference closure, and absence precondition.

The public proof record is:

```text
ChangeSetRecord =
  | { changeSetId; state: "in_progress"; preview?: ImmutablePreview }
  | { changeSetId; state: "intent_applied"; preview: ImmutablePreview; requestedEffects; derivedEffects; paths }
  | { changeSetId; state: "intent_not_applied"; preview?: ImmutablePreview; failure?: ChangeSetFailure }
  | { changeSetId; state: "result_unproven"; preview?: ImmutablePreview }

VaultState = {
  writeGate: "open" | "blocked"
  writeState: "writable" | "pausing" | "paused"
}
```

Allowed stable failures are:

```text
ChangeSetFailure =
  | { code: "stale_observation" }
  | { code: "exact_match_count_mismatch"; operationId; actualOccurrences }
  | { code: "path_conflict"; operationId; path }

SubmitFailure = { code: "submission_key_conflict" }
```

The submit result is a closed union of structural invalidity, Submission Key conflict, an operationally blocked unbound request, and a registered Change Set result. Operational gates are not `ChangeSetFailure` or `SubmitFailure` values. `in_progress` and `intent_applied` use `isError: false`; `intent_not_applied`, `result_unproven`, `request_invalid`, `submission_key_conflict`, every submit `operationally_blocked` branch, and a newly registered recovery-blocked `intent_not_applied` result use `isError: true`. Same-key replay uses the replayed proof state's mapping.

Every Bridge mutation uses this tool, including a Change Set with one requested operation affecting one file. There is no direct or lightweight single-file mutation exception.

The first complete successful preflight freezes and persists one immutable automatic preview; it is not an approval token. Lease-time revalidation validates exactly that plan and may not expand or replace it. If closure, target state, or another premise changed, no mutation occurs and the caller must re-read and submit a corrected plan with a new Submission Key. A record before complete preflight and an initial rejection that could not establish a safe complete plan have no fabricated preview. Once frozen, the preview is identical in subsequent submit/status/replay views for at least the complete-record retention period.

The preview and an `intent_applied` result use the same deterministic effect IDs, causation, ordering, and path keys:

- requested effects contain exactly one entry per caller operation in request order, retaining `operationId` and `kind`;
- derived effects contain exactly one entry per frozen derived effect in deterministic Bridge order, with stable `operationId` and `causedByOperationId`;
- each successful effect outcome is only `changed` or `already_satisfied`; process labels such as written, skipped, recovered, or replayed are not public outcomes;
- the preview supplies projected outcomes plus one deduplicated pre-state/projected-final-state path table; the final result supplies proven outcomes and final states;
- an `intent_applied` result has one authoritative, deterministically ordered path table covering every public path relevant to requested and derived effects, including no-op targets, but excluding Read Dependencies and merely read/locked paths;
- each path is `changed` or `unchanged` and ends in exactly one typed state: Markdown with canonical Content Version, attachment with SHA-256 evidence, directory, or absent;
- move reports the old path absent and the destination's typed state; trash reports only the original public path absent; managed-trash internal paths are private; derived Markdown rewrites carry final Content Versions; directories appear only when actually created; intermediate versions never appear as final;
- “changed paths” is only the projection of path entries marked `changed`, never a second authority.

A non-successful proof branch reports no partial-success effect algebra. Typed preview warnings may advise but cannot permit an unlisted mutation or substitute for rejection.

### 6.6 `vault_change_set_status`

The request supplies exactly one of `submissionKey` or `changeSetId`.

```text
StatusResult =
  | { lookup: "found"; changeSet: ChangeSetRecord; vault: VaultState }
  | { lookup: "unknown"; vault: VaultState }
  | { lookup: "expired"; vault: VaultState }
```

All branches use `isError: false`, regardless of a found record state.

- `unknown` proves only that no full record or tombstone was found.
- `expired` proves only that the identifier once existed and the full record is no longer retained.
- Neither proves that a submit did not arrive or that no mutation occurred.
- Accepted Submission Keys and complete records persist at least seven days across Bridge/Obsidian restart and Agent Session disconnect.
- Within seven days, record loss/corruption must be recovered or become `result_unproven` with a blocked gate; it cannot be reported as ordinary `unknown`.
- An `unknown` key permits checking the identical request with the same key only when the client proves the first send was less than seven days ago and the write gate is open. `expired`, uncertain/elapsed time, or a lost original request forbids automatic replay.

### 6.7 Trustworthy versus absent results

A complete value conforming to a tool's closed result schema is authoritative even when `isError: true`. `structuredContent` is authoritative; any compatibility text is an identical serialization.

An internal exception, protocol failure, truncated response, schema-invalid value, or mismatch between structured and text representations means no trustworthy product result. Safe handling is fixed:

- discover/read: discard partial output and perform only bounded availability retries; never combine calls;
- continue: retry with the exact same token;
- submit: query the original Submission Key or check the identical request with the identical key; never switch keys;
- status: preserve existing knowledge and query again;
- recovery: retain the blocked gate until a trustworthy recovery result exists.

Runtime results do not expose generic `action`, `guidance`, `retryable`, `retryAfter`, `message`, `details`, `phase`, conflict arrays, stack traces, or internal causes.

## 7. Change Set execution, idempotency, and recovery

### 7.1 Admission and FIFO execution

- Each Bridge Instance owns one persisted `enqueueSeq` FIFO queue and one executor.
- Reads and discovery may run concurrently. Change Sets within one Vault execute serially. Different Vaults may execute independently.
- Before mutation, admission persists `Submission Key -> canonical request fingerprint -> changeSetId`.
- Same key and same fingerprint returns the existing identity/current proof state without requeueing.
- Same key and a different fingerprint returns `submission_key_conflict` without changing the old record.
- A queued item re-runs full preflight under the write lease.

### 7.2 Internal execution phases versus public proof states

Executor and journal phases such as `preflighting`, `queued`, `executing`, `recovering`, `PREPARED`, `COMMITTED`, `ROLLED_BACK`, and `FAILED` may exist internally and in operator diagnostics. They do not replace the public four-state proof record:

- internal work that the Bridge can still advance maps to `in_progress`;
- durable complete intent proof maps to `intent_applied`;
- rejected/no-op rollback/complete restoration proof maps to `intent_not_applied`;
- inability to prove either side maps to `result_unproven`.

Ordinary `failure` is only allowed on `intent_not_applied`, and only when one of the three narrow stable failures applies.

### 7.3 Recovery Journal ordering

The plugin-private journal is a versioned, length-delimited, checksummed framed write-ahead log using preallocated double slots and file sync. It records the complete requested and derived plan, touched-path before image or absence, expected-after state, attachment hashes, move/trash mappings, final Content Versions, and required semantic evidence.

The order is mandatory:

1. Persist Submission Key binding and Change Set identity.
2. Acquire the serial write lease and re-run preflight.
3. Capture the complete before/absence/expected-after footprint.
4. Sync a complete `PREPARED` frame.
5. Apply mutations.
6. Raw-reread and verify every final path/existence/hash.
7. Await operation-specific metadata/reference evidence and publish the successor Search Snapshot.
8. Sync `COMMITTED`.
9. Report `intent_applied`.

On failure:

1. Compare every current footprint with expected-after or before state.
2. Restore only values still safe to restore.
3. Raw-reread/hash the full before state and await targeted semantic evidence.
4. Sync `ROLLED_BACK` and report `intent_not_applied` only when no partial effect remains.
5. Otherwise sync failure evidence, report `result_unproven`, and block the Vault-wide write gate.

### 7.4 Startup recovery

A durable `PREPARED` without a durable terminal frame forces whole-Change-Set restoration before any new write. Mutation-progress guesses are forbidden; even a current expected-after state is restored to before state unless `COMMITTED` is durable.

Compare-before-restore rules:

- current equals expected-after: restore before image;
- current equals before: treat that footprint as already restored;
- current is any third-party state: do not overwrite; record observed/expected hashes, become `result_unproven`, and block writes.

The MVP guarantee is bounded process-crash all-or-restore on the validated Windows/NTFS runtime. Hard-power-loss durability and native Windows write-through are expressly outside the claim.

### 7.5 Operational gates

Operational gates form a separate closed algebra rather than extending any request or Change Set failure taxonomy:

```text
OperationalGate =
  | { code: "writes_paused" }
  | { code: "upgrade_in_progress" }
  | { code: "recovery_in_progress" }
  | { code: "recovery_blocked" }
  | { code: "incompatible_protocol" }

OperationallyBlocked = {
  outcome: "operationally_blocked"
  gate: OperationalGate
}
```

An ordinary result exposes at most one effective gate, selected in this precedence order:

```text
incompatible_protocol
> recovery_blocked
> recovery_in_progress
> upgrade_in_progress
> writes_paused
```

Manual `pausing` and `paused` project to `writes_paused`. `maintenance_pending`, upgrade draining, migration, and upgrade execution project to `upgrade_in_progress`; a trustworthy `maintenance_paused` projects to `writes_paused`, with health retaining its post-upgrade pause source. An unresolved `result_unproven` safety block projects to `recovery_blocked`, not a new code.

The per-tool behavior is fixed:

| Effective gate | `vault_health` | discovery / read / continue | submit with unbound key | status |
|---|---|---|---|---|
| `writes_paused` | observe, `isError: false` | execute | blocked; do not bind/register; `isError: true` | query, `isError: false` |
| `upgrade_in_progress` | observe, `isError: false` | execute | blocked; do not bind/register; `isError: true` | query, `isError: false` |
| `recovery_in_progress` | observe, `isError: false` | blocked, `isError: true` | blocked; do not bind/register; `isError: true` | query, `isError: false` |
| `recovery_blocked` | observe, `isError: false` | blocked, `isError: true` | bind/register `intent_not_applied` without `failure`, return current Vault state plus historical gate; `isError: true` | query, `isError: false` |
| connected `incompatible_protocol` | minimal incompatible branch, `isError: false` | blocked, `isError: true` | neither inspect nor bind; `isError: true` | blocked, `isError: true` |

Health has a normal `observed` branch with `effectiveGate` (excluding incompatible) and an `incompatible` branch containing only closed local/peer version and supported-range facts. The latter must not read incompatible persistent/Journal state or claim queue, recovery, or Change Set knowledge. If caller and Bridge cannot safely share the MCP tool schema, initialization itself fails and no product result or product-level `isError` mapping exists.

Except under `incompatible_protocol`, submission processing is ordered: validate structure and fingerprint without target reads; look up the Submission Key; replay an identical binding or reject a conflicting binding; apply the current gate only to an unbound key; then, only if permitted, inspect targets, preflight, and enqueue. The incompatible branch cannot safely inspect the registry and skips lookup.

A `recovery_blocked` submission uniquely binds the key and persists an `intent_not_applied` record without `failure`; its gate is historical submission provenance and replays even after recovery, while `vault` always reports current state. Status omits that historical disposition. Renewing the write after recovery requires a new key. Other gate-blocked submissions create no Change Set or proof state and may retry the unchanged key after the gate clears. After compatibility is fixed and the client reconnects, the original uninspected key may retry.

`writeGate`, `writeState`, and `effectiveGate` remain distinct. Every unresolved `result_unproven` and `recovery_blocked` condition requires `writeGate: "blocked"`; pause/upgrade may reject new writes while that safety gate remains open. No result adds `retryable`, `retryAfter`, generic guidance, or gate arrays. A blocked content call never masquerades as `continuation_unavailable` or another request failure.

## 8. Raw bytes, references, and Search Snapshot consistency

### 8.1 Raw-byte adapter

- Exact Read and rewrite preimages use `adapter.readBinary`; writes use `writeBinary`/binary creation.
- Markdown bytes must strictly decode as UTF-8. Invalid UTF-8 rejects without mutation.
- `MetadataCache.Pos` is only a locator in BOM-stripped host text measured in UTF-16 code units. It is never a UTF-8 byte offset; astral characters consume two host units.
- The Bridge derives bounded host candidates, maps UTF-16 boundaries to UTF-8 byte boundaries, and accepts a span only when exactly one candidate both decodes to cache `original` and equals the corresponding raw byte slice.
- Zero or multiple verified candidates rejects the rewrite.
- A rewrite splices only the verified byte range; all untouched prefix/suffix bytes remain exact. The Bridge then rereads and verifies final bytes/hash.

### 8.2 Registered-reference profiles

The registry is closed, versioned, and validated against the installed runtime. Each profile separately defines runtime target interpretation, source grammar/span location, and destination renderer.

- Registered from installed evidence: wikilink, embed, Markdown inline link, and Markdown embed.
- Conditional on independent raw-byte location/pairing corpus: Frontmatter references and reference-style Markdown.
- Renderers replace only the destination component and preserve wrapper/style. Existing references are never normalized as preparation for a move.
- Wikilinks and angle-wrapped Markdown preserve literal spaces; unwrapped Markdown emits `%20`; malformed unwrapped destinations with literal spaces reject.
- Candidate enumeration must yield exactly one canonical target and agree with installed runtime resolution.
- Duplicate basenames, duplicate headings, unknown grammar, invalid fragments, and unsupported spans reject.
- Only the installed-runtime-observed ASCII block-ID form is registered. Section occurrence and unobserved Unicode block IDs are not renderable promises.
- Literal-`#` attachment references reject in the validated profile; the Bridge does not invent escaping.
- Derived reference rewrites are explicit Change Set effects. Correctness never depends on Obsidian's automatic-link-update preference.

### 8.3 Success barrier and Search Snapshot

After mutation and raw verification, success requires a Content-Version-bound composite barrier:

1. Every expected final path/existence/hash matches.
2. For each parsed Markdown file, hash `metadataCache.changed(file, data, cache)` callback `data`; only the final Content Version is valid evidence. Stale/late versions are ignored diagnostically.
3. Create/modify/ordinary rename/delete has its required Vault event and path postcondition. Bridge-managed hidden trash and restore are the defined exception: hidden trash is not discoverable via `getAbstractFileByPath`, and restore may emit no second `vault.rename`; these operations therefore prove raw path state plus targeted cache/reference postconditions rather than waiting for nonexistent generic events.
4. The affected source-note closure satisfies expected `getFileCache`, `resolvedLinks`, `unresolvedLinks`, and, when needed, `getFirstLinkpathDest` predicates.
5. All predicates remain true for a 250 ms quiet window.
6. The successor immutable Search Snapshot is published.
7. `COMMITTED` is synced before success is acknowledged.

The installed baseline uses a 5,000 ms barrier deadline. Timeout fails closed and enters rollback/unproven handling. The Bridge does not claim Obsidian offers a global versioned cache commit or atomically updates all graph state.

## 9. Installation and operations

### 9.1 Release and installation

- Publish immutable versioned GitHub Releases containing `manifest.json`, `main.js`, optional `styles.css`, checksums, and GitHub artifact attestation.
- Install an explicit tag/version, never mutable `latest` by default.
- Verify repository/workflow attestation, SHA-256, Obsidian compatibility, target Vault/config path, destination, and disk space. No verification bypass exists.
- Write and verify a temporary bundle, then atomically replace release-managed files per Vault. Batch install is preflight-all then per-Vault atomic, not cross-Vault atomic.
- First install only deploys files. The Primary Operator enables the plugin, then the Bridge generates the explicit `claude mcp add --scope local ...` command. The plugin does not edit Claude Code configuration.
- Verify distinguishes at least `not_installed`, `installed_not_enabled`, `bridge_offline`, `mcp_not_registered`, `identity_mismatch`, and `ready`.
- Same-version reinstall verifies/repairs release files without deleting identity, port, queue, Submission Keys, or Recovery Journal.

### 9.2 Pause and maintenance

Manual pause is per Vault and drains the current item to a trustworthy end before `paused`. Existing queued work retains FIFO order. New submissions while paused do not enter the queue and do not bind a Submission Key. Discovery, reads, status, health, and diagnostics remain available.

Upgrade enters `maintenance_pending`, drains the current item, retains but stops dequeuing existing work, rejects new submissions without execution, atomically replaces the validated bundle, migrates state fail-closed, rechecks health, and remains `maintenance_paused` until the Primary Operator explicitly resumes. A state migration that makes the old bundle unsafe forbids blind downgrade.

### 9.3 Uninstall and purge

Ordinary uninstall removes only release-managed files and retains operational state. It refuses while work is executing/queued or recovery is unresolved. It prints, but does not execute, the command to remove local MCP registration.

Purging Vault identity, endpoint, journal, queue, and settings is separate, backed up, interactive, and forbidden by default when recovery is unresolved.

### 9.4 Diagnostics and recovery authority

The local interactive management entry point can generate a standard diagnostic bundle containing versions, health, listener and queue timelines, opaque identifiers or irreversible Submission Key digests, lifecycle/reason codes, journal frame/checksum state without before images, filtered logs/stacks, and bundle checksums. It is not an MCP tool result and is never generated or downloaded by an Agent Session.

The local bundle excludes note bodies, Frontmatter values, attachments, complete Change Set requests, before images, raw Submission Keys, credentials, environment variables, usernames, absolute paths, real Vault-relative paths, and real Vault IDs. Stable aliases permit within-bundle correlation.

Only the Primary Operator, through the local interactive management entry point, may generate that bundle, request selected content-inclusive diagnostic data, accept a trusted recovery baseline, or separately resume writes. For diagnostic information, Agent Sessions receive only the closed `vault_health` summary and may suggest its prescribed local action but cannot authorize that action; this does not remove the other observed health fields required by §6.1. Clearing a Journal or releasing a recovery gate is not an independent authorization path.

## 10. Operating constants and performance objectives

| Item | MVP value |
|---|---:|
| Maximum compact transport response | 262,144 bytes (256 KiB) |
| Maximum logical Exact Read | 1,048,576 bytes (1 MiB) |
| Continuation lifetime | 15 minutes sliding |
| Active continuation quota per client | 8 chains |
| Frozen-byte quota per client | 8 MiB |
| MCP per-server hard timeout | 600,000 ms |
| Cache/graph barrier deadline on validated runtime | 5,000 ms |
| Barrier quiet window | 250 ms |
| Accepted Submission Key/full-record retention | at least 7 days |
| Warm common discovery release gate | each batch nearest-rank p95 < 200 ms |
| Warm common Exact Read release gate | each batch nearest-rank p95 < 200 ms |
| Ordinary 20-note Work Clock release gate | each batch nearest-rank p95 < 1,000 ms |
| Ordinary 20-note Proof Clock release gate | each batch nearest-rank p95 < 4,000 ms; every sample < 5,000 ms |

Constants and profile identifiers are published by health/diagnostics. Benchmark evidence is re-run and registered after any materially relevant change to Bridge/plugin or protocol behavior, MCP SDK/transport, Obsidian/Electron/Node, fixture version/hash, relevant settings, or Vault-corpus assumptions. A Claude Code version change refreshes the installed-client compatibility observation and manifest but never moves Claude inference time into the Bridge latency gate.

## 11. Acceptance matrix

All scenarios are release-blocking unless marked as an objective or installed-runtime observation.

| ID | Given / When / Then |
|---|---|
| A-01 | **Given** two Managed Vaults and concurrent sessions, **when** each submits work, **then** each request, queue, journal, and result remains in one Vault; both Vaults may execute independently and no cross-Vault operation exists. |
| A-02 | **Given** expected and actual Vault IDs differ or one is absent, **when** MCP initializes or any tool enters, **then** the connection is rejected without read-only degradation. |
| A-03 | **Given** a matching local identity but non-loopback bind/Host/Origin, **when** a request arrives, **then** it fails before content access. |
| A-04 | **Given** no discovery matches, **when** `vault_discover` completes, **then** it returns an ordered empty collection with `isError: false`. |
| A-05 | **Given** a combined path/text/typed-Frontmatter/tag/reference/graph query, **when** discovery completes, **then** order is deterministic and each evidence note carries path, exact Content Version, and byte size from one Search Snapshot. |
| A-06 | **Given** duplicate paths in an ordered heterogeneous read, **when** read completes, **then** every input index has exactly one result in order. |
| A-07 | **Given** a repeated heading hierarchy, **when** section occurrence is absent or unsatisfied, **then** no alternate section or whole-note fallback is returned. |
| A-08 | **Given** BOM, LF, CRLF, mixed LF/CRLF, CJK, and astral Unicode, **when** Exact Read pages are concatenated by byte ranges, **then** the result is byte-identical to disk without newline rejection or normalization. |
| A-09 | **Given** one note over 1 MiB, **when** Exact Read is requested, **then** it returns `note_exceeds_exact_read_limit`; grouping/continuation cannot bypass it. |
| A-10 | **Given** a multi-note logical Exact Read over 1 MiB, **when** read runs, **then** it returns no content and deterministic complete contiguous groups preserving indices, duplicates, and order. |
| A-11 | **Given** a transport response over 256 KiB but an accepted logical read, **when** continuation runs, **then** each compact page is within limit and all byte ranges reconstruct the frozen result. |
| A-12 | **Given** a consumed, expired, lost, or client-mismatched continuation and no content-blocking effective gate, **when** continuation returns a trusted result, **then** it returns only `continuation_unavailable`; **given** a content-blocking effective gate, **then** it returns `OperationallyBlocked` and never masquerades as `continuation_unavailable`. |
| A-13 | **Given** 8 live chains or 8 MiB retained bytes, **when** another token is requested, **then** new issuance rejects without evicting live state. |
| A-14 | **Given** a valid Change Set, **when** submit is called once, **then** validation, preflight, registration, queueing, execution/recovery, and current proof result require no validate/apply handshake. |
| A-15 | **Given** any stale direct target, dependency, attachment, derived target, or absence condition, **when** lease-time preflight runs, **then** no mutation occurs and the complete intent is not applied. |
| A-16 | **Given** `replace_exact.old` occurs zero or multiple times, **when** preflight runs, **then** the Bridge chooses no match and returns operation ID plus actual count. |
| A-17 | **Given** an occupied required-absent destination, **when** preflight runs, **then** it identifies the operation and canonical conflicting path and performs no mutation. |
| A-18 | **Given** the same Submission Key and canonical request, **when** submit repeats across disconnect/restart, **then** the same Change Set identity/current proof state returns without another execution. |
| A-19 | **Given** the same key and a different request, **when** submit runs, **then** it returns `submission_key_conflict`, creates no new Change Set, and changes no existing record. |
| A-20 | **Given** concurrent submissions in one Vault, **when** they execute, **then** persisted FIFO order is respected and full preflight repeats immediately before each first mutation. |
| A-21 | **Given** `PREPARED` is durable and process termination occurs at any mutation/verification/cache/commit injection point, **when** the plugin loads, **then** whole before state is restored before new writes unless `COMMITTED` is durable. |
| A-22 | **Given** recovery sees third-party bytes, **when** compare-before-restore runs, **then** it never overwrites them, reports unproven state, and blocks the Vault-wide write gate. |
| A-23 | **Given** an unresolved unproven result projecting as `recovery_blocked`, **when** discovery, read, continue, or an unbound valid submission is received, **then** content tools return `OperationallyBlocked`; the submission atomically binds key/fingerprint, registers `intent_not_applied` without `changeSet.failure`, returns the historical gate with `isError: true`, and replays that disposition after recovery; health and normal status remain successful, and renewed intent requires a new key. |
| A-24 | **Given** a move with supported references, **when** preflight derives closure, **then** each destination-only rewrite is explicit, version-guarded, and style-preserving. |
| A-25 | **Given** duplicate target/heading, unknown grammar, invalid fragment, literal-`#` attachment, or non-unique byte span, **when** a derived rewrite is considered, **then** the complete Change Set rejects without guessing. |
| A-26 | **Given** BOM/CRLF/CJK/emoji and two equal link spellings, **when** only the second verified span is rewritten, **then** the first spelling and all untouched bytes remain exact. |
| A-27 | **Given** v1 metadata evidence arrives after raw bytes are v2, **when** the barrier evaluates callback data, **then** v1 is ignored and cannot prove v2 success. |
| A-28 | **Given** raw final bytes and exact graph predicates converge, **when** they remain true for 250 ms, **then** the successor Search Snapshot and durable `COMMITTED` precede `intent_applied`. |
| A-29 | **Given** semantic evidence misses the 5-second installed-runtime deadline, **when** the barrier expires, **then** success is not reported and rollback/unproven handling begins. |
| A-30 | **Given** a manual pause during execution, **when** the current item reaches a trustworthy end, **then** the Vault becomes paused, queued order is retained, and new submissions do not bind keys. |
| A-31 | **Given** an upgrade with queued work, **when** maintenance begins, **then** the current item drains, dequeue stops, state/journal migrate fail-closed, and write resume remains explicit. |
| A-32 | **Given** release artifacts, **when** install/upgrade runs, **then** attestation, checksums, compatibility, path, and capacity validate before per-Vault atomic replacement; no bypass exists. |
| A-33 | **Given** an Agent Session, **when** it calls `vault_health`, **then** only the closed `overall`, `reasonCodes`, and `operatorAction` diagnostic summary is exposed; **given** the Primary Operator generates a standard diagnostic bundle through the local interactive management entry point, **then** no Vault content, before images, raw keys/IDs, usernames, environment, or real paths appear. |
| A-34 | **Given** protocol failure/truncation/schema mismatch after submit may have started, **when** the client recovers, **then** it queries or checks the original key/request and never changes keys based on the failed call. |
| A-35 | **Given** accepted key/record state less than seven days old, **when** Bridge state is lost/corrupt, **then** ordinary `unknown` is forbidden; recovery or unproven blocked state is required. |
| A-36 | **Given** caller and Bridge cannot safely share the MCP tool schema, **when** MCP initializes, **then** initialization fails and no product result exists; **given** a schema-compatible connection whose plugin, protocol participant, persistent-state schema, or Recovery Journal is incompatible, **when** health is called, **then** only the minimal incompatible branch returns with `isError: false`; every other tool returns `incompatible_protocol` with `isError: true` and submit neither inspects nor binds a key. |
| A-37 | **Given** another enabled plugin observes Vault events/indexing, **when** a Change Set stages or writes content, **then** no half-written Markdown or staging path is ever visible inside the Vault. |
| A-38 | **Given** Bridge-managed hidden trash and restore, **when** success/recovery evidence is gathered, **then** raw path state plus targeted cache/reference probes prove the result without requiring `getAbstractFileByPath` visibility or a second `vault.rename`. |
| A-39 | **Given** every strict root, shared definition, valid/invalid fixture, and cross-call scenario in the versioned contract package, **when** it runs on a supported profile, **then** only schema-valid closed results are accepted, unknown fields reject, and authoritative `structuredContent` equals its compatibility-text serialization. |
| A-40 | **Given** one or more internal gates, **when** an ordinary tool projects a gate, **then** it exposes exactly one in the fixed precedence order and follows the per-tool binding and `isError` rules in §7.5; health remains observational. |
| A-41 | **Given** any Bridge-originated mutation, including one operation affecting one file, **when** it is requested, **then** it uses `vault_change_set_submit` and no direct or lightweight mutation surface exists. |
| A-42 | **Given** any Markdown Content Version input or output, **when** it is validated or emitted, **then** it is exactly `sha256:<64 lowercase hexadecimal digits>` over exact bytes; bare, uppercase, spaced, wrong-length, and non-hex values reject, and attachment evidence is not a Content Version. |
| A-43 | **Given** complete preflight, **when** preview, final result, status, or replay is observed, **then** the immutable preview retains effect IDs, causation, order, projected outcomes, and one deduplicated projected path table; `intent_applied` retains those identities with only `changed | already_satisfied` and one authoritative final-path table. |
| A-44 | **Given** a Search Snapshot is published, **when** public results and schemas are inspected, **then** it remains an internal success-proof barrier with no extra operation, handle, or independently callable capability. |

## 12. Benchmark and fault-injection corpus

### 12.1 Registered reference environment and manifest

The initial release-binding profile is exactly `MVP-PERF-REF-1`:

- Windows 11 Pro for Workstations build 26200;
- Intel Core Ultra X7 358H, 16 cores / 16 logical processors;
- 31.5 GiB RAM;
- UMIS UPJYJ1TBMNV1QWY 1 TB NVMe SSD, with fixtures on NTFS;
- Obsidian 1.13.4, Electron 39.6.0, and Node 24.14.0;
- a fresh Obsidian profile with only the candidate Vault Operation Bridge enabled;
- AC power, Windows Best performance mode, no other Vault writer, 60-second pre-run average CPU below 10%, and at least 8 GiB available memory; normal system security, including Defender, remains enabled.

Every run records the profile name; Bridge/plugin, protocol, MCP SDK, Claude Code, Windows, filesystem, hardware, and Obsidian/Electron/Node versions; enabled-plugin inventory; relevant Obsidian settings; fixture seed and hashes; Vault note/file count and byte percentiles; canonical fixture-manifest SHA-256; before/after inventory; residual-cleanup report; all samples and computed p95 values; and the installed-client compatibility observation/version. A missing or mismatched manifest cannot register evidence. Another machine becomes release-binding only through a separately named, explicitly registered runtime profile.

### 12.2 Deterministic content corpus

The corpus contains isolated generated paths and refuses to overwrite pre-existing fixtures. It includes:

- empty, median-sized, p95-sized, 256 KiB boundary, 1 MiB boundary, and over-1 MiB Markdown notes;
- UTF-8 BOM/no-BOM, LF/CRLF/mixed-newline preservation and rewrite-fidelity cases, CJK source paths/content, astral emoji, combining characters, and invalid UTF-8;
- duplicate request paths and repeated heading hierarchies with explicit occurrences;
- wikilink/embed/Markdown inline/embed variants, literal spaces/`%20`, aliases/titles, duplicate spellings, duplicate basename/heading, ASCII and Unicode block IDs, malformed destinations, and literal-`#` attachment targets;
- Frontmatter scalar/list/quote/flow/block variants and lookalike non-reference text;
- reference-style shared usage/definition, duplicate/shadow definitions, and cache-to-Exact-Read Content Version races;
- binary attachments with exact SHA-256.

The release performance fixtures are separately fixed:

- **`read-v1`:** root `.mvp-perf-fixture/read-v1/`, seed `mvp-perf-read-v1`, exactly 1,000 Markdown notes and 7,531,464 content bytes: 500 × 2,608 B, 449 × 10,240 B, 50 × 29,316 B, and 1 × 163,904 B, with a fixed deterministic text/tag/link graph. Its discovery case combines path-prefix, body-token, tag, and outgoing-link criteria and returns exactly 20 ordered evidence notes. Its read case is one ordered full Exact Read of those 20 fixed 2,608-B notes, below 256 KiB without continuation.
- **`change-v1`:** root `.mvp-perf-fixture/change-v1/`, seed `mvp-perf-change-v1`, exactly 20 existing 4,096-B Markdown notes, UTF-8 without BOM and LF, with fixed Frontmatter and already-parsed links. One Change Set performs one plain-body `replace_exact` per note; every old string occurs exactly once and the affected source-note closure is exactly those 20 notes.

Attachments, create/delete, rename, derived-reference rewrites, continuation, recovery, and injected faults are excluded only from the ordinary-work fixture; they remain independently release-blocking correctness corpora. Generated roots refuse to overwrite existing paths and record seed, canonical manifest SHA-256, before/after inventory, and residual cleanup. Fixture restore and exact inventory/hash verification occur outside each timed sample, and the per-Vault FIFO is empty before every sample.

### 12.3 Benchmark timing, transport, and sampling

All benchmark timing uses monotonic clocks and a fixed benchmark MCP client over real loopback Streamable HTTP transport.

- The discovery/read client clock starts immediately before sending the complete request and stops after the complete MCP result is received, decoded, and schema-validated. It includes loopback HTTP, MCP framing, Bridge work, serialization, and decoding.
- The Bridge server span is recorded separately from complete request decode/tool-handler entry through compact-result encoding and handoff to the HTTP writer. It is diagnostic and never substitutes for the client-observed release gate.
- One non-gating installed Claude Code compatibility spot check and its client version are recorded. Claude inference, tool selection, Claude API network latency, and result rendering are excluded from Bridge percentiles.
- Work Clock starts when the Change Set is FIFO head in an otherwise empty queue and lease-time preflight begins; it stops after mutation and exact final-path, existence, and raw-byte hash verification. Passing it never authorizes success.
- Proof Clock has the same start and stops only after final Content-Version callback evidence, required Vault/path evidence, exact affected-closure cache/graph predicates, an uninterrupted 250 ms quiet window, successor immutable Search Snapshot publication, and synced durable `COMMITTED`.

Status-poll cadence and Claude Code's next reasoning turn affect neither Change Set clock; Bridge lifecycle timestamps are authoritative.

For each benchmark case, run three independent batches. Each batch restarts Obsidian, waits for Bridge/runtime `ready` and stable fixture inventory, performs one unmeasured Search Snapshot materialization, runs five unmeasured executions of that exact case, then records 30 measured executions. Compute nearest-rank p95 independently per batch as `sorted[ceil(0.95 × 30) - 1]`, the 29th ordered sample. All batches pass independently. Do not pool batches, remove outliers, substitute an average, or rerun only a failed sample. An environment-precondition failure invalidates the entire batch; a tool, schema, content, or correctness failure fails release rather than becoming a discarded timing sample.

The release measurements include:

- the fixed `read-v1` common warm discovery and Exact Read cases;
- 256 KiB compact response integrity;
- exact reconstruction of accepted 1 MiB and escape-heavy reads;
- over-1-MiB deterministic grouping;
- continuation single-use, lifetime, teardown/loss, and quota boundaries;
- a 5,000 ms cancellation probe distinct from the 600,000 ms configured hard timeout;
- the fixed `change-v1` Work and Proof clocks.

### 12.4 Cache/graph scenarios

- single create/modify;
- rapid v1→v2 overwrite with delayed v1 callback;
- target rename plus explicit derived source rewrite;
- unresolved target creation and deletion;
- targeted graph closure growth;
- 250 ms quiet-window reset by contrary evidence;
- 5-second fail-closed timeout;
- Search Snapshot publication and immediate read-after-success/rollback.

### 12.5 Crash and recovery matrix

For create note, modify body, Frontmatter rewrite, derived-reference rewrite, binary attachment write, same-volume move, and managed trash, terminate the process at least:

- before and after durable `PREPARED`;
- after each mutation;
- after raw verification;
- during cache/graph wait;
- before and after durable `COMMITTED`;
- during rollback and before/after `ROLLED_BACK`.

Also inject truncated/wrong-Vault/checksum-invalid journal, journal capacity/disk-full/sync/permission errors, destination collision, external mutation during execution/recovery, plugin reload with active `PREPARED`, cache delay/reorder, record retention/tombstone boundaries, and concurrent idempotency conflicts.

### 12.6 Cleanup and evidence

Every fixture runner uses a dedicated generated root, refuses overwrite, records before/after inventory, attempts cleanup in `finally`, and reports residual paths. A timeout or killed outer process cannot be treated as proof of cleanup. Structured report, monotonic event log, checksums, and a concise verdict are retained as release evidence; note content is not included in standard diagnostics.

### 12.7 Public wire-contract corpus

The release corpus consumes the versioned contract package as its authority. Across all six tools it runs strict input/output valid and invalid fixtures, rejects unknown fields except explicit extension points, and verifies authoritative `structuredContent` equals compatibility-text serialization.

Its cross-call scenario manifest release-blockingly covers continuation identity/lifetime, Submission Key ordering/persistence/replay, public proof states, operational-gate projection, diagnostic redaction, local-only recovery authority, and Search Snapshot internality. A JSON Schema pass alone does not satisfy raw-byte, WAL/recovery, cache/graph, privacy, MCP transport, or performance evidence.

## 13. Release gates

A release is eligible only when:

1. The versioned contract package is present as the authoritative public-contract source, with strict per-tool input/output roots, shared `$defs`, valid/invalid fixtures, and a cross-call scenario manifest; schemas reject unknown fields except explicit extension points.
2. Contract-package fixtures and scenarios pass on every supported runtime profile.
3. The full acceptance matrix passes on every supported runtime profile.
4. Raw-byte, registered-reference, real-loopback transport, cache/graph, crash/recovery, and public-wire corpora pass with recorded manifests.
5. No failed probe leaves residual fixture content or an unreported blocked gate.
6. Release artifacts and migrations pass install, repair, upgrade, and rollback tests.
7. Privacy tests prove standard diagnostics exclusions.
8. Operating constants are published in health/diagnostics.
9. In each of three independent batches, common warm discovery p95 is strictly below 200 ms, common warm Exact Read p95 below 200 ms, ordinary 20-note Work Clock p95 below 1,000 ms, and ordinary 20-note Proof Clock p95 below 4,000 ms.
10. Every Proof Clock sample is strictly below the installed 5,000 ms deadline.
11. The unchanged correctness barriers pass: stale or contrary evidence, missing events/postconditions, timeout, rollback, schema/content error, or unproven result fails release regardless of percentile.

The 4,000 ms Proof Clock p95 is a performance gate inside—not a replacement for—the 5,000 ms hard correctness deadline. A passing Work Clock can never authorize `intent_applied` or any success acknowledgement.

## 14. Decision sources

- [Find the way to reliable Claude Code Vault operations](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/2)
- [Define the MVP product boundary and operating model](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/3)
- [Choose the runtime and Claude Code transport architecture](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/4)
- [Specify the read and search contract](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/5)
- [Specify the Change Set contract](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/6)
- [Prove atomic execution and crash recovery](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/7)
- [Prove search consistency and link semantics](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/8)
- [Define installation, trust, and operations](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/9)
- [Validate installed transport limits and continuation lifetime](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/11)
- [Define the cross-tool error and retry taxonomy](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12)
- [Validate runtime recovery and durability boundaries](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/13)
- [Validate installed cache and graph causality](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/15)
- [Specify registered reference grammar and renderer profiles](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/16)
- [Validate the raw-byte source-span adapter](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/17)
- [Define operational gate result semantics](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/23)
- [Specify Change Set success reporting and single-file policy](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/24)
- [Prototype the complete public wire schema](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/25)
- [Fix measurable MVP performance release gates](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/26)

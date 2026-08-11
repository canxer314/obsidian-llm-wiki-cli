# Reliable Claude Code Vault Operations — MVP specification assembly

> **Status:** Wayfinder assembly draft. All normative decisions already made by the map are consolidated here. The document is **not yet development-ready** because the contract and performance questions in [Remaining decisions](#remaining-decisions) still require explicit resolution. Implementers must not invent answers for them.

## 1. Destination and precedence

The MVP provides a reliable, efficient Windows operation channel through which Claude Code can discover, read, change, and verify one or more independently managed Obsidian Vaults. Every Agent Session, request, Change Set, queue, identity, and recovery action belongs to exactly one Managed Vault.

This document uses the following precedence rules when an earlier decision was explicitly refined later:

1. [Define installation, trust, and operations](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/9) replaces the earlier single-Vault, single-endpoint, and mandatory-bearer requirements with per-Managed-Vault Bridge Instances and a no-credential single-user loopback default.
2. [Define the cross-tool error and retry taxonomy](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12) replaces earlier public Change Set lifecycle and generic error envelopes with four proof states and narrow closed failures. Internal executor and journal phases remain implementation state and are not public Change Set states.
3. Later installed-runtime validation fixes operating constants and supported runtime profiles without broadening the product boundary.

## 2. Domain language

- **Primary Operator:** the sole MVP user, operating one or more Managed Vaults through Claude Code. A general plugin-market audience is not the design target.
- **Open Vault:** an Obsidian Vault loaded by an Obsidian app instance. An Open Vault is not necessarily managed.
- **Managed Vault:** an Open Vault in which the Primary Operator enabled and initialized the Vault Operation Bridge. It is an independent operation and recovery boundary.
- **Vault Operation Bridge:** the agent-first interface through which Claude Code discovers, reads, changes, and verifies one Managed Vault.
- **Bridge Instance:** one running Vault Operation Bridge belonging to exactly one Managed Vault.
- **Multi-Vault Coexistence:** multiple Managed Vaults may be independently operable at once. It never permits one operation to span Vaults.
- **Change Set:** related mutations within one Managed Vault, validated and previewed as one unit, which either satisfy the complete intent or restore the pre-execution state.
- **Exact Read:** a single-note or ordered multi-note read returning complete, untrimmed content without silent excerpting or normalization. Transport pages do not alter this semantic.
- **Content Version:** a SHA-256-compatible identity over one exact raw-byte note state.
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

The fixed semantic surface consists of:

- `vault_health`
- `vault_discover`
- `vault_read`
- `vault_continue`
- `vault_change_set_submit`
- `vault_change_set_status`
- privacy-preserving diagnostics and Primary Operator recovery operations

The exact unresolved wire schemas are listed in [Remaining decisions](#remaining-decisions); the behavior below is already fixed.

### 6.1 `vault_health`

Every Agent Session calls health after connection/reconnection and before content tools. It calls health again after plugin upgrade, Vault move/copy handling, endpoint change, recovery, or maintenance resume. The server independently rechecks identity and gates at every tool entry; health is not a client-side security boundary.

Health reports at least:

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

Protocol compatibility uses an explicit supported major/minor range rather than exact plugin-version equality. Compatible plugin versions may operate while health reports an upgrade notice. An incompatible protocol major, unknown persistent-state schema, or unreadable Recovery Journal schema returns `incompatible_protocol` and rejects the entire connection without read-only degradation.

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
- The only trusted continuation failure is `{ code: "continuation_unavailable" }` with `isError: true`. The client discards all pages from the old chain and repeats the original `vault_read`.
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

The later cross-tool taxonomy fixes the public proof record:

```text
ChangeSetRecord =
  | { changeSetId; state: "in_progress" }
  | { changeSetId; state: "intent_applied" }
  | { changeSetId; state: "intent_not_applied"; failure?: ChangeSetFailure }
  | { changeSetId; state: "result_unproven" }

VaultState = { writeGate: "open" | "blocked" }
```

Allowed stable failures are:

```text
ChangeSetFailure =
  | { code: "stale_observation" }
  | { code: "exact_match_count_mismatch"; operationId; actualOccurrences }
  | { code: "path_conflict"; operationId; path }

SubmitFailure = { code: "submission_key_conflict" }
```

The closed core result fixed by the error-taxonomy decision is:

```text
SubmitResult =
  | { outcome: "request_invalid" }
  | { failure: { code: "submission_key_conflict" } }
  | { changeSet: ChangeSetRecord; vault: VaultState }
```

`in_progress` and `intent_applied` use `isError: false`; `intent_not_applied`, `result_unproven`, `request_invalid`, and `submission_key_conflict` use `isError: true`.

The unresolved interaction between this closed union and operational gates is recorded in [Remaining decisions](#remaining-decisions).

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

### 7.5 Gate semantics

- Any unresolved `result_unproven` requires `writeGate: "blocked"` for the entire Vault.
- Reads, status, health, and recovery diagnosis remain available for an ordinary unproven gate.
- During active automatic recovery, only health, status, and diagnostics are available; content discovery/read/write reports the recovery gate.
- If recovery itself is untrusted (`restoration_incomplete`, bad journal/identity, or failed verification), all content tools remain blocked until Primary Operator action.
- A queued item not yet executed when an earlier item becomes unproven ends as `intent_not_applied` and never wakes automatically.
- A submit received while the unproven gate is blocked is validated, bound, registered, never reads mutation targets, and ends as `intent_not_applied` without `failure`.
- Only an explicitly authorized Primary Operator recovery flow may accept a verified new baseline. The original failed record remains failed/unproven history; queue processing remains paused until separately resumed.

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

Standard diagnostics contain versions, health, listener and queue timelines, opaque identifiers or irreversible Submission Key digests, lifecycle/reason codes, journal frame/checksum state without before images, filtered logs/stacks, and bundle checksums.

They exclude note bodies, Frontmatter values, attachments, complete Change Set requests, before images, raw Submission Keys, credentials, environment variables, usernames, absolute paths, real Vault-relative paths, and real Vault IDs. Stable aliases permit within-bundle correlation.

Only the Primary Operator can request selected content-inclusive data, accept a recovery baseline, clear a journal, or release a recovery gate. Agent Sessions can request machine summaries and suggest commands but cannot authorize these actions.

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
| Warm common discovery/read objective | under 200 ms |
| Approximately 20 ordinary Markdown files validation/execution objective | under 1,000 ms; exact measured boundary remains unresolved |

Constants are published by diagnostics and re-baselined after Claude Code, Obsidian/Electron, MCP SDK/protocol, or materially relevant Vault-corpus changes.

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
| A-08 | **Given** BOM, CRLF, CJK, and astral Unicode, **when** Exact Read pages are concatenated by byte ranges, **then** the result is byte-identical to disk. |
| A-09 | **Given** one note over 1 MiB, **when** Exact Read is requested, **then** it returns `note_exceeds_exact_read_limit`; grouping/continuation cannot bypass it. |
| A-10 | **Given** a multi-note logical Exact Read over 1 MiB, **when** read runs, **then** it returns no content and deterministic complete contiguous groups preserving indices, duplicates, and order. |
| A-11 | **Given** a transport response over 256 KiB but an accepted logical read, **when** continuation runs, **then** each compact page is within limit and all byte ranges reconstruct the frozen result. |
| A-12 | **Given** a consumed/expired/lost/client-mismatched continuation, **when** continuation returns a trusted result, **then** it returns only `continuation_unavailable`; the client discards the whole chain. |
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
| A-23 | **Given** an unresolved unproven result, **when** another session/path/key submits, **then** ordinary writing cannot bypass the gate; reads/status/diagnosis remain available outside active recovery. |
| A-24 | **Given** a move with supported references, **when** preflight derives closure, **then** each destination-only rewrite is explicit, version-guarded, and style-preserving. |
| A-25 | **Given** duplicate target/heading, unknown grammar, invalid fragment, literal-`#` attachment, or non-unique byte span, **when** a derived rewrite is considered, **then** the complete Change Set rejects without guessing. |
| A-26 | **Given** BOM/CRLF/CJK/emoji and two equal link spellings, **when** only the second verified span is rewritten, **then** the first spelling and all untouched bytes remain exact. |
| A-27 | **Given** v1 metadata evidence arrives after raw bytes are v2, **when** the barrier evaluates callback data, **then** v1 is ignored and cannot prove v2 success. |
| A-28 | **Given** raw final bytes and exact graph predicates converge, **when** they remain true for 250 ms, **then** the successor Search Snapshot and durable `COMMITTED` precede `intent_applied`. |
| A-29 | **Given** semantic evidence misses the 5-second installed-runtime deadline, **when** the barrier expires, **then** success is not reported and rollback/unproven handling begins. |
| A-30 | **Given** a manual pause during execution, **when** the current item reaches a trustworthy end, **then** the Vault becomes paused, queued order is retained, and new submissions do not bind keys. |
| A-31 | **Given** an upgrade with queued work, **when** maintenance begins, **then** the current item drains, dequeue stops, state/journal migrate fail-closed, and write resume remains explicit. |
| A-32 | **Given** release artifacts, **when** install/upgrade runs, **then** attestation, checksums, compatibility, path, and capacity validate before per-Vault atomic replacement; no bypass exists. |
| A-33 | **Given** a standard diagnostics request, **when** the bundle is generated, **then** no Vault content, before images, raw keys/IDs, usernames, environment, or real paths appear. |
| A-34 | **Given** protocol failure/truncation/schema mismatch after submit may have started, **when** the client recovers, **then** it queries or checks the original key/request and never changes keys based on the failed call. |
| A-35 | **Given** accepted key/record state less than seven days old, **when** Bridge state is lost/corrupt, **then** ordinary `unknown` is forbidden; recovery or unproven blocked state is required. |
| A-36 | **Given** compatible minor protocol/plugin versions, **when** a session connects, **then** operation is allowed with an upgrade notice; **given** an incompatible protocol major or unknown/unreadable persistent or Journal schema, **then** the whole connection returns `incompatible_protocol` without read-only degradation. |
| A-37 | **Given** another enabled plugin observes Vault events/indexing, **when** a Change Set stages or writes content, **then** no half-written Markdown or staging path is ever visible inside the Vault. |
| A-38 | **Given** Bridge-managed hidden trash and restore, **when** success/recovery evidence is gathered, **then** raw path state plus targeted cache/reference probes prove the result without requiring `getAbstractFileByPath` visibility or a second `vault.rename`. |

## 12. Benchmark and fault-injection corpus

### 12.1 Reproducible environment manifest

Every run records Windows build, filesystem/volume, Obsidian/installer/Electron/Node versions, plugin and protocol versions, Claude Code version, MCP SDK version, CPU/memory, Vault note/file counts and byte percentiles, enabled-plugin inventory, relevant Obsidian settings, and fixture seed/hash. Results without this manifest cannot register a runtime profile.

### 12.2 Deterministic content corpus

The corpus contains isolated generated paths and refuses to overwrite pre-existing fixtures. It includes:

- empty, median-sized, p95-sized, 256 KiB boundary, 1 MiB boundary, and over-1 MiB Markdown notes;
- UTF-8 BOM/no-BOM, LF/CRLF/mixed newline rejection cases, CJK source paths/content, astral emoji, combining characters, and invalid UTF-8;
- duplicate request paths and repeated heading hierarchies with explicit occurrences;
- wikilink/embed/Markdown inline/embed variants, literal spaces/`%20`, aliases/titles, duplicate spellings, duplicate basename/heading, ASCII and Unicode block IDs, malformed destinations, and literal-`#` attachment targets;
- Frontmatter scalar/list/quote/flow/block variants and lookalike non-reference text;
- reference-style shared usage/definition, duplicate/shadow definitions, and cache-to-Exact-Read Content Version races;
- binary attachments with exact SHA-256;
- a generated ordinary-work corpus suitable for calibrating the approximately 20-note objective; its exact files, sizes, reference closure, and fixture hash are outputs of D-2 and are not fixed by this draft.

### 12.3 Read/transport benchmarks

- warm common discovery/read objective under 200 ms;
- 256 KiB compact response integrity;
- accepted 1 MiB logical Exact Read reconstructed exactly across as many compact-JSON pages as the 256 KiB response ceiling requires, including an escape-heavy payload;
- over-1 MiB deterministic grouping;
- token single-use, 15-minute sliding lifetime, session teardown, and snapshot-loss behavior;
- 8-chain and 8-MiB quota boundaries;
- 5000 ms MCP timeout cancellation probe separated from the normal configured 600000 ms hard timeout.

Warm-up count, measured repetitions, percentile, and exact timing boundary for release gating are part of the unresolved performance ticket rather than invented here.

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

## 13. Release gates

A release is eligible only when:

1. All accepted wire schemas are generated from one source of truth and reject unknown fields.
2. The full acceptance matrix passes on every supported runtime profile.
3. Raw-byte, registered-reference, transport, cache/graph, and crash corpora pass with a recorded environment manifest.
4. No failed probe leaves residual fixture content or an unreported blocked gate.
5. Release artifacts and migrations pass install/repair/upgrade/rollback tests.
6. Privacy tests prove standard diagnostics exclusions.
7. Operating constants are published in health/diagnostics.
8. The remaining protocol and benchmark decisions below are closed and incorporated.

## 14. Remaining decisions

These are not implementation details; they change the public contract or release verdict and therefore block development-ready status.

### D-1: Complete coherent public wire schemas

The resolved decisions leave these incompatible or unspecified edges:

- The closed `SubmitResult` from [Define the cross-tool error and retry taxonomy](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12) has no branch for the machine-actionable `writes_paused` and `upgrade_in_progress` non-binding outcomes required by [Define installation, trust, and operations](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/9).
- Active `recovery_in_progress` and recovery-blocked content-tool outcomes likewise need a trustworthy schema without becoming generic enterprise errors or being confused with protocol failure.
- Normal `intent_applied` reporting still needs a fixed success payload for preview, requested/derived effects, changed paths, and final Content Versions; the error-taxonomy decision explicitly left it unspecified.
- Full request/result JSON Schemas for discovery projections, typed read variants, groups/pages, health compatibility/reason fields, diagnostics, and Primary Operator recovery authorization remain unstated.
- The final textual encoding and validation rules for Content Version values remain unstated.
- The policy for whether a single-file mutation must still be submitted as a Change Set, and any permitted exception, remains unstated.
- The public four-state proof model must be mapped normatively to internal executor/health diagnostics without exposing two contradictory lifecycle APIs.

A single schema decision must resolve these together and provide examples plus `isError` mappings.

### D-2: Fix measurable performance release gates

The product boundary targets validation/execution across roughly 20 ordinary Markdown files under 1 second. Installed cache/graph validation observed single scenarios around 0.97–1.99 seconds and requires a 5-second fail-closed barrier before success. The route has not fixed whether the 1-second objective ends before semantic confirmation, is an aspirational non-gate, or must be revised, nor has it fixed percentile, warm-up, repetition count, reference hardware, or the exact 20-note fixture.

A benchmark-backed decision must define the timing boundaries and release verdict without weakening the correctness barrier.

## 15. Decision sources

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

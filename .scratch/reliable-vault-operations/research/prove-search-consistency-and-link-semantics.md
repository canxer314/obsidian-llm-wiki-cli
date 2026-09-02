# Prove search consistency and link semantics

**Research date:** 2026-08-01
**Issue:** [#8 — Prove search consistency and link semantics](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/8)
**Decision recommendation:** accept the Operation Layer contracts below as the implementation target for the **Vault Operation Bridge**, subject to three explicit runtime-validation tickets: cache/graph causality, registered reference grammar profiles, and raw-byte source-span mapping. The bridge may publish `succeeded` only after it atomically installs its own Content-Versioned successor snapshot following authoritative byte/hash verification and bounded cache/graph readiness observations. Public Obsidian APIs do not prove that those observations form a host-atomic metadata/graph commit, and neither an individual API call nor `FileManager.renameFile()` provides a multi-file transaction or unconditional link-rewrite guarantee.

## 1. Scope and fixed decisions

This document uses the map's required domain vocabulary: **Primary Operator**, **ThinkFlywheel Vault**, **Vault Operation Bridge**, **Change Set**, **Exact Read**, **Content Version**, **Agent Session**, **Submission Key**, **Read Dependency**, and **Recovery Journal**.

It supplies the search, metadata, heading, link, attachment, CJK, and semantic evidence requirements for the Change Set contract. It deliberately does **not** redefine the global serial executor, durable Recovery Journal protocol, or crash-recovery mechanics assigned to [#7](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/7).

The following are already decided and constrain this recommendation:

- [#3 resolution](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/3#issuecomment-5151457435) fixes exact read semantics, deterministic index-driven discovery, CJK, concurrent Agent Sessions, Content Versions, and all-or-restore Change Sets.
- [#4 resolution](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/4#issuecomment-5151457632) selects one Obsidian-plugin-hosted, authenticated, loopback-only Streamable HTTP MCP Vault Operation Bridge. The plugin is the semantic authority; a filesystem-writing sidecar is not.
- [#5 resolution](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/5#issuecomment-5151457840) fixes the read/search contract: `vault_discover`, `vault_read`, and `vault_continue`; immutable discovery results; exact-byte Content Versions; heading hierarchy plus occurrence disambiguation; and continuation that never re-runs against current bytes.
- [#6 resolution](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/6#issuecomment-5151458027) fixes the Change Set boundary. In particular, `move` of a note has `linkEffect: "update_resolved_references"`; its derived Markdown rewrites are visible members of the same Change Set and are revalidated both before queueing and after acquiring the serial lease.

## 2. Evidence: what the host API does and does not guarantee

### 2.1 Host API guarantees

| Fact | Host guarantee | Consequence for this decision |
| --- | --- | --- |
| `Vault.read()` is the direct plaintext read intended before modifying; `cachedRead()` is the display-oriented cached path. `readBinary`, `modifyBinary`, and `createBinary` exist for binary files. | [Vault reference](https://docs.obsidian.md/Reference/TypeScript+API/Vault) | Exact Read and attachment evidence must use the byte-preserving contract from #5, not silently treat `cachedRead()` as an exact or current-byte source. |
| `Vault.process()` is documented as an atomic read-modify-save operation for one `TFile`. | [Vault.process](https://docs.obsidian.md/Reference/TypeScript+API/Vault/process) | It is useful only for an individual guarded mutation; it is not a multi-file Change Set transaction. |
| `MetadataCache.getFileCache()` / `getCache()` expose cached metadata; `CachedMetadata` includes `frontmatter`, `headings`, `links`, and `embeds`. | [MetadataCache reference](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache); [official declarations: `CachedMetadata`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2022-L2049) | The plugin can obtain the host's parsed metadata and the location-bearing link/embed records; it need not invent a second Markdown parser as semantic authority. |
| `MetadataCache.getFirstLinkpathDest(linkpath, sourcePath)` finds the best destination; `resolvedLinks` and `unresolvedLinks` expose the host link graph. | [official declarations: link APIs](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4404-L4444) | Host resolution is the compatibility check for a proposed reference. It is not a documented ambiguity report or a format-preserving rewrite facility. |
| `metadataCache.on("changed", ...)` fires after a file is indexed and updated metadata is available; it does **not** fire for renames. `resolve`/`resolved` describe link-graph processing; the Vault also has a rename event. | [MetadataCache `changed`](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache/on('changed')); [official declarations: metadata events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4446-L4472); [official declarations: Vault events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7567-L7593) | A `changed` observation shows that updated cache was available when the event fired, but does not causally bind that cache to a bridge Content Version or prove link-graph settlement. Rename requires the Vault rename observation plus re-querying cache/graph state. |
| `Vault.rename()` directs callers wanting automatic link rename to `FileManager.renameFile()`. That helper updates links according to the Primary Operator's preferences. | [Vault.rename](https://docs.obsidian.md/Reference/TypeScript+API/Vault/rename); [FileManager.renameFile](https://docs.obsidian.md/Reference/TypeScript+API/FileManager/renameFile) | `FileManager.renameFile()` is intentionally not the deterministic rewrite mechanism: preference-dependent side effects cannot establish the #6 closure or rollback evidence. Use a plain Vault move plus explicit derived rewrites. |
| MCP JSON-RPC messages are UTF-8. JSON strings carry paths and content in bodies, rather than relying on shell/code-page conversion. | [JSON-RPC/MCP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports); [RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259#section-8.1) | CJK paths, headings, aliases, and note text must be tool-body data. The gateway must neither place them in headers nor pass them through a command line. |

### 2.2 Non-guarantees that the Operation Layer must close

The public `Vault` surface exposes individual asynchronous operations and one-file `process`; it does not document a multi-file transaction, a global writer lock, a cache commit token, or a per-Change-Set metadata barrier. `FileManager.renameFile()` makes user-preference-dependent edits, not a closed, auditable list of rewrites. The documented `changed` / `resolve` / `resolved` events are observability signals, not a public transaction protocol. See the declarations for [Vault mutations](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7394-L7534) and [MetadataCache events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4446-L4472).

Accordingly, these are **Operation Layer requirements**, not host API claims:

1. a bridge-owned immutable read/search snapshot indexed by Content Version;
2. a bridge-owned cache-observation barrier before publishing a successful Change Set;
3. explicit reference-resolution, ambiguity, rendering, and derived-rewrite rules;
4. preflight and post-lease revalidation of the semantic evidence;
5. refusal to acknowledge success on timeout, incomplete cache evidence, external interference, or unsupported link form; and
6. exact pre/post semantic evidence for #7's recovery and compensation layer.

The bridge serializes Change Sets submitted through it. It cannot, from the documented public APIs alone, prevent a native Obsidian edit or another plugin from writing during that interval. Such an unaffiliated write is therefore a conflict/failure condition, never evidence that a successful Change Set was isolated.

## 3. Required read/search consistency model

### 3.1 Immutable bridge snapshots

Define an internal **Search Snapshot** as an immutable tuple:

```text
snapshotId, publishedGeneration,
records[path] = {
  path (exact host-returned canonical Vault-relative spelling),
  fileKind, sizeBytes, contentVersion,
  frontmatter, headings, links, embeds, frontmatterLinks, referenceLinks,
  resolvedOutgoing, unresolvedOutgoing,
  freshnessScope
}
```

`contentVersion` is the #5/#6 **Content Version**: a SHA-256-compatible identity for the exact note bytes represented by the record. The snapshot retains frozen raw bytes separately when it backs Exact Read or `vault_continue`; metadata is a semantic projection, never an Exact Read substitute.

Normal publication must use structural sharing from the preceding immutable snapshot plus a validated changed-path set. A full-catalog reread is a bounded startup/recovery operation, not the warm search path. Every build has explicit time, byte, and retry budgets; exhaustion returns `snapshot_unavailable` rather than mixing observations or retrying indefinitely.

**Publication algorithm:**

1. Capture `baseGeneration` and the bridge's invalidated-path set. For a Change Set, subscribe to Vault/cache/graph events before its first mutation and retain an operation-local event-arrival record.
2. Freeze expected raw bytes/Content Versions for changed notes and hashes for attachments. Collect the host metadata/graph projections covered by the readiness barrier.
3. Re-read every covered raw state and verify its expected Content Version/hash immediately before publication. Confirm that no observed invalidation was added after collection began.
4. Atomically swap one immutable successor with `publishedGeneration = baseGeneration + 1`. Later events invalidate paths for a later generation; they never mutate the published snapshot.
5. On a changed generation, version mismatch, unbounded affected graph closure, or exhausted budget, discard the candidate and return a machine-readable failure.

This atomically prevents bridge readers from seeing a catalog assembled partly before and partly after publication. It does **not** prove that Obsidian's raw bytes, `MetadataCache`, and whole-Vault resolved graph shared one host-atomic instant: the public API exposes no cache-version or graph-commit token. A snapshot may claim cache/graph freshness only for records and edges covered by its completed readiness observations.

### 3.2 Successful write → discover/read barrier

After #7 executes a Change Set, #8 supplies this bounded readiness barrier before `succeeded` may publish:

1. **Authoritative reread:** verify each created/edited note's exact expected bytes and Content Version and each attachment's expected SHA-256. Verify expected absence/presence and host-returned canonical paths for moves, copies, and trash operations.
2. **Per-file cache observation:** for each modified Markdown file, require an operation-local post-subscription `metadataCache.changed` observation and then probe the cache projection expected from the final bytes.
3. **Rename observation:** for each move, require the corresponding Vault `rename` observation; never wait for `changed` as a rename signal. Probe the moved file's cache after the rename and derived rewrites.
4. **Graph observation:** wait for the configured operation-local `resolve`/`resolved` observations, then verify each registered rewritten reference through the applicable grammar profile and `getFirstLinkpathDest`. Record the original source-target edge's expected final resolved/unresolved state.
5. **Final byte/hash check and publication:** repeat authoritative checks after the probes, then atomically publish the successor Search Snapshot.

Only then may the Change Set status become `succeeded`. The guaranteed property is limited and explicit:

> Once `vault_change_set_status` reports `succeeded`, every later `vault_discover` and `vault_read` obtains the Vault Operation Bridge's atomically published successor snapshot, containing the expected final raw Content Versions and the cache/graph observations that passed the configured barrier.

This is bridge read-after-success, not proof of a host-native multi-file transaction, a causally versioned global Obsidian graph, or immediate synchronization of unrelated renderers/plugins. The installed-runtime cache/graph causality prototype is a blocking validation: it must show whether operation-local observations can reliably reject stale/late events and establish the required profile probes. If it cannot, the contract must retain only raw-byte read-after-success and label cache/graph projections unavailable until independently refreshed; it may not overstate coherence.

If a predicate times out or observes unexpected bytes/cache/graph state, do not publish the candidate. Return the cache/link failure facts required by #12 and hand the outcome to #7's rollback/recovery path. Never silently rebuild a result from whatever Vault state happens to be current.

### 3.3 Search ordering and snapshot-bound metadata/heading results

The #5 discovery contract requires deterministic results. Define one versioned comparator:

1. `path`: lexicographic ascending ECMAScript UTF-16 code units, shorter equal prefix first;
2. fixed projection-kind rank: `discovery`, `metadata`, `outline`, `section`, `exact`;
3. a bridge-generated token ordinal derived from frozen bytes, not an undocumented host offset unit; and
4. original request index where `vault_read` preserves caller order and duplicate paths.

`localeCompare`, locale collation, Unicode normalization, and case folding are prohibited. Serialize the comparator version and stable tuple with the snapshot. Pagination/continuation carries the frozen order, `snapshotId`, and item Content Versions.

A `metadata` or `outline` result is an **exact snapshot-bound semantic projection**: the unmodified host-cache projection observed for that snapshot record plus its Content Version. It is not byte-exact Frontmatter or source text. Parsed Frontmatter does not preserve comments, duplicate-key spelling, lexical scalar forms, ordering, indentation, quoting, BOM, or newline bytes; those require Exact Read/raw-byte evidence.

For each heading, return:

```text
text, level, hierarchy: [ancestor text ..., text], occurrence,
hostPosition, tokenOrdinal, contentVersion
```

`hierarchy` plus `occurrence` is the #5 **section-read selector**. If equal hierarchies occur, omission of `occurrence` returns deterministically sorted candidates and fails. Host `Pos` is labelled as a host source location whose offset unit is not documented as UTF-8 bytes. A heading projection is exact only as a semantic observation bound to the snapshot and Content Version.

## 4. Deterministic link resolution and style-preserving rewriting

### 4.1 Resolution rules owned by registered grammar profiles

`getFirstLinkpathDest` exposes a host **best** destination, but neither the complete candidate set nor documented ambiguity/precedence rules. The Vault Operation Bridge therefore supports references only through versioned, installed-runtime-validated **grammar profiles**. Each profile defines:

- tokenization and the exact source token boundary;
- decoding/escaping, angle-bracket and title handling;
- extraction of the file linkpath separately from fragment and display syntax;
- source-relative versus Vault-relative semantics and extension inference;
- candidate enumeration, tie handling, heading/block fragment policy; and
- a style-preserving renderer plus post-render host validation.

For each registered link/embed candidate:

1. Parse the frozen raw source into a `ReferenceIntent`: `sourcePath`, profile/version, raw token and link spelling, extracted file linkpath, optional fragment, alias/display/title, embed flag, host `Pos`, and verified raw-byte span.
2. Enumerate candidates under that profile. Exact host-returned canonical paths are identities; every short/basename form must yield one candidate under the installed and validated precedence rules.
3. Pass only the profile-defined **file linkpath**—not fragment, alias, title, or wrapper—to `metadataCache.getFirstLinkpathDest(fileLinkpath, sourcePath)` and require the same `TFile`. Agreement is necessary compatibility evidence, not proof that the bridge reconstructed every undocumented host candidate.
4. Validate any fragment using the profile and target snapshot. `occurrence` is only a bridge section-read selector and is never link syntax. A duplicate `#heading` is rejected unless the operation maps it to a separately renderable, registered, host-validated stable target such as a supported block reference.

A profile's candidate precedence must be proven against the installed Obsidian release. Until then the form is unsupported, rather than guessed or labelled “strictly compatible.” Any tie, host disagreement, noncanonical spelling, or unsupported decoding/rendering fails preflight with candidates and evidence. This preserves #6's “every uniquely resolvable registered reference” requirement by making the registered set explicit; it does not silently narrow host semantics with an invented precedence.

### 4.2 Rewrite renderer

A move's `update_resolved_references` closure is calculated from the frozen preflight snapshot before any file mutation. Every rewrite is a visible derived operation with this evidence:

```text
sourcePath, sourcePreVersion, hostPos, verifiedStartByte, verifiedEndByte,
rawOriginal, oldTargetPath, newTargetPath, targetPreVersion,
profileVersion, fragmentIdentity, linkForm, styleTemplate,
renderedReplacement, expectedSourcePostVersion
```

MetadataCache `Pos` is a locator only; the public API does not define it as a UTF-8 byte offset. The raw-byte/source-span adapter must locate and validate the complete registered token against frozen raw UTF-8 bytes, derive its own `{startByte, endByte}`, and record both positions. A mismatch, non-unique raw token, invalid UTF-8 boundary, or unsupported tokenization rejects preflight. Only independently verified byte spans are applied, in descending byte-offset order; a whole-Vault regular-expression replacement is forbidden.

A `styleTemplate` preserves, byte-for-byte where valid:

- wikilink versus Markdown-link versus embed syntax;
- embed marker, alias/display text, title, wrappers, and surrounding whitespace;
- fragment spelling when that fragment remains uniquely host-valid;
- extension-elision and relative-versus-Vault-relative style when the registered renderer can still name the selected target; and
- percent escaping and source spelling outside the rewritten destination component.

Only the destination component is rendered anew. If a move makes the old style invalid or non-unique, the profile may use only its smallest deterministic, installed-runtime-validated equivalent. If none exists, reject preflight with `unsupported_reference_form`; never degrade to plain text or invoke preference-controlled automatic rename.

A heading rename/refactor is **not** implied by a file move. Preserve a fragment only when it still resolves uniquely to the same target identity. An `occurrence` value never authorizes fragment rendering; changing a duplicate heading target requires an explicitly registered and host-valid stable representation, otherwise reject it.

### 4.3 Reference coverage and non-guarantees

The initial guaranteed rewrite domain is the versioned registered-reference manifest, not a blanket claim over all Markdown-looking text. The manifest enumerates `CachedMetadata.links`, `embeds`, `frontmatterLinks`, `referenceLinks`, and every excluded cache category separately. For each grammar profile/category it states discovery visibility, resolution semantics, whether note moves and attachment moves enter its rewrite closure, renderer behavior, and precise rejection/non-guarantee behavior. The API metadata shape is the primary-source boundary for this inventory ([`CachedMetadata`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2022-L2049)).

Plain prose, code fences, query strings, plugin-specific syntaxes, arbitrary HTML, and unregistered attachment-reference forms are not automatically rewritten. If preflight detects an unsupported form inside a category the requested semantic guarantee covers, it rejects with source evidence; undetectable custom syntax remains a documented non-guarantee. This is safer than silently altering unrelated text, but the manifest prototype must prove that the registered set satisfies #6's required wikilink, embed, Markdown-link, and attachment-reference closure before implementation planning.

## 5. CJK paths, attachments, and rollback-facing semantic evidence

### 5.1 CJK and byte identity

Use UTF-8 JSON bodies over MCP, as required by the transport and [RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259#section-8.1). Retain raw path/link/heading/alias spelling separately from the host-returned canonical `TFile.path`. Never normalize or case-fold spelling for comparison or rendering.

On admission, resolve an existing supplied path through the host and require the returned `TFile.path` to equal the supplied canonical JavaScript string exactly; otherwise return `noncanonical_path_spelling`. Create/move preflight must reject every destination that collides under the installed Vault/filesystem's observed lookup behavior, including case-only and normalization-equivalent aliases. The validation corpus must establish Windows behavior for these collisions; the bridge's no-normalization rule cannot change filesystem behavior.

For Exact Read, continuation, rewrite, and pre/post evidence, retain original UTF-8 bytes, BOM presence, and newline form. A JavaScript string, parsed Frontmatter object, host `Pos`, or metadata-cache entry cannot reconstruct those bytes. Content Version and concatenation verification operate over frozen raw bytes.

### 5.2 Attachments

Attachments are files, not notes. Their state evidence is `{canonicalPath, sizeBytes, sha256, exists}`; it uses binary APIs rather than text parse/render logic ([Vault binary methods](https://docs.obsidian.md/Reference/TypeScript+API/Vault)). `copy_attachment` and `move_attachment` retain #6's `expectedSha256` precondition.

`copy_attachment` does not rewrite existing references. `move_attachment` must include every uniquely resolved registered attachment-reference profile in its derived-rewrite closure, including the manifest's supported wikilinks, embeds, Markdown links, and Frontmatter/reference-style forms. Any covered form that cannot be uniquely resolved, byte-located, rendered, and post-validated rejects the entire Change Set. Attachments themselves have no headings/Frontmatter/Content Versions; their binary hash is the comparison identity, while each referring note has its own Content Version.

### 5.3 Semantic evidence consumed by #7

Before executing an affected move, provide #7 with the frozen rewrite closure and all semantic preconditions above. For recovery, #7 must be able to determine whether a compensation is still safe without recomputing current link semantics. The evidence supplied by #8 therefore includes:

- exact source-note pre-bytes / Content Version and target identity for every derived rewrite;
- exact attachment pre-hash and location when applicable;
- all expected post-bytes / Content Versions and post-resolution assertions; and
- the final post-barrier cache/graph observations, or the specific missing predicate on failure.

On rollback, restoring the pre-image restores the original link spelling, aliases, CJK text, heading fragments, and attachment relationship. The rollback implementation belongs to #7; this issue's rule is that it restores captured bytes, not a newly generated “equivalent” link form. If the post-image no longer has the expected version/hash, an outside writer may have intervened: the bridge must fail closed and block further writes pending #7 recovery, rather than overwrite that writer while pretending rollback was clean.

## 6. Concurrency and failure behavior

| Situation | Required behavior |
| --- | --- |
| Two Agent Sessions discover while a Change Set is executing | Each sees one immutable prior/successor Search Snapshot. No discovery page may combine the two. |
| A reader holds an old continuation | `vault_continue` returns frozen old bytes/metadata if retained; otherwise `snapshot_unavailable`. It never recomputes against current bytes. |
| A Change Set is queued after discovery | #6's post-lease preflight compares observed Content Versions and declared Read Dependencies with the current bridge snapshot. A mismatch rejects the Change Set. |
| The Primary Operator edits a source/target/reference note outside the bridge | Detect by generation/version mismatch or event evidence; reject before mutation when possible. If observed during/after mutation, do not publish success; enter #7's failure/recovery handling. |
| Metadata changes but cache/graph predicates do not settle | Return a distinct coherence failure after the configured bounded wait. No success acknowledgement and no search snapshot publication. |
| A reference resolves to multiple candidates, heading hierarchy repeats, or a host result disagrees | Fail preflight with deterministic candidates/evidence. Never select “first”. |
| Existing style cannot safely render the moved target | Fail preflight as unsupported; do not call the preference-controlled FileManager rename helper as a fallback. |
| Transport retry | Preserve #6 Submission Key behavior. The semantic closure/fingerprint is immutable for that key; a changed plan requires a new Submission Key. |

## 7. Guarantees and non-guarantees

### Guarantees after the recommendation and blocking validations are implemented

1. **Bridge read-after-success:** after `succeeded`, all bridge discovery/read tools obtain the atomically published successor snapshot with expected final Content Versions; metadata/link/heading fields carry the completed readiness observations and freshness scope, not a claim of host-global atomicity.
2. **Exact result identity:** every discovery/metadata/outline/section/exact result is bound to one Content Version and immutable snapshot; only Exact Read/raw evidence is byte-exact.
3. **Deterministic section selection:** complete hierarchy plus occurrence prevents a repeated heading from being silently selected for bridge reads; occurrence is not rendered as a link fragment.
4. **Deterministic registered references:** a rewrite occurs only through an installed-runtime-validated grammar profile for a unique, host-agreeing target with a validated renderer; each rewrite is an explicit derived Change Set operation.
5. **Style-preserving rollback evidence:** independently verified byte spans, source bytes, and rewrite provenance let #7 restore captured syntax rather than recomputing current semantics.
6. **CJK/Windows safety:** paths/text travel as UTF-8 JSON body values; canonical host spelling, actual collision behavior, and raw byte evidence are validated without bridge normalization.

### Non-guarantees

1. Obsidian does not publicly supply a cross-file transaction, global writer lock, causal cache-version, or graph-commit token.
2. Public events alone do not prove a host-atomic metadata/whole-graph snapshot; the bridge records bounded readiness observations and must expose their freshness scope.
3. The bridge cannot isolate unaffiliated native/plugin/filesystem writers; it detects conflicts and follows #7's fail-closed recovery policy.
4. `FileManager.renameFile()` cannot satisfy deterministic rewrite/rollback semantics because it follows Primary Operator preferences.
5. Plain text and unsupported/plugin-specific syntaxes are not rewritten automatically.
6. A host “best destination” is a necessary compatibility check, not a documented ambiguity proof.
7. Success does not promise immediate synchronization of every external UI/plugin consumer.

## 8. Development-ready acceptance matrix

| ID | Setup/action | Expected assertion |
| --- | --- | --- |
| S1 | Edit a note's body/Frontmatter, then immediately discover/read from another Agent Session. | No `succeeded` before raw postconditions and the configured readiness barrier; after success both tools return the successor Content Version, snapshot-bound semantic projection, and separate Exact Read byte evidence. |
| S2 | Open a discovery page, mutate a matching note, then request the next page. | Continuation retains old snapshot/order/versions or returns `snapshot_unavailable`; it never inserts current results. |
| S3 | Exact Read a CJK note containing BOM, CRLF, emoji, and repeated identical link text through multiple chunks. | UTF-8 ranges reconstruct original bytes; Content Version, BOM, newline form, and adjacent bytes remain exact. |
| S4 | Request section `A > B` where two equal hierarchies occur. | Omitted occurrence returns candidates/error; supplied occurrence selects the exact frozen-byte section. No occurrence is emitted as link syntax. |
| S5 | Change Frontmatter without changing headings. | Snapshot-bound metadata changes only after the configured observation; outline remains semantically correct under the same Content Version, while Exact Read separately proves lexical bytes. |
| S6 | Move a CJK-named note referenced by each registered wikilink/embed/Markdown profile. | Every uniquely resolvable registered source is a visible derived rewrite; style is preserved when profile-valid; final host resolution is the moved target. |
| S7 | Give duplicate basename candidates, and separately root-relative/source-relative conflicts. | The installed profile's precedence yields one proven target or preflight rejects with deterministic candidates; no invented fallback. |
| S8 | Move a target reached through a duplicate heading fragment. | Reject; occurrence alone cannot make the link renderable. Only an explicit registered, host-valid stable block/fragment mapping may pass. |
| S9 | Repeat S6 with Obsidian automatic link-update preference enabled and disabled. | Identical bridge closure/result; no `FileManager.renameFile()` dependency. |
| S10 | Copy and then move a CJK-path attachment referenced by registered wikilink, Markdown link/embed, reference-style, and Frontmatter profiles. | Copy leaves references unchanged; move rewrites all uniquely resolved registered references; binary SHA-256 and note Content Versions hold. |
| S11 | Inject an external source edit after post-lease preflight but before rewrite. | No `succeeded`; no overwrite of the external edit; #7's conflict/recovery rules apply. |
| S12 | Withhold `changed`, rename, `resolve`, or configured graph evidence until timeout. | Typed coherence facts, no successor publication or false success; retryability/guidance is delegated to #12. |
| S13 | Force rollback after one derived rewrite. | Restored bytes exactly equal captured pre-bytes, including CJK/emoji/newlines/BOM; attachment hash/path and original resolution match. |
| S14 | Encounter code-fence/plain-text/plugin-specific target syntax. | Never silently rewrite; reject when it falls inside a promised manifest category, otherwise report the documented non-guarantee. |
| S15 | Queue stale `changed`/`resolve` events before mutation and deliver them afterward. | Operation-local causality prototype proves they cannot alone satisfy the barrier; otherwise stronger cache/graph success is unsupported. |
| S16 | Write externally after final reread but before snapshot swap. | Version/generation/final-check logic rejects or records the unavoidable public-API limitation; it never labels an unverified host-global graph coherent. |
| S17 | Deliver `changed` before `resolve`/`resolved`; create/delete a target that changes edges from untouched notes. | No whole-graph freshness claim until affected closure and configured graph observations are validated. |
| S18 | Exercise `.md` elision, `../`, spaces, `%20`, `%23`, Markdown title/angle brackets, aliases, and repeated raw tokens. | Each registered profile tokenizes/decodes/renders identically to installed host behavior or is unsupported and rejected. |
| S19 | Exercise `frontmatterLinks` and `referenceLinks`. | Manifest states discovery and note/attachment move behavior for each category; no implicit links/embeds-only claim. |
| S20 | Edit a link beside CJK, astral emoji, CRLF, BOM, and duplicate token text. | Host `Pos` is never used as byte offset; independently verified byte span changes exactly one intended token. |
| S21 | Resolve/create/move paths with case-only and NFC/NFD-equivalent spellings on target Windows Vault. | Noncanonical existing spelling is rejected; observed filesystem aliases collide; raw link spelling remains distinct from canonical target identity. |

## 9. Recommended implementation seams

Keep these as separate modules/interfaces so each assertion in the matrix can be tested without product UI or MCP transport code:

1. **Snapshot builder/publisher** — structural sharing, bounded recovery rebuild, immutable records, Content Versions, freshness scope, and atomic publication.
2. **Cache/graph readiness observer** — pre-subscribes, records operation-local events/probes, performs final byte checks, and emits facts consumed by #12.
3. **Heading selector** — hierarchy/occurrence section reads without conflating occurrence and link syntax.
4. **Registered-reference manifest/resolver** — profile tokenization, candidate enumeration, host-agreement check, fragment identity, and ambiguity evidence.
5. **Raw-byte locator/renderer** — maps host locations to independently verified token byte spans and applies style templates without global regex.
6. **Semantic evidence adapter** — gives #7 immutable pre/post link and attachment evidence; it owns neither queue nor Recovery Journal.

## 10. Required Wayfinder follow-ups

These questions are now sharp enough to be tickets, not fog:

1. **Validate installed cache and graph causality.** Determine whether the target Obsidian release's public events/probes can reject stale observations and implement a bounded per-Change-Set readiness barrier; if not, specify the weaker cache/graph freshness contract.
2. **Specify registered reference grammar and renderer profiles.** Define and validate tokenization, decoding, candidate precedence, fragment behavior, rendering, and manifest coverage for links, embeds, Frontmatter/reference-style links, and attachment moves.
3. **Validate the raw-byte source-span adapter.** Prove supported plugin-host byte-preserving reads/writes, BOM/CRLF behavior, and safe mapping from host source locations to verified UTF-8 token spans across CJK/emoji/repeated text.

Do not create duplicate follow-ups for external-writer recovery, snapshot retention, or cross-tool error semantics: route those findings respectively to [#7](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/7), [#11](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/11), and [#12](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12).

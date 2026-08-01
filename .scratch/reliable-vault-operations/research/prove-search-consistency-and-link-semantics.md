# Prove search consistency and link semantics

**Research date:** 2026-08-01  
**Issue:** [#8 — Prove search consistency and link semantics](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/8)  
**Decision recommendation:** accept the contracts below as the implementation target for the **Vault Operation Bridge**. The bridge may promise read-your-successful-Change-Set consistency only after its own versioned snapshot and cache-observation barrier completes. It must not represent an individual Obsidian API call, `MetadataCache`, or `FileManager.renameFile()` as a multi-file transaction or unconditional link-rewrite guarantee.

## 1. Scope and fixed decisions

This document uses the vocabulary defined in [`CONTEXT.md`](../../../CONTEXT.md): **Primary Operator**, **ThinkFlywheel Vault**, **Vault Operation Bridge**, **Change Set**, **Exact Read**, **Content Version**, **Agent Session**, **Submission Key**, **Read Dependency**, and **Recovery Journal**.

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
| `Vault.process()` is documented as an atomic read-modify-save operation for **one** note. | [Vault.process](https://docs.obsidian.md/Reference/TypeScript+API/Vault/process) | It is useful only for an individual guarded mutation; it is not a multi-file Change Set transaction. |
| `MetadataCache.getFileCache()` / `getCache()` expose cached metadata; `CachedMetadata` includes `frontmatter`, `headings`, `links`, and `embeds`. | [MetadataCache reference](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache); [official declarations: `CachedMetadata`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2022-L2049) | The plugin can obtain the host's parsed metadata and the location-bearing link/embed records; it need not invent a second Markdown parser as semantic authority. |
| `MetadataCache.getFirstLinkpathDest(linkpath, sourcePath)` finds the best destination; `resolvedLinks` and `unresolvedLinks` expose the host link graph. | [official declarations: link APIs](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4404-L4444) | Host resolution is the compatibility check for a proposed reference. It is not a documented ambiguity report or a format-preserving rewrite facility. |
| `metadataCache.on("changed", ...)` fires after a file is indexed and updated metadata is available; it does **not** fire for renames. `resolve`/`resolved` describe link-graph processing; the Vault also has a rename event. | [MetadataCache events](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache/on('changed)); [official declarations: metadata events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4446-L4472); [official declarations: Vault events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7567-L7593) | A `changed` observation can prove cache availability for a changed file, but never proves rename cache readiness. Rename requires the Vault rename observation plus re-querying the cache/graph. |
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
snapshotId, bridgeGeneration,
records[path] = {
  path (exact canonical Vault-relative spelling),
  fileKind, sizeBytes, contentVersion,
  frontmatter, headings, links, embeds,
  resolvedOutgoing, unresolvedOutgoing
}
```

`contentVersion` is the #5/#6 **Content Version**: a SHA-256-compatible identity for the exact state represented by the record. The snapshot must retain the exact raw bytes separately when it backs Exact Read or a `vault_continue` payload; metadata alone is never an Exact Read substitute.

**Publication algorithm:**

1. Read a bridge generation before collecting candidate records.
2. Collect paths and their Content Versions, then their metadata/graph projection from the plugin-held host APIs.
3. Read the generation again and verify each collected record still has the recorded Content Version.
4. If either check differs, discard the candidate and retry from step 1. Bound retries; return a machine-readable `snapshot_unavailable` rather than mixing generations.
5. Publish only the completed immutable record set, keyed by `snapshotId`; all discovery page tokens and read continuations refer to that frozen object.

The generation changes for every observed Vault create/modify/delete/rename and for every bridge-applied Change Set publication. It is an Operation Layer consistency detector, not a substitute for Obsidian events. This makes concurrent reads safe: a reader sees either the preceding bridge snapshot or the successor snapshot, never an internally mixed catalog.

### 3.2 Successful write → discover/read barrier

After #7 has executed a Change Set, the #8 semantic layer must perform the following before allowing `succeeded` to publish:

1. **Authoritative reread:** verify every created/edited note's exact expected bytes and Content Version and every attachment's expected SHA-256. Verify expected absence/presence and exact canonical paths for moves, copies, and trash operations.
2. **Per-file metadata predicate:** for every modified Markdown file, observe a post-mutation `metadataCache.changed` event and then read the cache used for projections. The cache must describe the expected headings/frontmatter/link/embed parse, or the barrier fails.
3. **Rename predicate:** for every move, observe the corresponding Vault `rename` event; do not wait for `metadataCache.changed` as a rename signal. Re-query the moved file's cache and the resolved/unresolved graph after the rename/derived rewrites.
4. **Graph predicate:** for every derived rewrite, resolve its rendered target from its source through `getFirstLinkpathDest`, check it is the expected file, and check the original source-target edge no longer appears as a resolved edge. Where a changed reference is intentionally unresolved, verify that exact unresolved graph entry instead.
5. **Snapshot publication:** build and validate one successor Search Snapshot containing the expected final Content Versions and semantic projections. Advance `bridgeGeneration` and make that snapshot visible atomically to the read/search tools.

Only then may the Change Set status become `succeeded`. The guaranteed property is:

> Once `vault_change_set_status` reports `succeeded`, every subsequent `vault_discover` and `vault_read` from any Agent Session obtains a bridge snapshot that contains the successful Change Set's expected Content Versions and semantic projections.

This is **read-your-successful-Change-Set through the Vault Operation Bridge**. It does not claim that an unrelated renderer, a third-party plugin, or an external filesystem process has synchronized at the same instant.

If any predicate times out or observes unexpected bytes/cache/graph state, do not publish the candidate snapshot. Report a structured `cache_coherence_timeout`, `postcondition_mismatch`, or `external_write_conflict`; hand the outcome to #7's rollback/recovery path. Do not “solve” the mismatch by silently rebuilding the search result from current Vault state.

### 3.3 Search ordering and exact metadata/heading results

The #5 discovery contract requires deterministic results. Define a total ordering independent of event arrival:

1. primary key: canonical Vault-relative `path`, ordinal code-unit comparison;
2. secondary key: record type/order declared by the projection schema;
3. tertiary key: source position start offset; and
4. final key: original request index where `vault_read` must preserve caller order and duplicate paths.

Do not Unicode-normalize, case-fold, locale-sort, or normalize newline text for keys; #6 explicitly forbids it for Vault paths. Keep the exact `TFile.path` spelling as the identity. A query's result page must include `snapshotId`, each item Content Version, and the stable sort key; pagination/continuation carries that frozen order.

For a `metadata` result, return the exact parsed metadata projection for the snapshot record (including exact frontmatter values/keys, links/embeds as cached, and the record's Content Version), not a convenience reconstruction from later bytes. For an `outline`/heading result, return for each heading:

```text
text, level, hierarchy: [ancestor text ..., text], occurrence, source position,
contentVersion
```

`hierarchy` is the #5 selector. If equal hierarchies occur, `occurrence` is required; omission returns the deterministically sorted candidate occurrences and fails. A heading result is exact only relative to the snapshot's bytes/metadata and Content Version. It is not a claim that a repeated heading title is globally unique.

## 4. Deterministic link resolution and style-preserving rewriting

### 4.1 Resolution rules owned by the Operation Layer

The Obsidian host exposes a **best** destination through `getFirstLinkpathDest`; its public type does not expose every candidate or document a complete ambiguity explanation. Therefore the bridge must make ambiguity a first-class preflight outcome rather than treating the returned first result as proof that ambiguity cannot exist.

For each link/embed candidate discovered in a source record:

1. Parse the cached source span into a `ReferenceIntent`: `sourcePath`, link form, raw destination, optional heading/block fragment, alias/display, embed flag, and exact source span.
2. Build an explicit candidate set from the frozen Search Snapshot using the bridge's documented resolution forms. At minimum, canonical Vault-relative file paths are unique; a basename/short form with multiple eligible files is `ambiguous`.
3. Select only a unique candidate according to the published rules below, then require `metadataCache.getFirstLinkpathDest(rawDestination, sourcePath)` to return the same `TFile`. A disagreement is `host_resolution_mismatch`, not a reason to guess.
4. Resolve heading and block fragments against the target snapshot record. For headings, the matching hierarchy/occurrence must be unique; a duplicate title without an explicit occurrence is `ambiguous_heading`. Do not silently target the first heading.

**Published selection order:**

1. exact canonical Vault-relative path (with the requested file extension),
2. exact canonical Markdown path when the syntax legally omits `.md`,
3. an unambiguous source-relative canonical path, then
4. an unambiguous basename/short-name match.

Any form outside this list, or any tie at a level, is rejected. This is intentionally stricter than undocumented “best match” behavior: a Change Set may only rewrite references whose target identity can be proved and whose expected host resolution agrees.

### 4.2 Rewrite renderer

A move's `update_resolved_references` closure is calculated from the frozen preflight snapshot before any file mutation. Every rewrite is a visible derived operation with this evidence:

```text
sourcePath, sourcePreVersion, sourceSpan, rawOriginal,
oldTargetPath, newTargetPath, targetPreVersion,
resolvedBy, fragmentIdentity, linkForm, styleTemplate,
renderedReplacement, expectedSourcePostVersion
```

Use source-span edits, applied in descending byte-offset order after checking that every span still equals `rawOriginal`. Never use a whole-Vault regular-expression replace.

A `styleTemplate` preserves, byte-for-byte where valid:

- wikilink versus Markdown-link versus embed syntax;
- embed marker, alias/display text, title, and surrounding whitespace;
- fragment spelling (`#heading` / block reference) when that fragment remains semantically valid;
- extension-elision and relative-versus-vault-relative style when it can still name the selected target; and
- percent-escaping/other source spelling outside the rewritten destination component.

Only the destination component is rendered anew. If a destination move makes the old style invalid or non-unique, use the smallest deterministic equivalent permitted by the documented renderer (normally canonical Vault-relative form). If no valid renderer is defined for a cached reference form, reject preflight with `unsupported_reference_form`; do not degrade it to plain text or rely on a preference-controlled automatic rename.

A heading rename/refactor is **not** implied by a file move. Preserve a fragment only after resolving it to the same target heading identity. Changing a fragment requires an explicit, preflight-resolved heading mapping; otherwise reject it as `stale_or_missing_heading`.

### 4.3 Reference coverage and non-guarantees

The initial guaranteed rewrite domain is only the explicitly registered, cache-backed reference forms that the bridge can parse, locate, resolve, render, and verify: Markdown links and Obsidian links/embeds represented by the snapshot's `links` / `embeds` metadata. The API's metadata shape is the primary-source boundary for this claim ([`CachedMetadata`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2022-L2049)).

Plain prose, code fences, query strings, plugin-specific syntaxes, arbitrary HTML, and an attachment reference form not represented/validated by the registered parser are **not** automatically rewritten. If preflight detects such a reference that the requested semantic guarantee would cover, it must reject with an actionable diagnostic; undetectable custom syntax is a documented non-guarantee. This limitation is safer than silently altering unrelated text or claiming complete backlink semantics.

## 5. CJK paths, attachments, and rollback-facing semantic evidence

### 5.1 CJK and byte identity

Use UTF-8 JSON bodies over MCP, as required by the transport and [RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259#section-8.1). Retain path and heading strings exactly as received from the ThinkFlywheel Vault / host cache. No Unicode normalization (NFC/NFD), case-folding, locale collation, or newline normalization is permitted for a path, link destination, heading identity, alias, or comparison key. These are #6 contract requirements, not an assumption about filesystem behavior.

For Exact Read, continuation, and pre/post evidence, retain the original UTF-8 byte sequence, BOM presence, and original newline form required by #5. A JavaScript string, a parsed frontmatter object, or a metadata cache entry is not sufficient to reconstruct those bytes. Content Version calculation and concatenation verification operate over the frozen raw bytes.

### 5.2 Attachments

Attachments are files, not notes. Their state evidence is `{canonicalPath, sizeBytes, sha256, exists}`; it uses binary APIs rather than text parse/render logic ([Vault binary methods](https://docs.obsidian.md/Reference/TypeScript+API/Vault)). `copy_attachment` and `move_attachment` retain the #6 `expectedSha256` precondition.

Attachment links/embeds can enter a note move's derived-rewrite closure only when the bridge's registered parser resolves the attachment uniquely and validates the final renderer against the post-write snapshot. Attachments themselves do not have headings/frontmatter/Content Versions. A binary hash is their comparison identity, while each referring note has its own Content Version.

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

### Guarantees after the recommendation is implemented

1. **Bridge read-after-success:** after `succeeded`, all bridge discovery/read tools see the final Content Versions and verified metadata/link/heading snapshot.
2. **Exact result identity:** every discovery/metadata/outline/section/exact result is bound to one Content Version and one immutable snapshot; Exact Read retains its original bytes.
3. **Deterministic headings:** complete hierarchy plus occurrence prevents a repeated heading from being silently selected.
4. **Deterministic registered references:** a rewrite occurs only for a unique, host-agreeing target with a validated renderer; each rewrite is an explicit derived Change Set operation.
5. **Style-preserving rollback evidence:** source bytes and rewrite provenance are sufficient for #7 to restore captured original syntax rather than recomputing semantics during recovery.
6. **CJK safety:** paths/text travel as UTF-8 JSON body values and retain exact path spelling/byte evidence without normalization.

### Non-guarantees

1. Obsidian does not publicly supply a cross-file transaction, global writer lock, or causal cache-commit token; these cannot be claimed as native host guarantees.
2. The bridge cannot promise isolation from unaffiliated native/plugin/filesystem writers; it detects and fails closed rather than overwriting unknown changes.
3. `FileManager.renameFile()` cannot satisfy deterministic rewrite/rollback semantics because it follows the Primary Operator's preferences.
4. Plain text and unsupported/plugin-specific link syntaxes are not rewritten automatically.
5. A host “best destination” is not accepted as a documented ambiguity proof; strict operation-layer ambiguity rules may reject a link Obsidian would display as a best effort.
6. Success does not promise immediate synchronization of every external UI/plugin consumer, only the bridge's authoritative post-barrier snapshot.

## 8. Development-ready acceptance matrix

| ID | Setup/action | Expected assertion |
| --- | --- | --- |
| S1 | Edit a note's body/frontmatter through a Change Set, then immediately run `vault_discover` and `vault_read` from another Agent Session. | Status is not `succeeded` until the successor snapshot has the edited Content Version, exact metadata, and headings; both tools return it immediately after success. |
| S2 | Open a discovery page, mutate a matching note, then request the next page. | Continuation retains the old snapshot/order/content versions or returns `snapshot_unavailable`; it never inserts current results. |
| S3 | Exact Read a CJK note containing BOM and CRLF through multiple transport chunks. | Inclusive/exclusive UTF-8 offsets concatenate to the original bytes; SHA-compatible Content Version, BOM, and newline form match exactly. |
| S4 | Request section `A > B` where two `A > B` headings occur. | Without `occurrence`, deterministic candidates and error; with occurrence, exact selected byte range and Content Version. |
| S5 | Change title/frontmatter without changing a heading, wait for cache barrier. | Metadata result changes only after its `changed` predicate; outline/section retain correct heading identity and exact version. |
| S6 | Move a CJK-named note whose sources use wikilink alias, embed, Markdown relative link, and extension-elided link. | Every registered unique source is a visible derived rewrite; syntax/alias/embed/fragment style is preserved when valid; final host resolution is the moved target. |
| S7 | Move a note with duplicate basename candidates and a bare link. | Preflight rejects `ambiguous_reference`; no host move/rewrite begins. |
| S8 | Move a note with a duplicate heading fragment in target. | Preflight rejects `ambiguous_heading` unless an explicit occurrence/heading mapping proves the destination. |
| S9 | Run S6 with Obsidian automatic link-update preference enabled and disabled. | Identical bridge-derived closure/result in both runs; no reliance on `FileManager.renameFile()`. |
| S10 | Move/copy an attachment with CJK path and a referring registered embed. | Binary pre/post SHA-256 evidence holds; referring note rewrite resolves to final attachment; source and attachment values retain exact spelling. |
| S11 | Inject an external source-note edit after post-lease preflight but before a derived rewrite. | No `succeeded`; expected source post-version mismatch enters failed/recovery path, and bridge does not overwrite the external edit. |
| S12 | Force absence of `changed`, Vault `rename`, or graph predicate until timeout. | Machine-readable coherence failure, no successor snapshot, no false success; #7 receives semantic failure evidence. |
| S13 | Force rollback after one derived rewrite. | Restored source bytes equal captured pre-bytes exactly, including CJK/alias/newline/BOM; restored resolution is the preflight target; attachment hashes/paths match pre-state. |
| S14 | Encounter code-fence/plain-text/plugin-specific target reference during a move. | It is not silently rewritten; if it is in the declared protected domain, preflight returns `unsupported_reference_form` with source evidence. |

## 9. Recommended implementation seams

Keep these as separate modules/interfaces so each assertion in the matrix can be tested without product UI or MCP transport code:

1. **Snapshot builder/publisher** — generation retry, immutable records, Content Versions, and continuation retention.
2. **Cache barrier observer** — subscribes before mutations, correlates `changed` and Vault rename events, performs reread/cache/graph predicates, and emits typed failures.
3. **Heading selector** — hierarchy/occurrence resolution over frozen metadata and exact byte ranges.
4. **Reference resolver** — candidate enumeration, host-agreement check, fragment identity, ambiguity diagnostics.
5. **Reference renderer** — source-span edit plan and style templates; no global regex.
6. **Semantic evidence adapter** — gives #7 immutable pre/post link and attachment evidence; it owns neither queue nor Recovery Journal.

## 10. Follow-up fog / candidate Wayfinder tickets

1. **Prototype host cache event correlation.** Validate on the installed Obsidian release whether create/modify/rename plus derived rewrites produce the expected ordering of Vault events, `changed`, `resolve`, and `resolved`; determine a bounded barrier implementation without assuming a global commit token.
2. **Specify registered reference grammar.** Record precisely which `CachedMetadata.links` / `embeds` forms cover Markdown links, wikilinks, embeds, block links, URLs, and attachments; classify unsupported plugin forms before promising complete move semantics.
3. **Prototype raw-byte Exact Read adapter.** Establish the supported plugin-host path for byte-preserving reads/writes that retains BOM and newline form while remaining inside the plugin semantic authority.
4. **Define external-writer detection policy.** Decide the operational response and diagnostics when native editing or another plugin races a Change Set, including when #7 may safely compensate versus requiring manual recovery.
5. **Define snapshot retention limits.** Choose memory/time limits for immutable discovery and Exact Read continuations and evaluate deterministic `snapshot_unavailable` behavior under large ThinkFlywheel Vault results.

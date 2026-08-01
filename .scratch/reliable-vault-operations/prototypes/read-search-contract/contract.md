# PROTOTYPE contract candidate: read and search

This is the concrete contract tested by the adjacent terminal harness. It is a planning artifact, not an implementation specification.

## Verdict

Expose three read-only MCP tools: `vault_discover`, `vault_read`, and `vault_continue`. Discovery handles every index-backed query and can return bounded context plus outlines in one call; reading handles ordered heterogeneous reads; continuation only carries an already-started response without changing its semantics.

A response is either fully valid under one observed set of Content Versions or is a machine-actionable error. Exact Read batches never partially succeed because of a logical size limit. Transport continuation may split delivery, but it never changes item order, content, or Content Versions.

## Shared rules

- A Vault path is a slash-separated, Vault-root-relative, case-preserving string. Inputs must not contain `.` or `..` segments, backslashes, absolute roots, or percent-encoded traversal.
- Every note identity includes `path`, `content_version`, and `size_bytes`. `content_version` is `sha256:<lowercase hex>` over the exact file bytes.
- Text is UTF-8 and exact. Exact Reads preserve Unicode, BOM presence, and newline bytes. Any decoded content response additionally reports `encoding: "utf-8"` and `newline` as `lf`, `crlf`, `cr`, `mixed`, or `none`.
- Line numbers are one-based for people and Claude. Byte offsets are zero-based UTF-8 byte offsets for deterministic anchoring.
- Every list has a declared deterministic ordering. No endpoint relies on filesystem enumeration, cache insertion, or relevance-score tie behavior.
- Unknown input fields are rejected. All enumerations and limits are explicit in the MCP input schemas.
- `vault_revision` is diagnostic only. Consistency is expressed by per-note Content Versions, not by pretending the whole Vault is an immutable snapshot.

## `vault_discover`

Use this tool whenever Claude needs to locate or compare notes without retrieving full bodies. One call composes index-backed predicates and selects the evidence needed for the next reasoning step.

### Input

```json
{
  "query": {
    "all": [
      {"path": {"glob": "Projects/**/*.md"}},
      {"text": {"query": "recovery journal", "case_sensitive": false}},
      {"frontmatter": {"key": "status", "op": "eq", "value": "active"}},
      {"tag": {"name": "architecture", "include_descendants": true}},
      {"link": {"direction": "outgoing", "target": "MOCs/MOC-Work.md"}}
    ]
  },
  "select": ["identity", "frontmatter", "matches", "outline", "links"],
  "context": {
    "before_lines": 2,
    "after_lines": 2,
    "max_chars_per_match": 800,
    "max_matches_per_note": 20
  },
  "order_by": [{"field": "path", "direction": "asc"}],
  "page": {"max_items": 100, "continuation": null}
}
```

`query` is a recursive boolean expression: `all`, `any`, or `not` around leaf predicates. MVP leaf predicates are:

- `path`: exact, prefix, or glob over canonical Vault paths;
- `name`: exact or substring over basename, with explicit case sensitivity;
- `text`: literal or regular-expression full-text matching, with explicit case sensitivity;
- `frontmatter`: key existence and typed `eq`, `neq`, `contains`, or numeric/date comparison;
- `tag`: exact tag or descendant inclusion;
- `link`: outgoing, backlink, unresolved, wikilink, embed, Markdown link, or attachment reference;
- `graph`: orphan, dead end, or degree comparison.

The same leaf object is never overloaded with multiple operators. Combinations use `all`/`any`, which keeps validation and error locations unambiguous.

`select` avoids follow-up calls. `identity` is always returned even if omitted. `matches` requires a text predicate. `outline` returns headings without content. Frontmatter and links return parsed evidence plus the note's Content Version.

### Result

```json
{
  "ok": true,
  "vault_revision": 418,
  "result": {
    "ordering": [{"field": "path", "direction": "asc", "tie_breaker": "path_utf8_bytes"}],
    "items": [
      {
        "note": {
          "path": "Projects/Bridge.md",
          "content_version": "sha256:…",
          "size_bytes": 7421
        },
        "matches": [
          {
            "line": 37,
            "start_offset": 980,
            "end_offset": 996,
            "text": "Recovery Journal",
            "context": {
              "start_line": 35,
              "end_line": 39,
              "text": "…",
              "truncated": false
            }
          }
        ],
        "outline": [
          {
            "level": 2,
            "title": "Failure handling",
            "hierarchy": ["Architecture", "Failure handling"],
            "occurrence": 1,
            "start_line": 30
          }
        ]
      }
    ],
    "complete": false,
    "continuation": "opaque:…"
  }
}
```

Match context is bounded independently per match and explicitly says whether it was truncated. Result pagination is by whole notes; a note and its selected evidence never straddle discovery pages.

Default ordering is canonical path by Unicode case-folded comparison, then exact UTF-8 path bytes as the tie-breaker. Text relevance is available only when explicitly requested and always ties by canonical path and match offset.

## `vault_read`

Use this tool after discovery when Claude knows which note bodies or sections it needs. `reads` is ordered and the result preserves exactly that order. A single call may mix metadata, outline, section, and Exact Read entries.

### Input

```json
{
  "reads": [
    {"path": "MOCs/MOC-Work.md", "mode": "outline"},
    {
      "path": "Projects/Bridge.md",
      "mode": "section",
      "content_version": "sha256:…",
      "heading": {
        "hierarchy": ["Architecture", "Failure handling"],
        "occurrence": 1
      },
      "include_heading": true,
      "include_descendants": true
    },
    {
      "path": "Sources/Large.md",
      "mode": "exact",
      "content_version": "sha256:…"
    }
  ],
  "transport": {"max_response_bytes": 1000000}
}
```

Modes:

- `metadata`: identity, parsed Frontmatter summary, tags, links, and newline/encoding facts;
- `outline`: heading level, title, full hierarchy, hierarchy occurrence, and line/byte range;
- `section`: exact bytes from the selected ATX heading through the next heading of equal or lower level, optionally excluding descendant sections;
- `exact`: complete note bytes represented as exact UTF-8 text, never excerpted or normalized.

A section is addressed by the complete heading hierarchy, not by a slug. `occurrence` is required only when the same complete hierarchy repeats. If omitted and ambiguous, the whole call fails with `ambiguous_heading` and returns candidates. If a supplied `content_version` is stale, the whole call fails before returning any content.

### Successful result

```json
{
  "ok": true,
  "vault_revision": 418,
  "result": {
    "order": [0, 1, 2],
    "items": [
      {
        "index": 0,
        "path": "MOCs/MOC-Work.md",
        "mode": "outline",
        "content_version": "sha256:…",
        "outline": []
      },
      {
        "index": 1,
        "path": "Projects/Bridge.md",
        "mode": "section",
        "content_version": "sha256:…",
        "range": {"start_offset": 700, "end_offset": 1400},
        "content": "## Failure handling\r\n…",
        "encoding": "utf-8",
        "newline": "crlf",
        "complete": true
      },
      {
        "index": 2,
        "path": "Sources/Large.md",
        "mode": "exact",
        "content_version": "sha256:…",
        "size_bytes": 163904,
        "start_offset": 0,
        "end_offset": 99821,
        "content": "…",
        "encoding": "utf-8",
        "newline": "mixed",
        "complete": false
      }
    ],
    "complete": false,
    "continuation": "opaque:…",
    "snapshot": {
      "content_versions": {
        "MOCs/MOC-Work.md": "sha256:…",
        "Projects/Bridge.md": "sha256:…",
        "Sources/Large.md": "sha256:…"
      }
    }
  }
}
```

### Exact Read grouping rule

The implementation publishes two installed-runtime limits through diagnostics:

- `max_logical_exact_read_bytes`: maximum aggregate exact bytes accepted in one `vault_read` call;
- `max_transport_response_bytes`: preferred response chunk size.

If the logical Exact Read limit is exceeded, the whole call fails with `exact_read_batch_too_large`. The error includes every requested path, Content Version, size, the active limit, and deterministic contiguous `suggested_groups` that preserve input order. No content is returned.

If only the transport limit is exceeded, the call succeeds and returns a continuation. That is not partial logical success: the complete ordered result has already been fixed under the returned Content Versions and is merely being carried over multiple MCP responses. Every transported content chunk identifies the originating request `index` (so duplicate paths remain distinct), `path`, `content_version`, zero-based UTF-8 byte `start_offset` and exclusive `end_offset`, exact `content`, and whether that request item is complete. Chunk boundaries are valid UTF-8 boundaries, and every response—including every continuation response—fits the active transport ceiling. Items remain in request order, but a page does not stop merely because earlier items already produced chunks: if the next item cannot fit whole, the transport adds the longest legal UTF-8 prefix whose complete compact JSON envelope still fits. A nonempty page ends only when its remaining capacity cannot carry one character of the next item plus metadata; `response_item_too_large` is reserved for an otherwise empty page that cannot carry even that minimum chunk.

## `vault_continue`

```json
{"continuation": "opaque:…"}
```

This tool accepts no query, path, limit, or projection changes. Its token is opaque, single-use, bound to the authenticated client, originating tool, exact validated request, result ordering, Content Versions, frozen content bytes, and the active transport ceiling. Each use returns the next real content chunk within that same ceiling and either another continuation or `null`; a continuation response uses the same request indices and byte ranges as the originating result, so concatenating each index's contiguous ranges reconstructs its exact bytes.

Continuation lifetime is an operational limit published through diagnostics and must be long enough for normal Claude reasoning between calls. The production error taxonomy distinguishes a token that was never issued (`invalid_continuation`), reuse of a single-use token (`continuation_consumed`), deterministic runtime expiry (`continuation_expired`), and any state that can no longer preserve the original bytes (`continuation_snapshot_unavailable`). None are silently restarted from current Vault state. This round-three in-memory prototype directly demonstrates unknown, consumed, and snapshot-unavailable states. It intentionally has no clock or expiry transition, so `continuation_expired` remains a required installed-runtime capability rather than a behavior claimed as prototype evidence.

## Error envelope

```json
{
  "ok": false,
  "vault_revision": 419,
  "error": {
    "code": "stale_content_version",
    "message": "One or more requested notes changed.",
    "retryable": false,
    "details": {
      "items": [
        {
          "path": "Projects/Bridge.md",
          "expected": "sha256:old",
          "actual": "sha256:new"
        }
      ]
    }
  }
}
```

The contract requires stable codes and typed details. Final retry guidance belongs to the cross-contract error taxonomy ticket; this prototype establishes these read/search conditions: `invalid_query`, `invalid_path`, `not_found`, `ambiguous_heading`, `heading_not_found`, `stale_content_version`, `exact_read_batch_too_large`, `response_item_too_large`, `invalid_continuation`, `continuation_expired`, `continuation_consumed`, `continuation_snapshot_unavailable`, `vault_unavailable`, and `internal_error`.

## Corpus observations shaping the contract

A read-only Obsidian CLI inspection on 2026-08-01 found:

- 915 Markdown notes in the currently open ThinkFlywheel Vault;
- sampled maximum note size of 163,904 bytes;
- the largest sampled notes had no parsed headings;
- at least two notes repeat a complete heading hierarchy;
- 782 notes had parsed Frontmatter;
- 4,049 parsed links and 248 parsed embeds;
- Unicode paths are routine.

These facts make Exact Reads, explicit byte limits, path-safe Unicode handling, and hierarchy occurrence disambiguation first-class rather than edge behavior.

## What the prototype settled

- One composable discovery tool avoids separate path/text/tag/backlink calls while keeping deterministic selection.
- One ordered heterogeneous read tool lets Claude combine outline, section, and Exact Reads in one round trip.
- A separate continuation tool keeps every semantic tool input clean and prevents accidental query mutation during pagination.
- Logical batch rejection and transport continuation must remain distinct.
- Content Versions belong on every evidence-bearing item and bind continuations; a Vault-wide revision cannot replace them.
- Heading hierarchy alone is insufficient because complete hierarchies can repeat; `occurrence` is the deterministic final discriminator.

## Deferred operational constants

The exact payload ceilings, automatic grouping thresholds, and continuation lifetime remain intentionally unspecified. They depend on installed-runtime validation of the plugin-hosted Streamable HTTP MCP endpoint. The contract fixes their semantics and discoverability without inventing values before measurement.

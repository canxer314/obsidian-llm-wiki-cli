# Decision: versioned registered-reference profiles

## Verdict

Adopt a closed, versioned profile registry rather than a universal Markdown parser. The installed runtime is the compatibility oracle, but never the ambiguity oracle: the Vault Operation Bridge must independently enumerate canonical candidates and reject unless exactly one candidate agrees with `MetadataCache.getFirstLinkpathDest`.

A registry version is pinned to all four values:

```text
profileSetVersion
installedObsidianVersion
platformAndFilesystemProfile
fixtureCorpusHash
```

Any change invalidates registration until the acceptance corpus passes again.

## MVP registration matrix

| Profile | Cache inventory | Destination component | Renderer promise | Move closure |
| --- | --- | --- | --- | --- |
| Wikilink | `links` | text before `#` or `#^`, excluding alias | Preserve `[[ ]]`, alias, fragment spelling, extension and path style when still unique | Notes and attachments |
| Wikilink embed | `embeds` | text before `#` or `#^`, excluding size/alias | Preserve `![[ ]]`, size/alias and fragment | Notes and attachments |
| Markdown inline | `links` | URL/destination inside `(...)`, excluding title | Preserve label, title quote form, angle wrapper and percent-escape style | Notes and attachments |
| Markdown embed | `embeds` | URL/destination inside `(...)`, excluding title | Preserve `!`, alt text, title quote form, angle wrapper and percent-escape style | Notes and attachments |
| Frontmatter registered link | `frontmatterLinks` | Wikilink or Markdown destination in an installed-runtime-observed scalar/list shape | Locate `original` against frozen raw YAML independently because cache `Pos` is absent; preserve every byte outside destination | Notes and graph-resolved attachments |
| Markdown reference-style | `referenceLinks` plus paired use/definition evidence | Definition destination, not the use label | Cache exposes definition position but not full original/style; independently pair and byte-verify definition before rewriting | Notes and graph-resolved attachments |

Registration of the last two profiles is conditional on the attached runtime observation plus the raw-byte source-span adapter proving unique source locations. Obsidian 1.13.4 exposes Frontmatter scalar/list wikilinks and Markdown links in `frontmatterLinks`, but their `position` is `null`; it exposes a reference definition in `referenceLinks` with a position but without `original` or display/title style. Unknown YAML shapes and unpaired or multiply defined reference labels remain unsupported.

The installed fixture also proves that a filename containing a literal `#` is not graph-resolved in wikilink, embed, Frontmatter, or Markdown forms; `%23` did not make it graph-resolved either. Even though a direct `getFirstLinkpathDest` call with the full filename can return the attachment, actual `resolvedLinks` classifies those references as unresolved after splitting at `#`. Such targets are therefore `unsupported_reference_form` in this runtime profile; a renderer must not guess an escaping workaround.

## Resolution contract

For every detected reference:

1. Freeze the source note's exact UTF-8 bytes and Content Version.
2. Parse one registered token into a `ReferenceIntent`, separating raw file linkpath, decoded lookup linkpath, fragment, alias/display/title, wrapper, raw spelling, host `Pos`, and independently verified byte span.
3. Enumerate canonical candidates under the profile's installed-runtime fixture results. Do not use normalization or basename preference as identity.
4. Require exactly one candidate. A zero/many set returns deterministic evidence and rejects preflight.
5. Call `getFirstLinkpathDest` with only the decoded file linkpath and source path. Require the same canonical `TFile.path`; host disagreement rejects.
6. Validate the fragment against the frozen target. One matching heading or block ID passes. Duplicate headings reject. A bridge section-read `occurrence` is never renderable link syntax.
7. Render only the destination component. Apply independently verified UTF-8 byte spans in descending order and host-validate every replacement before admitting the Change Set.

## Style contract

A profile's style template captures raw prefix and suffix bytes around the destination. It preserves:

- link versus embed syntax;
- label, alias, dimensions and title, including title quote style;
- angle brackets, extension elision, percent escaping, and valid relative/Vault-relative form;
- profile-specific space spelling: wikilinks and angle-wrapped Markdown destinations retain literal spaces, while unwrapped Markdown destinations encode spaces as `%20`; unwrapped destinations containing literal spaces reject rather than being normalized or guessed;
- heading/block fragment spelling;
- all surrounding Markdown/YAML bytes, BOM, Unicode spelling, and newline form.

When the previous path style cannot uniquely name the moved target, the renderer may choose only the smallest fallback proven by the same runtime corpus. If no proven fallback exists, return `unsupported_reference_form`; do not silently pick a host winner.

## Deterministic rejection taxonomy

- `profile_not_registered`
- `runtime_profile_mismatch`
- `unsupported_reference_form`
- `source_span_not_unique`
- `target_not_found`
- `ambiguous_target` with sorted canonical candidates
- `host_candidate_disagreement`
- `ambiguous_heading_fragment`
- `fragment_not_found`
- `frontmatter_shape_unsupported`
- `reference_definition_unpaired`
- `rendered_target_not_unique`
- `post_render_host_disagreement`

## Attachment moves

Attachments use the same reference profiles and renderer rules. The target identity is `{canonicalPath, sha256}` rather than note Content Version. `copy_attachment` does not rewrite references. `move_attachment` includes every uniquely resolved registered source in its derived rewrite closure; one ambiguous, unsupported, unlocatable, or post-validation-failing covered reference rejects the entire Change Set.

## Explicit non-guarantees

The MVP does not rewrite plain prose, code fences, HTML attributes, query/plugin syntax, external URLs, arbitrary YAML strings, or any cache/reference category absent from the registered manifest. It does not rely on `FileManager.renameFile()` or the Primary Operator's automatic-link-update preference. It does not claim that Obsidian's selected best destination proves absence of ambiguity.

## Acceptance gate

The profile set is development-ready only when `runtime-observation.json` records the installed version and passes fixtures for:

- CJK, spaces, `.md` elision, angle destinations, titles and aliases; `%20`/`%23` forms must match the graph rather than merely direct lookup;
- unique, missing, duplicate-basename, root-relative and source-relative candidates;
- unique headings, duplicate headings and block IDs;
- all six matrix rows, both note moves and attachment moves;
- automatic-link-update preference enabled and disabled with identical explicit derived rewrites;
- byte-identical preservation outside each destination span.

The prototype observation is evidence about one installed runtime, not portable truth. The final product should ship its fixture corpus and registration manifest but not this TUI or its deliberately incomplete parser.

# PROTOTYPE — registered reference grammar profiles

This throwaway logic prototype answers one question: can a small, versioned manifest represent the installed Obsidian runtime's reference categories, preserve each token's style during a destination rewrite, and reject ambiguity or unsupported syntax deterministically before any Vault mutation?

It is not production parsing code. The pure module exposes the proposed contract; the terminal shell lets a reviewer walk fixtures and inspect the complete parse, resolution, and render state. Runtime observations are captured separately so guessed behavior never becomes a registered guarantee.

## Run

```powershell
node prototypes/registered-reference-profiles/tui.mjs
```

The TUI is dependency-free. Use `n`/`p` to walk cases, `m` to simulate a target move, `r` to toggle runtime evidence, and `q` to quit.

## Installed-runtime probe

The companion probe targets the running `ThinkFlywheelVault` through the official Obsidian CLI. It creates and then removes only `_wayfinder-reference-profile-prototype/`.

```powershell
pwsh -File prototypes/registered-reference-profiles/probe-obsidian.ps1
```

The probe writes `runtime-observation.json`, including the installed Obsidian version, raw fixtures, `CachedMetadata` categories, `getFirstLinkpathDest` results, and move observations. Review that file before promoting a profile from `observed` to `registered`.

## Proposed decision

- A profile identity is `{profileId, profileVersion, runtimeVersion, fixtureCorpusHash}`. A runtime upgrade or fixture change requires revalidation.
- Registration is category-specific. The MVP registers only forms proven visible in the installed runtime's `links`, `embeds`, `frontmatterLinks`, or `referenceLinks` cache categories.
- A `ReferenceIntent` separates wrapper/style bytes from the destination component and fragment. Rendering replaces only the destination component. It does not normalize existing references before a move: wikilinks and angle-wrapped Markdown retain literal spaces, unwrapped Markdown renders spaces as `%20`, and an unwrapped destination containing literal spaces rejects rather than guessing the user's intent.
- Resolution succeeds only when bridge candidate enumeration yields exactly one canonical path and that path agrees with `getFirstLinkpathDest(fileLinkpath, sourcePath)`.
- Zero candidates, multiple candidates, host disagreement, duplicate heading fragments, unknown Frontmatter scalar shapes, and unobserved reference-definition behavior reject preflight.
- File moves preserve valid heading/block fragments but never invent an `occurrence` fragment. Attachment moves use the same reference profiles; attachment identity is path plus SHA-256 rather than Content Version.
- Automatic Obsidian rename behavior is not part of a profile and must be disabled as an implementation dependency. Every rewrite is an explicit derived Change Set operation over independently verified UTF-8 byte spans.

See `DECISION.md` for the manifest and renderer matrix suggested by the prototype.

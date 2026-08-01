# Raw-byte source-span prototype

> **PROTOTYPE — throw this branch away.** This is diagnostic code, not the Vault Operation Bridge implementation.

This prototype answers whether the installed Obsidian desktop runtime can:

1. preserve exact Markdown bytes through its public adapter binary APIs; and
2. use `MetadataCache` source locations only as locators, converting their UTF-16 offsets to independently byte-verified UTF-8 spans before a rewrite.

The fixture combines a UTF-8 BOM, CRLF, CJK, astral emoji, and two identical wiki-link spellings. The prototype rewrites only the second occurrence and verifies that the exact prefix, suffix, first occurrence, BOM, and newline form remain byte-identical.

## Run

From PowerShell with Obsidian open on `ThinkFlywheelVault`:

```powershell
./prototypes/raw-byte-source-span-prototype/run.ps1
```

The runner refuses to overwrite an existing fixture directory. It runs the diagnostic inside Obsidian's renderer context, captures the output in `last-result.txt`, sends the two known fixture files to Obsidian's recoverable trash, and removes the fixture folder only after confirming it is empty.

## Validated boundary

- `adapter.readBinary`, `adapter.writeBinary`, and `Vault.createBinary` are present in the installed desktop runtime and preserve the fixture bytes exactly.
- `Vault.read()` strips the UTF-8 BOM, so it is not an Exact Read source. Exact Reads and rewrite preimages must come from `readBinary`.
- `MetadataCache` offsets locate tokens in host text coordinates; they are not byte offsets. The adapter must account for BOM/text-layer differences, convert candidate UTF-16 positions to UTF-8 offsets, and accept a span only after the raw bytes equal the cached token spelling.
- A rewrite must fail closed unless the host position produces exactly one byte-verified candidate. Repeated link text is safe because each cache entry's own position is verified rather than resolved through a global text search.

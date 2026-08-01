# Installed transport probe results

**Measured:** 2026-08-01 on Windows 11, Claude Code 2.1.220, Obsidian 1.12.4 desktop with Electron 39.6.0 and Node v22.22.0, against the open ThinkFlywheel Vault. The probe was loaded only in the current Obsidian process and was never persistently enabled.

## Decision

Publish these initial installed-runtime constants:

| Constant | Value | Reason |
| --- | ---: | --- |
| `max_transport_response_bytes` | **262,144 bytes (256 KiB)** | Fully inline and marker-complete in Claude Code; below the 500,000-character per-tool hard ceiling with enough envelope headroom; one page can carry the Vault's largest current note (163,904 B). |
| `max_logical_exact_read_bytes` | **1,048,576 bytes (1 MiB)** | At most four 256 KiB transport pages; accommodates at least six current maximum-size notes or about 35 p95 notes while bounding frozen snapshot retention and round trips. |
| Default automatic grouping | **No client grouping. Server rejects over-limit ordered Exact Read batches atomically and suggests deterministic contiguous groups, each ≤1 MiB.** | Claude Code documents no transport-level automatic pagination/grouping. Grouping must remain a Vault Operation Bridge semantic so duplicate indices, order, and Content Versions stay fixed. |
| Continuation lifetime | **15 minutes sliding from issuance/replacement; single-use; release immediately on consume, expiry, client disconnect/session teardown, or snapshot loss.** | Real model-driven steps were observed about 64 seconds apart even in a tiny lifecycle probe. Five seconds and one minute are therefore unsafe. Fifteen minutes clears ordinary inference/tool latency while bounding retention. Add a per-client active-token/retained-byte quota; do not retain the whole Vault. |

These are product operating constants, not claims of Claude Code's raw HTTP hard limits. Expose them through bridge diagnostics and make them installation-configurable within guarded ranges so they can be re-baselined after Claude Code/Obsidian upgrades.

## Measured payload behavior

`probe_payload` returned deterministic UTF-8 text with `BEGIN:<bytes>` / `END:<bytes>` markers and a SHA-256 digest. The server recorded compact JSON-RPC response bytes; each Claude Code run used a fresh process and reported marker visibility without reproducing the body.

| Requested payload | Server JSON-RPC bytes | Claude Code behavior | Integrity |
| ---: | ---: | --- | --- |
| 64 KiB | 131,472 B¹ | Inline | Both markers + SHA-256 visible |
| 128 KiB | 131,355 B | Inline | Both markers + SHA-256 visible |
| 256 KiB | 262,427 B | Inline | Both markers + SHA-256 visible |
| 384 KiB | 393,499 B | Inline | Both markers + SHA-256 visible |
| 480 KiB | 491,803 B | Inline | Both markers + SHA-256 visible |
| 512 KiB | 524,571 B | Persisted to a `tool-results/*.txt` file and replaced by a file reference | Complete markers + SHA-256 recoverable from persisted result |
| 1 MiB | 1,048,861 B | Persisted to a `tool-results/*.txt` file and replaced by a file reference | Complete markers + SHA-256 recoverable from persisted result |

¹ The first 64 KiB run accidentally duplicated the payload in both MCP `content` and `structuredContent`; later runs used only `structuredContent`. It proves reception but is excluded from envelope sizing.

The transition is consistent with Claude Code's documented `_meta.anthropic/maxResultSizeChars` hard ceiling of 500,000 characters: 480 KiB is under it, 512 KiB is over it. The 1 MiB response was received intact before offloading, so the observed transition is context/result management, not HTTP truncation.

## Timeout behavior

With per-server MCP `timeout: 5000`:

- `delay_ms: 4000` succeeded;
- `delay_ms: 6000` failed as `MCP server "vault_transport_probe" tool "probe_payload" timed out after 5s`;
- server observation showed Claude Code sent `notifications/cancelled` at the five-second boundary and the server's late response arrived afterward;
- the instructed model did not retry.

Use the documented normal per-server timeout of 600,000 ms (10 minutes) for the bridge. It is a hard wall-clock limit; progress notifications prevent idle timeout but do not extend it. The read/search latency target remains under 200 ms and is not relaxed by this failure ceiling.

## Vault pressure calibration

Read-only Obsidian application inspection returned:

- 916 Markdown notes;
- 7,107,138 aggregate Markdown bytes;
- 2,630 B median;
- 29,316 B p95;
- 163,904 B maximum;
- zero notes over 256 KiB or 1 MiB.

A 1 MiB logical batch is therefore generous for normal work but still bounded. A 15-minute continuation must retain only the frozen bytes required by active results, with quotas. Suggested initial quotas: at most 8 active continuation chains and 8 MiB frozen bytes per authenticated client, oldest-expiring-first rejection of new issuance (never eviction of a live token into ambiguous state).

## Client grouping and continuation observations

Claude Code's official MCP docs advise server authors to paginate and do not describe automatic result pagination, cursor following, batch splitting, or result merging. The model can choose to call a continuation tool, but that is an ordinary model tool call, not transparent client grouping.

A small model-driven lifecycle probe produced approximately 64-second gaps between synthetic continuation steps. It also demonstrated why lifecycle measurement cannot use a tiny TTL: even a trivial next action can wait through inference and tool scheduling. A later patched-handler run timed out and is excluded from semantic evidence; it does not weaken the measured inter-step gap or the 15-minute conservative default.

## Official Claude Code controls relevant to the specification

From <https://code.claude.com/docs/en/mcp>:

- warning above 10,000 MCP output tokens;
- default maximum 25,000 MCP output tokens, configurable with `MAX_MCP_OUTPUT_TOKENS`;
- oversized unannotated text results are persisted and replaced by a file reference;
- `_meta.anthropic/maxResultSizeChars` can raise one tool threshold up to 500,000 characters;
- per-server `timeout` overrides `MCP_TOOL_TIMEOUT` and is a hard wall-clock limit;
- HTTP first-byte timeout and idle timeout are separate;
- HTTP/SSE connection health is automatically retried, but in-flight side-effect replay semantics are not documented.

The product must therefore paginate before offloading, not rely on file references as its normal Exact Read path, and retain Submission-Key idempotency for writes independently of HTTP reconnection.

## Re-baseline triggers

Repeat this probe after any of:

- Claude Code upgrade;
- Obsidian/Electron major upgrade;
- MCP SDK/protocol-version change;
- materially larger Vault corpus;
- observed offloading below 256 KiB, read latency regression, continuation expiry during normal work, or snapshot-retention pressure.
